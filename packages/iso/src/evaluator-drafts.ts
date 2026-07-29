import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import {
	type FileHandle,
	link,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import shellQuote from "shell-quote";
import { type Evaluation, runEvaluator } from "./evaluator.ts";

const EVALUATOR_STORE = join(".iso", "evaluators");
const DRAFT_DIRECTORY = "drafts";
const OBJECT_DIRECTORY = "objects";
const FROZEN_DIRECTORY = "frozen";
const LOCK_DIRECTORY = ".locks";
const DEFAULT_MAX_SOURCE_BYTES = 1024 * 1024;
const HARD_MAX_SOURCE_BYTES = 4 * 1024 * 1024;
const DEFAULT_VALIDATION_TIMEOUT_MS = 5_000;
const HARD_MAX_VALIDATION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_VALIDATION_OUTPUT_BYTES = 64 * 1024;
const HARD_MAX_VALIDATION_OUTPUT_BYTES = 256 * 1024;
const EVALUATOR_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/u;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const INTERNAL_VALIDATION_FILE_PATTERN = /^\.validate-[a-f0-9]{32}\.mjs$/u;
const DRAFT_LOCK_TOKEN_PATTERN = /^[a-f0-9]{32}$/u;
const DRAFT_LOCK_RECORD_MAX_BYTES = 4 * 1024;
const DRAFT_LOCK_VERSION = 1;

export class EvaluatorDraftStoreError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "EvaluatorDraftStoreError";
	}
}

export interface EvaluatorDraftValidationOptions {
	/** Trusted repository whose source is readable but never writable by the evaluator. */
	repoRoot: string;
	/** Optional read-only detached source directory used as the evaluator's actual working directory. */
	controlCwd?: string;
	/** Explicit disposable candidate directory exposed as ISO_EXPERIMENT_DIR. */
	candidateCwd: string;
	/** Complete Node ESM evaluator source. */
	source: string;
	maxSourceBytes?: number;
	/** Per-sample evaluator execution timeout; syntax parsing has its own fixed 5s bound. */
	timeoutMs?: number;
	outputLimitBytes?: number;
}

export interface EvaluatorDraftValidation {
	digest: string;
	sourceBytes: number;
	evaluation: Evaluation;
}

export interface StoreEvaluatorDraftOptions extends EvaluatorDraftValidationOptions {
	name: string;
}

export interface StoredEvaluatorDraft extends EvaluatorDraftValidation {
	name: string;
	/** Repository-relative mutable draft path. */
	draftPath: string;
	/** Repository-relative immutable content-addressed source path. */
	objectPath: string;
}

export interface FreezeEvaluatorDraftOptions {
	repoRoot: string;
	controlCwd?: string;
	candidateCwd: string;
	name: string;
	/** Digest returned by storeEvaluatorDraft; prevents freezing a replaced draft by accident. */
	digest: string;
	maxSourceBytes?: number;
	timeoutMs?: number;
	outputLimitBytes?: number;
}

export interface FrozenEvaluatorDraft extends StoredEvaluatorDraft {
	/** Repository-relative immutable named evaluator path. */
	frozenPath: string;
}

interface EvaluatorStoreLayout {
	repoRoot: string;
	root: string;
	drafts: string;
	objects: string;
	frozen: string;
	locks: string;
}

interface ValidationLimits {
	maxSourceBytes: number;
	timeoutMs: number;
	outputLimitBytes: number;
}

interface DraftLockOwner {
	version: typeof DRAFT_LOCK_VERSION;
	name: string;
	pid: number;
	processStart: string;
	token: string;
}

function isErrorCode(error: unknown, code: string): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function expectedUserId(): number {
	const userId = process.getuid?.();
	if (userId === undefined) {
		throw new EvaluatorDraftStoreError("Evaluator draft storage requires POSIX ownership and mode checks.");
	}
	return userId;
}

function assertOwned(metadata: Stats, label: string): void {
	if (metadata.uid !== expectedUserId()) {
		throw new EvaluatorDraftStoreError(`${label} is not owned by the current user.`);
	}
}

function sameIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileState(left: Stats, right: Stats): boolean {
	return (
		sameIdentity(left, right) &&
		left.size === right.size &&
		left.mode === right.mode &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.nlink === right.nlink
	);
}

function isContainedPath(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

function evaluatorName(name: string): string {
	if (!EVALUATOR_NAME_PATTERN.test(name)) {
		throw new EvaluatorDraftStoreError(
			"Evaluator name must start with a lowercase letter and contain at most 64 lowercase letters, digits, '-' or '_'.",
		);
	}
	return name;
}

function evaluatorDigest(digest: string): string {
	if (!DIGEST_PATTERN.test(digest)) {
		throw new EvaluatorDraftStoreError("Evaluator digest must be a lowercase SHA-256 hex value.");
	}
	return digest;
}

function positiveBoundedInteger(value: number, label: string, maximum: number): number {
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new EvaluatorDraftStoreError(`${label} must be an integer from 1 through ${maximum}.`);
	}
	return value;
}

function validationLimits(options: {
	maxSourceBytes?: number;
	timeoutMs?: number;
	outputLimitBytes?: number;
}): ValidationLimits {
	return {
		maxSourceBytes: positiveBoundedInteger(
			options.maxSourceBytes ?? DEFAULT_MAX_SOURCE_BYTES,
			"maxSourceBytes",
			HARD_MAX_SOURCE_BYTES,
		),
		timeoutMs: positiveBoundedInteger(
			options.timeoutMs ?? DEFAULT_VALIDATION_TIMEOUT_MS,
			"timeoutMs",
			HARD_MAX_VALIDATION_TIMEOUT_MS,
		),
		outputLimitBytes: positiveBoundedInteger(
			options.outputLimitBytes ?? DEFAULT_VALIDATION_OUTPUT_BYTES,
			"outputLimitBytes",
			HARD_MAX_VALIDATION_OUTPUT_BYTES,
		),
	};
}

function sourceBytes(source: string, maximumBytes: number): Buffer {
	if (typeof source !== "string") {
		throw new EvaluatorDraftStoreError("Evaluator source must be a string.");
	}
	const content = Buffer.from(source, "utf8");
	if (content.byteLength === 0) {
		throw new EvaluatorDraftStoreError("Evaluator source must not be empty.");
	}
	if (content.byteLength > maximumBytes) {
		throw new EvaluatorDraftStoreError(
			`Evaluator source is ${content.byteLength} bytes; limit is ${maximumBytes} bytes.`,
		);
	}
	return content;
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
	const absolute = resolve(path);
	const metadata = await lstat(absolute).catch((error: unknown) => {
		throw new EvaluatorDraftStoreError(`${label} does not exist: ${absolute}`, { cause: error });
	});
	if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
		throw new EvaluatorDraftStoreError(`${label} must be a real directory, not a symbolic link or special file.`);
	}
	return realpath(absolute);
}

async function ensurePrivateDirectory(path: string, label: string): Promise<void> {
	try {
		await mkdir(path, { mode: 0o700 });
	} catch (error) {
		if (!isErrorCode(error, "EEXIST")) {
			throw error;
		}
	}
	const before = await lstat(path);
	if (before.isSymbolicLink() || !before.isDirectory()) {
		throw new EvaluatorDraftStoreError(`${label} must be a real directory and may not be a symbolic link.`);
	}
	assertOwned(before, label);
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
		const opened = await handle.stat();
		if (!opened.isDirectory() || !sameIdentity(before, opened)) {
			throw new EvaluatorDraftStoreError(`${label} changed identity while ISO was securing it.`);
		}
		await handle.chmod(0o700);
		const secured = await handle.stat();
		if (!secured.isDirectory() || (secured.mode & 0o777) !== 0o700 || !sameIdentity(opened, secured)) {
			throw new EvaluatorDraftStoreError(`${label} could not be secured to mode 0700.`);
		}
	} finally {
		await handle?.close();
	}
	const canonical = await realpath(path);
	if (canonical !== path) {
		throw new EvaluatorDraftStoreError(`${label} resolves through an unexpected filesystem indirection.`);
	}
}

async function ensureStoreLayout(repositoryRoot: string): Promise<EvaluatorStoreLayout> {
	const repoRoot = await canonicalDirectory(repositoryRoot, "Repository root");
	const isoRoot = join(repoRoot, ".iso");
	const root = join(repoRoot, EVALUATOR_STORE);
	const drafts = join(root, DRAFT_DIRECTORY);
	const objects = join(root, OBJECT_DIRECTORY);
	const frozen = join(root, FROZEN_DIRECTORY);
	const locks = join(root, LOCK_DIRECTORY);
	await ensurePrivateDirectory(isoRoot, "ISO control directory");
	await ensurePrivateDirectory(root, "Evaluator store directory");
	await ensurePrivateDirectory(drafts, "Evaluator drafts directory");
	await ensurePrivateDirectory(objects, "Evaluator objects directory");
	await ensurePrivateDirectory(frozen, "Frozen evaluators directory");
	await ensurePrivateDirectory(locks, "Evaluator locks directory");
	return { repoRoot, root, drafts, objects, frozen, locks };
}

function assertRegularPrivateFile(metadata: Stats, label: string): void {
	if (metadata.isSymbolicLink() || !metadata.isFile()) {
		throw new EvaluatorDraftStoreError(`${label} must be a regular file and may not be a symbolic link.`);
	}
	if (metadata.nlink !== 1) {
		throw new EvaluatorDraftStoreError(`${label} must have exactly one filesystem link.`);
	}
	assertOwned(metadata, label);
}

async function readSecureFile(
	path: string,
	options: {
		label: string;
		mode: 0o400 | 0o600;
		maxBytes: number;
		optional?: boolean;
	},
): Promise<Buffer | undefined> {
	let before: Stats;
	try {
		before = await lstat(path);
	} catch (error) {
		if (options.optional && isErrorCode(error, "ENOENT")) {
			return undefined;
		}
		throw error;
	}
	assertRegularPrivateFile(before, options.label);
	if (before.size > options.maxBytes) {
		throw new EvaluatorDraftStoreError(`${options.label} exceeds ISO's ${options.maxBytes}-byte source limit.`);
	}
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat();
		assertRegularPrivateFile(opened, options.label);
		if (!sameIdentity(before, opened)) {
			throw new EvaluatorDraftStoreError(`${options.label} changed identity while ISO was opening it.`);
		}
		await handle.chmod(options.mode);
		const secured = await handle.stat();
		if ((secured.mode & 0o777) !== options.mode || !sameIdentity(opened, secured)) {
			throw new EvaluatorDraftStoreError(
				`${options.label} could not be secured to mode ${options.mode.toString(8).padStart(4, "0")}.`,
			);
		}
		const content = await handle.readFile();
		const after = await handle.stat();
		const finalPath = await lstat(path);
		assertRegularPrivateFile(finalPath, options.label);
		if (
			content.byteLength !== after.size ||
			!sameStableFileState(secured, after) ||
			!sameIdentity(after, finalPath)
		) {
			throw new EvaluatorDraftStoreError(`${options.label} changed while ISO was reading it.`);
		}
		return content;
	} finally {
		await handle?.close();
	}
}

async function writeAtomicTemporaryFile(
	directory: string,
	content: Buffer,
	mode: 0o400 | 0o600,
): Promise<{ handle: FileHandle; path: string }> {
	const path = join(directory, `.replace-${process.pid}-${randomBytes(16).toString("hex")}.tmp`);
	const handle = await open(
		path,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		mode,
	);
	try {
		await handle.writeFile(content);
		await handle.chmod(mode);
		await handle.sync();
		const metadata = await handle.stat();
		if (
			!metadata.isFile() ||
			metadata.nlink !== 1 ||
			metadata.size !== content.byteLength ||
			(metadata.mode & 0o777) !== mode
		) {
			throw new EvaluatorDraftStoreError("Atomic evaluator staging file failed its integrity check.");
		}
		return { handle, path };
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(path, { force: true });
		throw error;
	}
}

async function assertInstalledHandle(
	handle: FileHandle,
	target: string,
	mode: 0o400 | 0o600,
	label: string,
): Promise<void> {
	const [opened, installed] = await Promise.all([handle.stat(), lstat(target)]);
	assertRegularPrivateFile(installed, label);
	if (
		!opened.isFile() ||
		opened.nlink !== 1 ||
		!sameIdentity(opened, installed) ||
		(opened.mode & 0o777) !== mode ||
		(installed.mode & 0o777) !== mode
	) {
		throw new EvaluatorDraftStoreError(`${label} failed its post-installation integrity check.`);
	}
}

async function atomicReplacePrivateFile(
	target: string,
	content: Buffer,
	options: { directory: string; label: string; maxBytes: number },
): Promise<void> {
	await readSecureFile(target, {
		label: options.label,
		mode: 0o600,
		maxBytes: options.maxBytes,
		optional: true,
	});
	const temporary = await writeAtomicTemporaryFile(options.directory, content, 0o600);
	let renamed = false;
	try {
		// Refuse a symlink or wrong-type target even if it appeared after the first check.
		await readSecureFile(target, {
			label: options.label,
			mode: 0o600,
			maxBytes: options.maxBytes,
			optional: true,
		});
		await rename(temporary.path, target);
		renamed = true;
		await assertInstalledHandle(temporary.handle, target, 0o600, options.label);
	} finally {
		await temporary.handle.close();
		if (!renamed) {
			await rm(temporary.path, { force: true });
		}
	}
}

async function atomicCreatePrivateFile(
	target: string,
	content: Buffer,
	options: { directory: string; label: string; maxBytes: number; mode: 0o400 | 0o600 },
): Promise<void> {
	const existing = await readSecureFile(target, {
		label: options.label,
		mode: options.mode,
		maxBytes: options.maxBytes,
		optional: true,
	});
	if (existing !== undefined) {
		if (!existing.equals(content)) {
			throw new EvaluatorDraftStoreError(`${options.label} already exists with different content.`);
		}
		return;
	}
	const temporary = await writeAtomicTemporaryFile(options.directory, content, options.mode);
	let installed = false;
	try {
		try {
			await link(temporary.path, target);
			await rm(temporary.path);
			installed = true;
			await assertInstalledHandle(temporary.handle, target, options.mode, options.label);
		} catch (error) {
			if (!isErrorCode(error, "EEXIST")) {
				throw error;
			}
			const raced = await readSecureFile(target, {
				label: options.label,
				mode: options.mode,
				maxBytes: options.maxBytes,
			});
			if (raced === undefined || !raced.equals(content)) {
				throw new EvaluatorDraftStoreError(`${options.label} appeared with different content.`, {
					cause: error,
				});
			}
		}
	} finally {
		await temporary.handle.close();
		if (!installed) {
			await rm(temporary.path, { force: true });
		}
	}
}

function processExists(processId: number): boolean {
	try {
		process.kill(processId, 0);
		return true;
	} catch (error) {
		if (isErrorCode(error, "ESRCH")) {
			return false;
		}
		if (isErrorCode(error, "EPERM")) {
			return true;
		}
		throw new EvaluatorDraftStoreError(`Could not inspect evaluator lock owner process ${processId}.`, {
			cause: error,
		});
	}
}

function linuxProcessStart(stat: string): string {
	const commandEnd = stat.lastIndexOf(")");
	if (commandEnd < 0) {
		throw new EvaluatorDraftStoreError("Linux returned malformed process metadata for an evaluator lock owner.");
	}
	const fields = stat
		.slice(commandEnd + 1)
		.trim()
		.split(/\s+/u);
	const startTicks = fields[19];
	if (startTicks === undefined || !/^[0-9]+$/u.test(startTicks)) {
		throw new EvaluatorDraftStoreError("Linux omitted process start metadata for an evaluator lock owner.");
	}
	return startTicks;
}

async function macOSProcessStart(processId: number): Promise<string | undefined> {
	return new Promise<string | undefined>((resolveStart, rejectStart) => {
		const child = spawn("/bin/ps", ["-p", String(processId), "-o", "lstart="], {
			env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const output: Buffer[] = [];
		let outputBytes = 0;
		let terminalError: Error | undefined;
		const collect = (chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > 1024) {
				terminalError ??= new EvaluatorDraftStoreError(
					`Process metadata for evaluator lock owner ${processId} exceeded 1024 bytes.`,
				);
				child.kill("SIGKILL");
				return;
			}
			output.push(chunk);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", (error) => {
			terminalError ??= new EvaluatorDraftStoreError(
				`Could not start process inspection for evaluator lock owner ${processId}.`,
				{ cause: error },
			);
		});
		child.once("close", (code) => {
			if (terminalError !== undefined) {
				rejectStart(terminalError);
				return;
			}
			const value = Buffer.concat(output).toString("utf8").trim();
			if (code === 0 && value !== "") {
				resolveStart(value);
				return;
			}
			if (!processExists(processId)) {
				resolveStart(undefined);
				return;
			}
			rejectStart(
				new EvaluatorDraftStoreError(
					`Could not read process start metadata for evaluator lock owner ${processId}.`,
				),
			);
		});
	});
}

async function processStartIdentity(processId: number): Promise<string | undefined> {
	if (!Number.isSafeInteger(processId) || processId < 1) {
		throw new EvaluatorDraftStoreError("Evaluator lock owner PID is invalid.");
	}
	if (!processExists(processId)) {
		return undefined;
	}
	if (process.platform === "linux") {
		try {
			const [bootId, stat] = await Promise.all([
				readFile("/proc/sys/kernel/random/boot_id", "utf8"),
				readFile(`/proc/${processId}/stat`, "utf8"),
			]);
			return `linux:${bootId.trim()}:${linuxProcessStart(stat)}`;
		} catch (error) {
			if (isErrorCode(error, "ENOENT") && !processExists(processId)) {
				return undefined;
			}
			throw new EvaluatorDraftStoreError(
				`Could not read Linux process identity for evaluator lock owner ${processId}.`,
				{ cause: error },
			);
		}
	}
	if (process.platform === "darwin") {
		const start = await macOSProcessStart(processId);
		return start === undefined ? undefined : `darwin:${start}`;
	}
	throw new EvaluatorDraftStoreError(`Evaluator draft locks are unsupported on ${process.platform}.`);
}

function draftLockFilePattern(name: string): RegExp {
	return new RegExp(`^${name}\\.([1-9][0-9]{0,15})\\.([a-f0-9]{32})\\.lock$`, "u");
}

function parseDraftLockOwner(content: Buffer): DraftLockOwner | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(content.toString("utf8"));
	} catch {
		return undefined;
	}
	if (
		typeof parsed !== "object" ||
		parsed === null ||
		Array.isArray(parsed) ||
		!("version" in parsed) ||
		parsed.version !== DRAFT_LOCK_VERSION ||
		!("name" in parsed) ||
		typeof parsed.name !== "string" ||
		!("pid" in parsed) ||
		typeof parsed.pid !== "number" ||
		!("processStart" in parsed) ||
		typeof parsed.processStart !== "string" ||
		parsed.processStart.length === 0 ||
		parsed.processStart.length > 512 ||
		!("token" in parsed) ||
		typeof parsed.token !== "string"
	) {
		return undefined;
	}
	return {
		version: DRAFT_LOCK_VERSION,
		name: parsed.name,
		pid: parsed.pid,
		processStart: parsed.processStart,
		token: parsed.token,
	};
}

async function readDraftLockRecord(path: string): Promise<{ metadata: Stats; owner?: DraftLockOwner }> {
	const before = await lstat(path);
	assertRegularPrivateFile(before, "Evaluator operation lock");
	if ((before.mode & 0o777) !== 0o600 || before.size > DRAFT_LOCK_RECORD_MAX_BYTES) {
		throw new EvaluatorDraftStoreError("Evaluator operation lock has unsafe permissions or size.");
	}
	let handle: FileHandle | undefined;
	try {
		handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
		const opened = await handle.stat();
		assertRegularPrivateFile(opened, "Evaluator operation lock");
		if (!sameIdentity(before, opened)) {
			throw new EvaluatorDraftStoreError("Evaluator operation lock changed identity while it was opened.");
		}
		const content = await handle.readFile();
		const after = await handle.stat();
		const finalPath = await lstat(path);
		assertRegularPrivateFile(finalPath, "Evaluator operation lock");
		if (content.byteLength !== after.size || !sameStableFileState(opened, after) || !sameIdentity(after, finalPath)) {
			throw new EvaluatorDraftStoreError("Evaluator operation lock changed while it was inspected.");
		}
		return { metadata: after, owner: parseDraftLockOwner(content) };
	} finally {
		await handle?.close();
	}
}

async function removeDraftLockRecord(path: string, expected: Stats): Promise<void> {
	let current: Stats;
	try {
		current = await lstat(path);
	} catch (error) {
		if (isErrorCode(error, "ENOENT")) {
			return;
		}
		throw error;
	}
	if (!sameIdentity(expected, current)) {
		throw new EvaluatorDraftStoreError("Evaluator operation lock changed identity before cleanup.");
	}
	await rm(path);
}

async function acquireDraftLock(layout: EvaluatorStoreLayout, name: string): Promise<() => Promise<void>> {
	const processStart = await processStartIdentity(process.pid);
	if (processStart === undefined) {
		throw new EvaluatorDraftStoreError("ISO could not identify its evaluator lock owner process.");
	}
	const token = randomBytes(16).toString("hex");
	const owner: DraftLockOwner = {
		version: DRAFT_LOCK_VERSION,
		name,
		pid: process.pid,
		processStart,
		token,
	};
	const lockPath = join(layout.locks, `${name}.${process.pid}.${token}.lock`);
	const content = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
	const handle = await open(
		lockPath,
		constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
		0o600,
	);
	try {
		await handle.writeFile(content);
		await handle.chmod(0o600);
		await handle.sync();
		const installed = await handle.stat();
		const finalPath = await lstat(lockPath);
		if (
			!installed.isFile() ||
			installed.nlink !== 1 ||
			installed.size !== content.byteLength ||
			(installed.mode & 0o777) !== 0o600 ||
			!sameIdentity(installed, finalPath)
		) {
			throw new EvaluatorDraftStoreError("Evaluator operation lock failed its installation integrity check.");
		}
	} catch (error) {
		await handle.close().catch(() => undefined);
		await rm(lockPath, { force: true });
		throw error;
	}
	try {
		await handle.close();
	} catch (error) {
		await rm(lockPath, { force: true });
		throw error;
	}

	try {
		await readDraftLockRecord(lockPath);
	} catch (error) {
		await rm(lockPath, { force: true });
		throw error;
	}
	const releaseOwnLock = async (): Promise<void> => {
		const record = await readDraftLockRecord(lockPath);
		if (
			record.owner?.name !== owner.name ||
			record.owner.pid !== owner.pid ||
			record.owner.processStart !== owner.processStart ||
			record.owner.token !== owner.token
		) {
			throw new EvaluatorDraftStoreError("Evaluator operation lock ownership changed before release.");
		}
		await removeDraftLockRecord(lockPath, record.metadata);
	};

	try {
		const pattern = draftLockFilePattern(name);
		for (const entry of (await readdir(layout.locks)).sort()) {
			const path = join(layout.locks, entry);
			if (path === lockPath) {
				continue;
			}
			const match = pattern.exec(entry);
			if (match === null) {
				if (entry === `${name}.lock` || (entry.startsWith(`${name}.`) && entry.endsWith(".lock"))) {
					throw new EvaluatorDraftStoreError("Evaluator operation lock has no safe owner identity.");
				}
				continue;
			}
			const processId = Number.parseInt(match[1] ?? "", 10);
			const entryToken = match[2];
			const record = await readDraftLockRecord(path);
			const observedStart = await processStartIdentity(processId);
			const validOwner =
				record.owner?.name === name &&
				record.owner.pid === processId &&
				record.owner.token === entryToken &&
				DRAFT_LOCK_TOKEN_PATTERN.test(record.owner.token);
			if (observedStart === undefined || (validOwner && record.owner?.processStart !== observedStart)) {
				await removeDraftLockRecord(path, record.metadata);
				continue;
			}
			if (!validOwner) {
				throw new EvaluatorDraftStoreError("Evaluator operation lock has invalid live-owner metadata.");
			}
			throw new EvaluatorDraftStoreError(
				`Evaluator '${name}' is already being changed; retry after the active operation finishes.`,
			);
		}
	} catch (error) {
		try {
			await releaseOwnLock();
		} catch (releaseError) {
			throw new AggregateError([error, releaseError], "Evaluator lock acquisition and cleanup both failed.");
		}
		throw error;
	}

	let released = false;
	return async () => {
		if (released) {
			return;
		}
		await releaseOwnLock();
		released = true;
	};
}

async function runNodeSyntaxCheck(
	file: string,
	cwd: string,
	options: { outputLimitBytes: number; timeoutMs: number },
): Promise<void> {
	await new Promise<void>((resolveCheck, rejectCheck) => {
		const child = spawn(process.execPath, ["--check", file], {
			cwd,
			env: { PATH: dirname(process.execPath) },
			stdio: ["ignore", "pipe", "pipe"],
		});
		const output: Buffer[] = [];
		let outputBytes = 0;
		let terminalError: Error | undefined;
		const stop = (error: Error): void => {
			if (terminalError !== undefined) {
				return;
			}
			terminalError = error;
			child.kill("SIGKILL");
		};
		const collect = (chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > options.outputLimitBytes) {
				stop(new EvaluatorDraftStoreError(`Node syntax-check output exceeded ${options.outputLimitBytes} bytes.`));
				return;
			}
			output.push(chunk);
		};
		child.stdout.on("data", collect);
		child.stderr.on("data", collect);
		child.once("error", (error) => {
			terminalError ??= new EvaluatorDraftStoreError("Could not start Node evaluator syntax validation.", {
				cause: error,
			});
		});
		const timeout = setTimeout(() => {
			stop(new EvaluatorDraftStoreError(`Node syntax validation exceeded ${options.timeoutMs}ms.`));
		}, options.timeoutMs);
		timeout.unref();
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (terminalError !== undefined) {
				rejectCheck(terminalError);
				return;
			}
			if (code !== 0) {
				const detail = Buffer.concat(output).toString("utf8").trim();
				rejectCheck(
					new EvaluatorDraftStoreError(`Evaluator failed Node syntax validation${detail ? `: ${detail}` : "."}`),
				);
				return;
			}
			resolveCheck();
		});
	});
}

async function validationDirectories(
	repoRootValue: string,
	candidateCwdValue: string,
	controlCwdValue?: string,
): Promise<{ repoRoot: string; candidateCwd: string; controlCwd?: string }> {
	const [repoRoot, candidateCwd, controlCwd] = await Promise.all([
		canonicalDirectory(repoRootValue, "Repository root"),
		canonicalDirectory(candidateCwdValue, "Evaluator candidate cwd"),
		controlCwdValue === undefined
			? Promise.resolve(undefined)
			: canonicalDirectory(controlCwdValue, "Evaluator control cwd"),
	]);
	if (isContainedPath(repoRoot, candidateCwd) || isContainedPath(candidateCwd, repoRoot)) {
		throw new EvaluatorDraftStoreError(
			"Evaluator candidate cwd must be a disposable directory disjoint from the trusted repository.",
		);
	}
	if (
		controlCwd !== undefined &&
		(isContainedPath(repoRoot, controlCwd) ||
			isContainedPath(controlCwd, repoRoot) ||
			isContainedPath(candidateCwd, controlCwd) ||
			isContainedPath(controlCwd, candidateCwd))
	) {
		throw new EvaluatorDraftStoreError(
			"Evaluator control cwd must be a detached directory disjoint from the trusted repository and candidate.",
		);
	}
	return { repoRoot, candidateCwd, controlCwd };
}

/**
 * Parse-check and execute one bounded, sandboxed ISO_RESULT sample without
 * installing the source. The candidate directory is explicit and may be
 * modified by the evaluator, so callers must supply a disposable checkout.
 */
export async function validateEvaluatorDraft(
	options: EvaluatorDraftValidationOptions,
): Promise<EvaluatorDraftValidation> {
	const limits = validationLimits(options);
	const content = sourceBytes(options.source, limits.maxSourceBytes);
	const digest = createHash("sha256").update(content).digest("hex");
	const { repoRoot, candidateCwd, controlCwd } = await validationDirectories(
		options.repoRoot,
		options.candidateCwd,
		options.controlCwd,
	);
	const validationRoot = await realpath(
		await mkdtemp(
			join(
				controlCwd ?? tmpdir(),
				controlCwd === undefined ? "iso-evaluator-validation-" : ".iso-evaluator-validation-",
			),
		),
	);
	const validationFileName = `.validate-${randomBytes(16).toString("hex")}.mjs`;
	if (!INTERNAL_VALIDATION_FILE_PATTERN.test(validationFileName)) {
		throw new EvaluatorDraftStoreError("ISO generated an invalid internal evaluator validation path.");
	}
	const validationFile = join(validationRoot, validationFileName);
	try {
		await ensurePrivateDirectory(validationRoot, "Evaluator validation directory");
		const handle = await open(
			validationFile,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		try {
			await handle.writeFile(content);
			await handle.chmod(0o600);
			await handle.sync();
		} finally {
			await handle.close();
		}
		await runNodeSyntaxCheck(validationFile, validationRoot, {
			outputLimitBytes: limits.outputLimitBytes,
			timeoutMs: DEFAULT_VALIDATION_TIMEOUT_MS,
		});
		const evaluation = await runEvaluator(`exec ${shellQuote.quote([process.execPath, "--", validationFile])}`, {
			repoRoot,
			controlCwd: controlCwd ?? validationRoot,
			experimentDir: candidateCwd,
			warmups: 0,
			samples: 1,
			timeoutMs: limits.timeoutMs,
			outputLimitBytes: limits.outputLimitBytes,
			trialId: `evaluator-draft-${digest}`,
		});
		if (!evaluation.valid) {
			throw new EvaluatorDraftStoreError(
				"Evaluator dry-run returned valid=false or a failed ISO_RESULT constraint.",
			);
		}
		return { digest, sourceBytes: content.byteLength, evaluation };
	} finally {
		await rm(validationRoot, { force: true, recursive: true });
	}
}

function draftRelativePath(name: string): string {
	return `${EVALUATOR_STORE}/${DRAFT_DIRECTORY}/${name}.mjs`;
}

function objectRelativePath(digest: string): string {
	return `${EVALUATOR_STORE}/${OBJECT_DIRECTORY}/${digest}.mjs`;
}

function frozenRelativePath(digest: string): string {
	return `${EVALUATOR_STORE}/${FROZEN_DIRECTORY}/${digest}.mjs`;
}

export async function storeEvaluatorDraft(options: StoreEvaluatorDraftOptions): Promise<StoredEvaluatorDraft> {
	const name = evaluatorName(options.name);
	const limits = validationLimits(options);
	const content = sourceBytes(options.source, limits.maxSourceBytes);
	let layout = await ensureStoreLayout(options.repoRoot);
	const release = await acquireDraftLock(layout, name);
	try {
		await readSecureFile(join(layout.drafts, `${name}.mjs`), {
			label: `Evaluator draft '${name}'`,
			mode: 0o600,
			maxBytes: limits.maxSourceBytes,
			optional: true,
		});
		const validation = await validateEvaluatorDraft(options);
		layout = await ensureStoreLayout(options.repoRoot);
		const object = join(layout.objects, `${validation.digest}.mjs`);
		await atomicCreatePrivateFile(object, content, {
			directory: layout.objects,
			label: `Evaluator object '${validation.digest}'`,
			maxBytes: limits.maxSourceBytes,
			mode: 0o400,
		});
		await atomicReplacePrivateFile(join(layout.drafts, `${name}.mjs`), content, {
			directory: layout.drafts,
			label: `Evaluator draft '${name}'`,
			maxBytes: limits.maxSourceBytes,
		});
		return {
			...validation,
			name,
			draftPath: draftRelativePath(name),
			objectPath: objectRelativePath(validation.digest),
		};
	} finally {
		await release();
	}
}

export async function freezeEvaluatorDraft(options: FreezeEvaluatorDraftOptions): Promise<FrozenEvaluatorDraft> {
	const name = evaluatorName(options.name);
	const digest = evaluatorDigest(options.digest);
	const limits = validationLimits(options);
	let layout = await ensureStoreLayout(options.repoRoot);
	const release = await acquireDraftLock(layout, name);
	try {
		const draftPath = join(layout.drafts, `${name}.mjs`);
		const objectPath = join(layout.objects, `${digest}.mjs`);
		const source = await readSecureFile(draftPath, {
			label: `Evaluator draft '${name}'`,
			mode: 0o600,
			maxBytes: limits.maxSourceBytes,
		});
		if (source === undefined) {
			throw new EvaluatorDraftStoreError(`Evaluator draft '${name}' does not exist.`);
		}
		const actualDigest = createHash("sha256").update(source).digest("hex");
		if (actualDigest !== digest) {
			throw new EvaluatorDraftStoreError(`Evaluator draft '${name}' no longer matches expected digest ${digest}.`);
		}
		const object = await readSecureFile(objectPath, {
			label: `Evaluator object '${digest}'`,
			mode: 0o400,
			maxBytes: limits.maxSourceBytes,
		});
		if (object === undefined || !object.equals(source)) {
			throw new EvaluatorDraftStoreError(`Evaluator object '${digest}' failed content-address verification.`);
		}
		const validation = await validateEvaluatorDraft({
			repoRoot: options.repoRoot,
			controlCwd: options.controlCwd,
			candidateCwd: options.candidateCwd,
			source: source.toString("utf8"),
			maxSourceBytes: limits.maxSourceBytes,
			timeoutMs: limits.timeoutMs,
			outputLimitBytes: limits.outputLimitBytes,
		});
		if (validation.digest !== digest) {
			throw new EvaluatorDraftStoreError("Evaluator draft changed encoding during freeze validation.");
		}
		layout = await ensureStoreLayout(options.repoRoot);
		const sourceAfterValidation = await readSecureFile(join(layout.drafts, `${name}.mjs`), {
			label: `Evaluator draft '${name}'`,
			mode: 0o600,
			maxBytes: limits.maxSourceBytes,
		});
		if (sourceAfterValidation === undefined || !sourceAfterValidation.equals(source)) {
			throw new EvaluatorDraftStoreError(`Evaluator draft '${name}' changed during freeze validation.`);
		}
		const objectAfterValidation = await readSecureFile(join(layout.objects, `${digest}.mjs`), {
			label: `Evaluator object '${digest}'`,
			mode: 0o400,
			maxBytes: limits.maxSourceBytes,
		});
		if (objectAfterValidation === undefined || !objectAfterValidation.equals(source)) {
			throw new EvaluatorDraftStoreError(`Evaluator object '${digest}' changed during freeze validation.`);
		}
		await atomicCreatePrivateFile(join(layout.frozen, `${digest}.mjs`), source, {
			directory: layout.frozen,
			label: `Frozen evaluator '${digest}'`,
			maxBytes: limits.maxSourceBytes,
			mode: 0o400,
		});
		return {
			...validation,
			name,
			draftPath: draftRelativePath(name),
			objectPath: objectRelativePath(digest),
			frozenPath: frozenRelativePath(digest),
		};
	} finally {
		await release();
	}
}
