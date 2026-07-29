import { createHash } from "node:crypto";
import { lstat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createSandboxedBashOperations, type SandboxedBashOperations } from "./sandbox.ts";

const DEFAULT_OUTPUT_LIMIT_BYTES = 1_000_000;
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_WARMUPS = 1;
const DEFAULT_SAMPLES = 3;
const RESULT_PREFIX = "ISO_RESULT ";
const RESULT_PREFIX_BYTES = Buffer.from(RESULT_PREFIX);

export interface EvaluatorResult {
	score: number;
	metrics: Record<string, number>;
	summary?: string;
	valid: boolean;
	constraints: Record<string, boolean>;
}

export interface EvaluatorSample extends EvaluatorResult {
	trialId: string;
	phase: "warmup" | "sample";
	sampleIndex: number;
	seed: number;
	durationMs: number;
	stdout: string;
	stderr: string;
	stdoutBytes: number;
	stderrBytes: number;
	stdoutTruncated: boolean;
	stderrTruncated: boolean;
}

export interface ScoreAggregate {
	mean: number;
	median: number;
	stddev: number;
	min: number;
	max: number;
}

export interface EvaluatorAggregate {
	score: ScoreAggregate;
	metrics: Record<string, number>;
}

export interface Evaluation {
	/** The measured mean score used by ISO's paired statistical gate. */
	score: number;
	/** Median values for each reported secondary metric. */
	metrics: Record<string, number>;
	summary?: string;
	stdout?: string;
	stderr?: string;
	valid: boolean;
	constraints: Record<string, boolean>;
	aggregate: EvaluatorAggregate;
	samples: EvaluatorSample[];
	warmups: EvaluatorSample[];
	durationMs: number;
}

export interface RunEvaluatorOptions {
	/** Mutable live repository, hidden from evaluator subprocesses. */
	repoRoot: string;
	/**
	 * Root of the detached source-pinned control checkout. Defaults to the
	 * nearest ancestor of controlCwd with a real .git marker, or controlCwd.
	 */
	controlRoot?: string;
	/** Directory in which the trusted evaluator command itself runs. */
	controlCwd: string;
	/** Candidate checkout exposed to the evaluator as ISO_EXPERIMENT_DIR. */
	experimentDir: string;
	/**
	 * Exact content-addressed frozen evaluator file that may cross the hidden
	 * live-repository boundary.
	 */
	readOnlyPaths?: string[];
	warmups?: number;
	samples?: number;
	/** Absolute index of the first measured sample when one logical run is split across fresh sandboxes. */
	sampleIndexOffset?: number;
	timeoutMs?: number;
	outputLimitBytes?: number;
	/** Stable ID shared by incumbent and candidate evaluations for paired evaluator seeds. */
	trialId?: string;
	signal?: AbortSignal;
}

export class EvaluatorContractError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvaluatorContractError";
	}
}

export class EvaluatorProcessError extends Error {
	readonly exitCode: number | null;
	readonly exitSignal: NodeJS.Signals | null;

	constructor(message: string, exitCode: number | null, exitSignal: NodeJS.Signals | null) {
		super(message);
		this.name = "EvaluatorProcessError";
		this.exitCode = exitCode;
		this.exitSignal = exitSignal;
	}
}

export class EvaluatorTimeoutError extends Error {
	readonly timeoutMs: number;

	constructor(timeoutMs: number) {
		super(`Evaluator timed out after ${timeoutMs}ms.`);
		this.name = "EvaluatorTimeoutError";
		this.timeoutMs = timeoutMs;
	}
}

export class EvaluatorAbortError extends Error {
	constructor() {
		super("Evaluator was aborted.");
		this.name = "AbortError";
	}
}

class BoundedOutput {
	readonly limitBytes: number;
	private value = Buffer.alloc(0);
	private seenBytes = 0;
	private lineState: "leading" | "prefix" | "result" | "other" = "leading";
	private prefixIndex = 0;
	private resultLineCount = 0;
	private resultValue = Buffer.alloc(0);
	private resultBytes = 0;
	private resultOversized = false;

	constructor(limitBytes: number) {
		this.limitBytes = limitBytes;
	}

	append(chunk: Uint8Array | string): void {
		const next = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
		this.scanResultLines(next);
		this.seenBytes += next.byteLength;
		if (next.byteLength >= this.limitBytes) {
			this.value = next.subarray(next.byteLength - this.limitBytes);
			return;
		}
		const overflow = this.value.byteLength + next.byteLength - this.limitBytes;
		this.value =
			overflow > 0 ? Buffer.concat([this.value.subarray(overflow), next]) : Buffer.concat([this.value, next]);
	}

	get bytes(): number {
		return this.seenBytes;
	}

	get truncated(): boolean {
		return this.seenBytes > this.limitBytes;
	}

	toString(): string {
		return this.value.toString("utf8");
	}

	resultLine(): string {
		if (this.resultLineCount === 0) {
			throw new EvaluatorContractError(
				`Evaluator produced no ${RESULT_PREFIX.trim()} line. Expected ${RESULT_PREFIX}{"score": number}.`,
			);
		}
		if (this.resultLineCount !== 1) {
			throw new EvaluatorContractError(
				`Evaluator produced ${this.resultLineCount} ${RESULT_PREFIX.trim()} lines; exactly one trusted result is required.`,
			);
		}
		if (this.resultOversized) {
			throw new EvaluatorContractError(
				`Evaluator ${RESULT_PREFIX.trim()} line exceeded the ${this.limitBytes}-byte output capture limit.`,
			);
		}
		return this.resultValue.subarray(0, this.resultBytes).toString("utf8").trim();
	}

	private scanResultLines(chunk: Buffer): void {
		let offset = 0;
		while (offset < chunk.byteLength) {
			if (this.lineState === "other") {
				const newline = chunk.indexOf(0x0a, offset);
				if (newline === -1) {
					return;
				}
				this.resetLine();
				offset = newline + 1;
				continue;
			}

			if (this.lineState === "result") {
				const newline = chunk.indexOf(0x0a, offset);
				const end = newline === -1 ? chunk.byteLength : newline;
				if (this.resultLineCount === 1) {
					this.appendResultBytes(chunk.subarray(offset, end));
				}
				if (newline === -1) {
					return;
				}
				this.resetLine();
				offset = newline + 1;
				continue;
			}

			const byte = chunk[offset];
			if (byte === 0x0a) {
				this.resetLine();
				offset += 1;
				continue;
			}
			if (this.lineState === "leading") {
				if (isAsciiWhitespace(byte)) {
					offset += 1;
					continue;
				}
				if (byte === RESULT_PREFIX_BYTES[0]) {
					this.lineState = "prefix";
					this.prefixIndex = 1;
				} else {
					this.lineState = "other";
				}
				offset += 1;
				continue;
			}

			if (byte !== RESULT_PREFIX_BYTES[this.prefixIndex]) {
				this.lineState = "other";
				offset += 1;
				continue;
			}
			this.prefixIndex += 1;
			offset += 1;
			if (this.prefixIndex === RESULT_PREFIX_BYTES.byteLength) {
				this.resultLineCount += 1;
				this.lineState = "result";
				if (this.resultLineCount === 1) {
					this.appendResultBytes(RESULT_PREFIX_BYTES);
				}
			}
		}
	}

	private appendResultBytes(bytes: Buffer): void {
		if (bytes.byteLength === 0 || this.resultOversized) {
			return;
		}
		const remaining = this.limitBytes - this.resultBytes;
		const copyLength = Math.min(bytes.byteLength, remaining);
		const requiredBytes = this.resultBytes + copyLength;
		if (this.resultValue.byteLength < requiredBytes) {
			const capacity = Math.min(
				this.limitBytes,
				Math.max(requiredBytes, RESULT_PREFIX_BYTES.byteLength, this.resultValue.byteLength * 2),
			);
			const expanded = Buffer.allocUnsafe(capacity);
			this.resultValue.copy(expanded, 0, 0, this.resultBytes);
			this.resultValue = expanded;
		}
		bytes.copy(this.resultValue, this.resultBytes, 0, copyLength);
		this.resultBytes = requiredBytes;
		if (copyLength !== bytes.byteLength) {
			this.resultOversized = true;
		}
	}

	private resetLine(): void {
		this.lineState = "leading";
		this.prefixIndex = 0;
	}
}

function isAsciiWhitespace(byte: number): boolean {
	return byte === 0x20 || (byte >= 0x09 && byte <= 0x0d);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finiteNumber(value: unknown, field: string): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		throw new EvaluatorContractError(`${field} must be a finite number.`);
	}
	return value;
}

function parseNumericRecord(value: unknown, field: string): Record<string, number> {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		throw new EvaluatorContractError(`${field} must be an object containing finite numeric values.`);
	}
	const parsed: Record<string, number> = {};
	for (const [key, entry] of Object.entries(value)) {
		parsed[key] = finiteNumber(entry, `${field}.${key}`);
	}
	return parsed;
}

function parseBooleanRecord(value: unknown, field: string): Record<string, boolean> {
	if (value === undefined) {
		return {};
	}
	if (!isRecord(value)) {
		throw new EvaluatorContractError(`${field} must be an object containing boolean values.`);
	}
	const parsed: Record<string, boolean> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry !== "boolean") {
			throw new EvaluatorContractError(`${field}.${key} must be a boolean.`);
		}
		parsed[key] = entry;
	}
	return parsed;
}

function parseEvaluatorResultLine(resultLine: string): EvaluatorResult {
	let parsed: unknown;
	try {
		parsed = JSON.parse(resultLine.slice(RESULT_PREFIX.length));
	} catch {
		throw new EvaluatorContractError(
			`Evaluator result was not valid JSON. Expected ${RESULT_PREFIX}{"score": number}.`,
		);
	}
	if (!isRecord(parsed)) {
		throw new EvaluatorContractError("Evaluator result must be a JSON object.");
	}
	if (parsed.summary !== undefined && typeof parsed.summary !== "string") {
		throw new EvaluatorContractError("summary must be a string.");
	}
	if (parsed.valid !== undefined && typeof parsed.valid !== "boolean") {
		throw new EvaluatorContractError("valid must be a boolean.");
	}

	return {
		score: finiteNumber(parsed.score, "score"),
		metrics: parseNumericRecord(parsed.metrics, "metrics"),
		summary: parsed.summary,
		valid: parsed.valid ?? true,
		constraints: parseBooleanRecord(parsed.constraints, "constraints"),
	};
}

export function parseEvaluatorOutput(stdout: string): EvaluatorResult {
	const resultLines = stdout
		.split(/\r?\n/u)
		.map((line) => line.trim())
		.filter((line) => line.startsWith(RESULT_PREFIX));
	if (resultLines.length === 0) {
		throw new EvaluatorContractError(
			`Evaluator produced no ${RESULT_PREFIX.trim()} line. Expected ${RESULT_PREFIX}{"score": number}.`,
		);
	}
	if (resultLines.length !== 1) {
		throw new EvaluatorContractError(
			`Evaluator produced ${resultLines.length} ${RESULT_PREFIX.trim()} lines; exactly one trusted result is required.`,
		);
	}
	return parseEvaluatorResultLine(resultLines[0]);
}

function median(values: readonly number[]): number {
	if (values.length === 0) {
		throw new Error("Cannot calculate a median without values.");
	}
	const sorted = [...values].sort((left, right) => left - right);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

function assertStableResultShape(samples: readonly EvaluatorSample[]): void {
	const expectedMetrics = Object.keys(samples[0]?.metrics ?? {}).sort();
	const expectedConstraints = Object.keys(samples[0]?.constraints ?? {}).sort();
	for (let index = 1; index < samples.length; index += 1) {
		const metricKeys = Object.keys(samples[index].metrics).sort();
		const constraintKeys = Object.keys(samples[index].constraints).sort();
		if (JSON.stringify(metricKeys) !== JSON.stringify(expectedMetrics)) {
			throw new EvaluatorContractError(
				`Evaluator sample ${index + 1} changed metric keys; expected ${expectedMetrics.join(", ") || "(none)"}.`,
			);
		}
		if (JSON.stringify(constraintKeys) !== JSON.stringify(expectedConstraints)) {
			throw new EvaluatorContractError(
				`Evaluator sample ${index + 1} changed constraint keys; expected ${expectedConstraints.join(", ") || "(none)"}.`,
			);
		}
	}
}

export function aggregateEvaluationSamples(samples: readonly EvaluatorSample[]): EvaluatorAggregate {
	if (samples.length === 0) {
		throw new Error("At least one measured evaluator sample is required.");
	}
	assertStableResultShape(samples);

	const scores = samples.map((sample) => sample.score);
	const mean = scores.reduce((total, score) => total + score, 0) / scores.length;
	const variance =
		scores.length > 1 ? scores.reduce((total, score) => total + (score - mean) ** 2, 0) / (scores.length - 1) : 0;
	const metricValues = new Map<string, number[]>();
	for (const sample of samples) {
		for (const [name, value] of Object.entries(sample.metrics)) {
			const values = metricValues.get(name) ?? [];
			values.push(value);
			metricValues.set(name, values);
		}
	}
	const metrics: Record<string, number> = {};
	for (const [name, values] of metricValues) {
		metrics[name] = median(values);
	}

	return {
		score: {
			mean,
			median: median(scores),
			stddev: Math.sqrt(variance),
			min: Math.min(...scores),
			max: Math.max(...scores),
		},
		metrics,
	};
}

function validateInteger(value: number, name: string, minimum: number): number {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new RangeError(`${name} must be a safe integer greater than or equal to ${minimum}.`);
	}
	return value;
}

function sampleSeed(trialId: string, phase: "warmup" | "sample", index: number): number {
	return createHash("sha256").update(`${trialId}\0${phase}\0${index}`).digest().readUInt32BE(0);
}

async function runSample(
	command: string,
	options: Required<Pick<RunEvaluatorOptions, "controlCwd" | "experimentDir" | "timeoutMs" | "outputLimitBytes">> &
		Pick<RunEvaluatorOptions, "signal"> & {
			index: number;
			operations: SandboxedBashOperations;
			phase: "warmup" | "sample";
			trialId: string;
		},
): Promise<EvaluatorSample> {
	if (options.signal?.aborted) {
		throw new EvaluatorAbortError();
	}

	const startedAt = performance.now();
	const output = new BoundedOutput(options.outputLimitBytes);
	const controller = new AbortController();
	let terminalError: EvaluatorTimeoutError | EvaluatorAbortError | undefined;
	const abort = (): void => {
		terminalError ??= new EvaluatorAbortError();
		controller.abort();
	};
	const timeout = setTimeout(() => {
		terminalError ??= new EvaluatorTimeoutError(options.timeoutMs);
		controller.abort();
	}, options.timeoutMs);
	timeout.unref();
	options.signal?.addEventListener("abort", abort, { once: true });
	const seed = sampleSeed(options.trialId, options.phase, options.index);
	const sampleCommand = `ISO_SAMPLE_INDEX=${options.index} ISO_SEED=${seed} ${command}`;
	let exitCode: number | null;
	try {
		({ exitCode } = await options.operations.exec(sampleCommand, options.controlCwd, {
			onData: (chunk) => output.append(chunk),
			signal: controller.signal,
		}));
	} catch (error) {
		if (terminalError !== undefined) {
			throw terminalError;
		}
		throw error;
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abort);
	}
	if (terminalError !== undefined) {
		throw terminalError;
	}
	const stdoutValue = output.toString();
	if (exitCode !== 0) {
		const status = exitCode === null ? "a signal" : `code ${exitCode}`;
		throw new EvaluatorProcessError(
			`Evaluator exited with ${status}${stdoutValue.trim() ? `: ${stdoutValue.trim()}` : "."}`,
			exitCode,
			null,
		);
	}
	const parsed = parseEvaluatorResultLine(output.resultLine());
	return {
		...parsed,
		trialId: options.trialId,
		phase: options.phase,
		sampleIndex: options.index,
		seed,
		durationMs: performance.now() - startedAt,
		stdout: stdoutValue,
		stderr: "",
		stdoutBytes: output.bytes,
		stderrBytes: 0,
		stdoutTruncated: output.truncated,
		stderrTruncated: false,
	};
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function evaluatorControlRoot(options: RunEvaluatorOptions): Promise<string> {
	if (options.controlRoot !== undefined) {
		return options.controlRoot;
	}
	let current = resolve(options.controlCwd);
	for (;;) {
		try {
			const marker = await lstat(join(current, ".git"));
			if (marker.isSymbolicLink() || (!marker.isFile() && !marker.isDirectory())) {
				throw new Error(`Evaluator control checkout has an unsafe .git marker: ${join(current, ".git")}`);
			}
			return current;
		} catch (error) {
			if (!isErrorCode(error, "ENOENT")) {
				throw error;
			}
		}
		const parent = dirname(current);
		if (parent === current) {
			return options.controlCwd;
		}
		current = parent;
	}
}

export async function runEvaluator(command: string, options: RunEvaluatorOptions): Promise<Evaluation> {
	if (command.trim() === "") {
		throw new Error("Evaluator command must not be empty.");
	}
	if (
		options.repoRoot.trim() === "" ||
		options.controlRoot?.trim() === "" ||
		options.controlCwd.trim() === "" ||
		options.experimentDir.trim() === ""
	) {
		throw new Error("Evaluator repoRoot, controlRoot, controlCwd and experimentDir must not be empty.");
	}
	const warmupCount = validateInteger(options.warmups ?? DEFAULT_WARMUPS, "warmups", 0);
	const sampleCount = validateInteger(options.samples ?? DEFAULT_SAMPLES, "samples", 1);
	const sampleIndexOffset = validateInteger(options.sampleIndexOffset ?? 0, "sampleIndexOffset", 0);
	const timeoutMs = validateInteger(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, "timeoutMs", 1);
	const outputLimitBytes = validateInteger(
		options.outputLimitBytes ?? DEFAULT_OUTPUT_LIMIT_BYTES,
		"outputLimitBytes",
		1,
	);
	const sampleOptions = {
		controlCwd: options.controlCwd,
		experimentDir: options.experimentDir,
		timeoutMs,
		outputLimitBytes,
		signal: options.signal,
	};
	const startedAt = performance.now();
	const warmups: EvaluatorSample[] = [];
	const samples: EvaluatorSample[] = [];
	const repoRoot = options.repoRoot;
	const controlRoot = await evaluatorControlRoot(options);
	const operations = await createSandboxedBashOperations({
		cwd: options.controlCwd,
		repoRoot,
		sourceRoot: controlRoot,
		writablePaths: [options.experimentDir],
		readOnlyPaths: options.readOnlyPaths,
		denyReadPaths: [
			join(repoRoot, ".iso", "iso.db"),
			join(repoRoot, ".iso", "iso.db-shm"),
			join(repoRoot, ".iso", "iso.db-wal"),
			join(repoRoot, ".iso", "kernel.sock"),
			join(repoRoot, ".iso", "kernel.pid"),
		],
		environment: {
			ISO_EXPERIMENT_DIR: options.experimentDir,
			ISO_TRIAL_ID: options.trialId ?? "standalone",
		},
	});
	try {
		for (let index = 0; index < warmupCount; index++) {
			warmups.push(
				await runSample(command, {
					...sampleOptions,
					index: sampleIndexOffset + index,
					operations,
					phase: "warmup",
					trialId: options.trialId ?? "standalone",
				}),
			);
		}
		for (let index = 0; index < sampleCount; index++) {
			samples.push(
				await runSample(command, {
					...sampleOptions,
					index: sampleIndexOffset + index,
					operations,
					phase: "sample",
					trialId: options.trialId ?? "standalone",
				}),
			);
		}
	} finally {
		await operations.dispose();
	}

	const aggregate = aggregateEvaluationSamples(samples);
	const constraints: Record<string, boolean> = {};
	for (const sample of samples) {
		for (const [name, passed] of Object.entries(sample.constraints)) {
			const previous = constraints[name] ?? true;
			constraints[name] = previous && passed;
		}
	}
	const lastSample = samples.at(-1);
	return {
		score: aggregate.score.mean,
		metrics: aggregate.metrics,
		summary: [...samples].reverse().find((sample) => sample.summary !== undefined)?.summary,
		stdout: lastSample?.stdout,
		stderr: lastSample?.stderr,
		valid:
			samples.every((sample) => sample.valid) &&
			samples.every((sample) => Object.values(sample.constraints).every(Boolean)),
		constraints,
		aggregate,
		samples,
		warmups,
		durationMs: performance.now() - startedAt,
	};
}
