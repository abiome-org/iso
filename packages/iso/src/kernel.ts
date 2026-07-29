import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ControlConflictError, type ResearchControlAction } from "./control.ts";
import { normalizeRepositoryRelativePath } from "./git.ts";
import {
	assertDigest,
	assertPreflightFailureCode,
	assertPreflightIdentifier,
	assertPreflightIntentKey,
	assertPreflightReason,
	canonicalPayloadDigest,
	type PreflightBeginInput,
	type PreflightClaimInput,
	type PreflightContinuationLookup,
	type PreflightCorrectInput,
	type PreflightDeferInput,
	PreflightError,
	type PreflightFailInput,
	type PreflightLookup,
	type PreflightOpenInput,
	type PreflightRenewInput,
	type PreflightResolveInput,
	type PreflightResumeInput,
	preflightLaunchIdentity,
} from "./preflight.ts";
import type {
	CampaignCalibrationInput,
	ConversationalMissionLaunch,
	CurrentResearchControlReceipt,
} from "./runtime.ts";
import { IsoRuntime } from "./runtime.ts";
import { type DashboardServer, startDashboard } from "./server.ts";
import { IdempotencyConflictError, IsoStore } from "./store.ts";
import type {
	Campaign,
	EvidenceQueryInput,
	MissionReceipt,
	OperatorNote,
	ProposedIdea,
	SourceBundleIdentity,
} from "./types.ts";

const PROTOCOL = "iso.kernel.v1";
const MAX_REQUEST_BYTES = 1024 * 1024;
const LOCK_WAIT_MS = 10_000;

export type KernelCommand =
	| "ping"
	| "status"
	| "summary"
	| "query"
	| "preflight/open"
	| "preflight/begin"
	| "preflight/claim"
	| "preflight/renew"
	| "preflight/resume"
	| "preflight/continuation"
	| "preflight/status"
	| "preflight/defer"
	| "preflight/correct"
	| "preflight/resolve"
	| "preflight/fail"
	| "launch"
	| "calibrate"
	| "start"
	| "pause"
	| "resume"
	| "stop"
	| "steer"
	| "note"
	| "ack-updates"
	| "champion"
	| "abort"
	| "dashboard"
	| "shutdown";

export type KernelResponse<TResult> =
	| {
			protocol: typeof PROTOCOL;
			id: string;
			ok: true;
			result: TResult;
	  }
	| {
			protocol: typeof PROTOCOL;
			id: string;
			ok: false;
			error: {
				code: string;
				message: string;
			};
	  };

interface WireRequest {
	protocol: typeof PROTOCOL;
	id: string;
	command: KernelCommand;
	payload?: unknown;
}

interface LockRecord {
	pid: number;
	token: string;
	startedAt: string;
}

interface KernelPaths {
	directory: string;
	socket: string;
	lock: string;
}

class KernelRequestError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "KernelRequestError";
		this.code = code;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function pathsFor(repoRoot: string): KernelPaths {
	const directory = join(repoRoot, ".iso");
	return {
		directory,
		socket: join(directory, "kernel.sock"),
		lock: join(directory, "kernel.lock"),
	};
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function readBody(request: IncomingMessage): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		let rejected = false;
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			if (rejected) {
				return;
			}
			body += chunk;
			if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) {
				rejected = true;
				reject(new KernelRequestError("request_too_large", "Request body exceeds 1 MiB."));
				request.destroy();
			}
		});
		request.on("end", () => {
			if (rejected) {
				return;
			}
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch {
				reject(new KernelRequestError("invalid_json", "Request body must be valid JSON."));
			}
		});
		request.on("error", reject);
	});
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	response.end(`${JSON.stringify(value)}\n`);
}

function parseWireRequest(value: unknown): WireRequest {
	if (
		!isRecord(value) ||
		value.protocol !== PROTOCOL ||
		typeof value.id !== "string" ||
		value.id.length < 1 ||
		value.id.length > 200 ||
		!/^[a-zA-Z0-9:._-]+$/.test(value.id) ||
		typeof value.command !== "string"
	) {
		throw new KernelRequestError("invalid_request", "Invalid ISO kernel request envelope.");
	}
	const commands: KernelCommand[] = [
		"ping",
		"status",
		"summary",
		"query",
		"preflight/open",
		"preflight/begin",
		"preflight/claim",
		"preflight/renew",
		"preflight/resume",
		"preflight/continuation",
		"preflight/status",
		"preflight/defer",
		"preflight/correct",
		"preflight/resolve",
		"preflight/fail",
		"launch",
		"calibrate",
		"start",
		"pause",
		"resume",
		"stop",
		"steer",
		"note",
		"ack-updates",
		"champion",
		"abort",
		"dashboard",
		"shutdown",
	];
	if (!commands.includes(value.command as KernelCommand)) {
		throw new KernelRequestError("unknown_command", `Unknown ISO kernel command: ${value.command}`);
	}
	return {
		protocol: PROTOCOL,
		id: value.id,
		command: value.command as KernelCommand,
		payload: value.payload,
	};
}

function requiredRecord(value: unknown, label: string): Record<string, unknown> {
	if (!isRecord(value)) {
		throw new KernelRequestError("invalid_payload", `${label} must be an object.`);
	}
	return value;
}

function requiredString(record: Record<string, unknown>, key: string, maximum = 100_000): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0 || value.length > maximum) {
		throw new KernelRequestError("invalid_payload", `${key} must be a non-empty string of at most ${maximum} bytes.`);
	}
	return value;
}

function requiredNumber(
	record: Record<string, unknown>,
	key: string,
	options: { minimum: number; maximum: number; integer?: boolean },
): number {
	const value = record[key];
	if (
		typeof value !== "number" ||
		!Number.isFinite(value) ||
		value < options.minimum ||
		value > options.maximum ||
		(options.integer === true && !Number.isSafeInteger(value))
	) {
		throw new KernelRequestError(
			"invalid_payload",
			`${key} must be ${options.integer === true ? "an integer" : "a number"} from ${options.minimum} to ${options.maximum}.`,
		);
	}
	return value;
}

function optionalNumber(
	record: Record<string, unknown>,
	key: string,
	options: { minimum: number; maximum: number; integer?: boolean },
): number | undefined {
	return record[key] === undefined ? undefined : requiredNumber(record, key, options);
}

function requiredBoolean(record: Record<string, unknown>, key: string): boolean {
	const value = record[key];
	if (typeof value !== "boolean") {
		throw new KernelRequestError("invalid_payload", `${key} must be a boolean.`);
	}
	return value;
}

function stringArray(record: Record<string, unknown>, key: string): string[] {
	const value = record[key];
	if (
		!Array.isArray(value) ||
		value.length > 100 ||
		!value.every((entry) => typeof entry === "string" && entry.length > 0 && entry.length <= 1_000)
	) {
		throw new KernelRequestError("invalid_payload", `${key} must be an array of at most 100 non-empty strings.`);
	}
	return value;
}

function parseSourceBundle(input: Record<string, unknown>): SourceBundleIdentity | undefined {
	const keys = [
		"sourceCommit",
		"sourceHeadCommit",
		"sourceSnapshotRef",
		"sourceHadLocalChanges",
		"sourceSnapshotPaths",
		"dependencyDigest",
	] as const;
	const present = keys.filter((key) => input[key] !== undefined).length;
	if (present === 0) {
		return undefined;
	}
	if (present !== keys.length) {
		throw new KernelRequestError(
			"invalid_payload",
			"A launch source bundle must include every source identity field.",
		);
	}
	const sourceCommit = requiredString(input, "sourceCommit", 64);
	const sourceHeadCommit = requiredString(input, "sourceHeadCommit", 64);
	const sourceSnapshotRef = requiredString(input, "sourceSnapshotRef", 200);
	const dependencyDigest = requiredString(input, "dependencyDigest", 64);
	if (
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceCommit) ||
		!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(sourceHeadCommit)
	) {
		throw new KernelRequestError("invalid_payload", "Source commits must be lowercase Git object IDs.");
	}
	if (sourceSnapshotRef !== `refs/iso/source-snapshots/${sourceCommit}`) {
		throw new KernelRequestError(
			"invalid_payload",
			"sourceSnapshotRef must be the immutable private ref for sourceCommit.",
		);
	}
	if (!/^[a-f0-9]{64}$/u.test(dependencyDigest)) {
		throw new KernelRequestError("invalid_payload", "dependencyDigest must be a lowercase SHA-256 digest.");
	}
	const sourceHadLocalChanges = requiredBoolean(input, "sourceHadLocalChanges");
	const rawPaths = input.sourceSnapshotPaths;
	if (!Array.isArray(rawPaths) || rawPaths.length > 250) {
		throw new KernelRequestError("invalid_payload", "sourceSnapshotPaths must be an array of at most 250 paths.");
	}
	let totalPathBytes = 0;
	const sourceSnapshotPaths = rawPaths.map((value) => {
		if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > 4 * 1024) {
			throw new KernelRequestError(
				"invalid_payload",
				"Each sourceSnapshotPaths entry must be a non-empty string of at most 4096 bytes.",
			);
		}
		totalPathBytes += Buffer.byteLength(value);
		try {
			const normalized = normalizeRepositoryRelativePath(value, "sourceSnapshotPaths entry");
			if (normalized !== value) {
				throw new Error(`Source snapshot path was not canonical: ${value}`);
			}
			return normalized;
		} catch (error) {
			throw new KernelRequestError("invalid_payload", errorMessage(error));
		}
	});
	if (totalPathBytes > 256 * 1024 || new Set(sourceSnapshotPaths).size !== sourceSnapshotPaths.length) {
		throw new KernelRequestError(
			"invalid_payload",
			"sourceSnapshotPaths must be unique and fit ISO's bounded path budget.",
		);
	}
	if (sourceHadLocalChanges !== (sourceCommit !== sourceHeadCommit)) {
		throw new KernelRequestError(
			"invalid_payload",
			"sourceHadLocalChanges does not match sourceCommit and sourceHeadCommit.",
		);
	}
	return {
		sourceCommit,
		sourceHeadCommit,
		sourceSnapshotRef,
		sourceHadLocalChanges,
		sourceSnapshotPaths: [...sourceSnapshotPaths].sort(),
		dependencyDigest,
	};
}

function optionalString(record: Record<string, unknown>, key: string, maximum = 100_000): string | undefined {
	const value = record[key];
	if (value === undefined) {
		return undefined;
	}
	if (typeof value !== "string" || value.length > maximum) {
		throw new KernelRequestError("invalid_payload", `${key} must be a string of at most ${maximum} bytes.`);
	}
	return value;
}

function onlyKeys(record: Record<string, unknown>, label: string, allowed: readonly string[]): void {
	const unexpected = Object.keys(record).filter((key) => !allowed.includes(key));
	if (unexpected.length > 0) {
		throw new KernelRequestError(
			"invalid_payload",
			`${label} contains unsupported fields: ${unexpected.sort().join(", ")}.`,
		);
	}
}

function commandFingerprint(command: KernelCommand, payload: unknown): string {
	return canonicalPayloadDigest(`iso.kernel.command.${command}.v1`, payload);
}

function leaseReplayFingerprint<TPayload extends { attemptId: string }>(
	command: "preflight/begin" | "preflight/resume",
	payload: TPayload,
): string {
	const stablePayload = Object.fromEntries(Object.entries(payload).filter(([key]) => key !== "attemptId"));
	return commandFingerprint(command, stablePayload);
}

function parsePreflightOpen(value: unknown): PreflightOpenInput {
	const input = requiredRecord(value, "preflight/open");
	onlyKeys(input, "preflight/open", ["intentKey", "objectiveDigest"]);
	const intentKey = requiredString(input, "intentKey", 64);
	const objectiveDigest = requiredString(input, "objectiveDigest", 64);
	assertPreflightIntentKey(intentKey);
	assertDigest(objectiveDigest, "objectiveDigest");
	return { intentKey, objectiveDigest };
}

function parsePreflightAttemptIdentity(
	input: Record<string, unknown>,
): Pick<PreflightBeginInput, "attemptId" | "sessionDigest" | "leaseTtlMs"> {
	const attemptId = requiredString(input, "attemptId", 200);
	const sessionDigest = requiredString(input, "sessionDigest", 64);
	const leaseTtlMs = requiredNumber(input, "leaseTtlMs", {
		minimum: 5_000,
		maximum: 300_000,
		integer: true,
	});
	assertPreflightIdentifier(attemptId, "attemptId");
	assertDigest(sessionDigest, "sessionDigest");
	return { attemptId, sessionDigest, leaseTtlMs };
}

function parsePreflightBegin(value: unknown): PreflightBeginInput {
	const input = requiredRecord(value, "preflight/begin");
	onlyKeys(input, "preflight/begin", ["intentKey", "objectiveDigest", "attemptId", "sessionDigest", "leaseTtlMs"]);
	const open = parsePreflightOpen({
		intentKey: input.intentKey,
		objectiveDigest: input.objectiveDigest,
	});
	return { ...open, ...parsePreflightAttemptIdentity(input) };
}

function parsePreflightClaim(value: unknown): PreflightClaimInput {
	const input = requiredRecord(value, "preflight/claim");
	onlyKeys(input, "preflight/claim", ["preflightId", "attemptId", "sessionDigest", "leaseTtlMs"]);
	const preflightId = requiredString(input, "preflightId", 200);
	assertPreflightIdentifier(preflightId, "preflightId");
	return { preflightId, ...parsePreflightAttemptIdentity(input) };
}

function parsePreflightRenew(value: unknown): PreflightRenewInput {
	const input = requiredRecord(value, "preflight/renew");
	onlyKeys(input, "preflight/renew", ["preflightId", "attemptId", "leaseTtlMs"]);
	const preflightId = requiredString(input, "preflightId", 200);
	const attemptId = requiredString(input, "attemptId", 200);
	const leaseTtlMs = requiredNumber(input, "leaseTtlMs", {
		minimum: 5_000,
		maximum: 300_000,
		integer: true,
	});
	assertPreflightIdentifier(preflightId, "preflightId");
	assertPreflightIdentifier(attemptId, "attemptId");
	return { preflightId, attemptId, leaseTtlMs };
}

function parsePreflightResume(value: unknown): PreflightResumeInput {
	const input = requiredRecord(value, "preflight/resume");
	onlyKeys(input, "preflight/resume", ["preflightId", "answerDigest", "attemptId", "sessionDigest", "leaseTtlMs"]);
	const preflightId = requiredString(input, "preflightId", 200);
	const answerDigest = requiredString(input, "answerDigest", 64);
	assertPreflightIdentifier(preflightId, "preflightId");
	assertDigest(answerDigest, "answerDigest");
	return { preflightId, answerDigest, ...parsePreflightAttemptIdentity(input) };
}

function parsePreflightContinuation(value: unknown): PreflightContinuationLookup {
	const input = requiredRecord(value, "preflight/continuation");
	onlyKeys(input, "preflight/continuation", ["sessionDigest"]);
	const sessionDigest = requiredString(input, "sessionDigest", 64);
	assertDigest(sessionDigest, "sessionDigest");
	return { sessionDigest };
}

function parsePreflightLookup(value: unknown): PreflightLookup {
	const input = requiredRecord(value, "preflight/status");
	onlyKeys(input, "preflight/status", ["preflightId", "intentKey"]);
	const hasPreflightId = input.preflightId !== undefined;
	const hasIntentKey = input.intentKey !== undefined;
	if (hasPreflightId === hasIntentKey) {
		throw new KernelRequestError(
			"invalid_payload",
			"preflight/status requires exactly one of preflightId or intentKey.",
		);
	}
	if (hasPreflightId) {
		const preflightId = requiredString(input, "preflightId", 200);
		assertPreflightIdentifier(preflightId, "preflightId");
		return { preflightId };
	}
	const intentKey = requiredString(input, "intentKey", 64);
	assertPreflightIntentKey(intentKey);
	return { intentKey };
}

function parsePreflightDefer(value: unknown): PreflightDeferInput {
	const input = requiredRecord(value, "preflight/defer");
	onlyKeys(input, "preflight/defer", ["preflightId", "reason", "questionDigest", "attemptId"]);
	const preflightId = requiredString(input, "preflightId", 200);
	const reason = requiredString(input, "reason", 32);
	const questionDigest = requiredString(input, "questionDigest", 64);
	const attemptId = requiredString(input, "attemptId", 200);
	assertPreflightIdentifier(preflightId, "preflightId");
	assertPreflightReason(reason, { allowAnalysisOnly: false });
	assertDigest(questionDigest, "questionDigest");
	assertPreflightIdentifier(attemptId, "attemptId");
	return {
		preflightId,
		reason: reason as PreflightDeferInput["reason"],
		questionDigest,
		attemptId,
	};
}

function parsePreflightCorrect(value: unknown): PreflightCorrectInput {
	const input = requiredRecord(value, "preflight/correct");
	onlyKeys(input, "preflight/correct", ["preflightId", "attemptId"]);
	const preflightId = requiredString(input, "preflightId", 200);
	const attemptId = requiredString(input, "attemptId", 200);
	assertPreflightIdentifier(preflightId, "preflightId");
	assertPreflightIdentifier(attemptId, "attemptId");
	return { preflightId, attemptId };
}

function parsePreflightResolve(value: unknown): PreflightResolveInput {
	const input = requiredRecord(value, "preflight/resolve");
	onlyKeys(input, "preflight/resolve", ["preflightId", "state", "answerDigest", "attemptId"]);
	const preflightId = requiredString(input, "preflightId", 200);
	const state = requiredString(input, "state", 32);
	const attemptId = requiredString(input, "attemptId", 200);
	assertPreflightIdentifier(preflightId, "preflightId");
	assertPreflightIdentifier(attemptId, "attemptId");
	if (!["pending", "analysis_only"].includes(state)) {
		throw new KernelRequestError(
			"invalid_payload",
			"state must be pending or analysis_only; launched is committed only by atomic mission launch.",
		);
	}
	const answerDigest = input.answerDigest === undefined ? undefined : requiredString(input, "answerDigest", 64);
	if (answerDigest !== undefined) {
		assertDigest(answerDigest, "answerDigest");
	}
	if (state === "pending" && answerDigest === undefined) {
		throw new KernelRequestError("invalid_payload", "Resuming pending requires answerDigest.");
	}
	if (state === "analysis_only" && answerDigest !== undefined) {
		throw new KernelRequestError("invalid_payload", "analysis_only must not include answerDigest.");
	}
	return {
		preflightId,
		state: state as PreflightResolveInput["state"],
		...(answerDigest === undefined ? {} : { answerDigest }),
		attemptId,
	};
}

function parsePreflightFail(value: unknown): PreflightFailInput {
	const input = requiredRecord(value, "preflight/fail");
	onlyKeys(input, "preflight/fail", ["preflightId", "failureCode", "attemptId"]);
	const preflightId = requiredString(input, "preflightId", 200);
	const failureCode = requiredString(input, "failureCode", 32);
	const attemptId = requiredString(input, "attemptId", 200);
	assertPreflightIdentifier(preflightId, "preflightId");
	assertPreflightFailureCode(failureCode);
	assertPreflightIdentifier(attemptId, "attemptId");
	return { preflightId, failureCode, attemptId };
}

function parseProposal(value: unknown): ProposedIdea {
	const proposal = requiredRecord(value, "hypothesis");
	const strategy = requiredString(proposal, "strategy", 20);
	if (strategy !== "explore" && strategy !== "exploit" && strategy !== "verify") {
		throw new KernelRequestError("invalid_payload", "strategy must be explore, exploit, or verify.");
	}
	return {
		title: requiredString(proposal, "title", 2_000),
		hypothesis: requiredString(proposal, "hypothesis", 20_000),
		rationale: requiredString(proposal, "rationale", 20_000),
		implementationPlan: requiredString(proposal, "implementationPlan", 40_000),
		predictedEffect: requiredString(proposal, "predictedEffect", 20_000),
		strategy,
		parentIdeaIds:
			proposal.parentIdeaIds === undefined ? undefined : stringArray(proposal, "parentIdeaIds").slice(0, 32),
	};
}

function parseEvidenceQuery(value: unknown): EvidenceQueryInput {
	const query = requiredRecord(value, "query");
	const kind = requiredString(query, "kind", 20);
	if (!["events", "experiments", "generations", "reflections", "updates"].includes(kind)) {
		throw new KernelRequestError("invalid_payload", `Unknown evidence query kind: ${kind}`);
	}
	return {
		kind: kind as EvidenceQueryInput["kind"],
		campaignId: optionalString(query, "campaignId", 1_000),
		generationId: optionalString(query, "generationId", 1_000),
		experimentId: optionalString(query, "experimentId", 1_000),
		cursor: optionalString(query, "cursor", 100),
		limit:
			query.limit === undefined
				? undefined
				: requiredNumber(query, "limit", { minimum: 1, maximum: 20, integer: true }),
	};
}

function parseAgentModel(config: Record<string, unknown>): Campaign["config"]["agentModel"] {
	if (config.agentModel === undefined) {
		return undefined;
	}
	const policy = requiredRecord(config.agentModel, "agentModel");
	const provider = requiredString(policy, "provider", 200);
	const model = requiredString(policy, "model", 1_000);
	const thinkingLevel = requiredString(policy, "thinkingLevel", 20);
	if (provider !== provider.trim() || model !== model.trim()) {
		throw new KernelRequestError(
			"invalid_payload",
			"agentModel provider and model must not contain outer whitespace.",
		);
	}
	if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
		throw new KernelRequestError(
			"invalid_payload",
			"agentModel thinkingLevel must be off, minimal, low, medium, high, xhigh, or max.",
		);
	}
	return {
		provider,
		model,
		thinkingLevel: thinkingLevel as NonNullable<Campaign["config"]["agentModel"]>["thinkingLevel"],
	};
}

function parseCalibration(value: unknown): CampaignCalibrationInput {
	const input = requiredRecord(value, "calibration");
	const sourceBundle = parseSourceBundle(input);
	const metric = requiredRecord(input.metric, "metric");
	const config = requiredRecord(input.config, "config");
	const evaluator = requiredRecord(config.evaluator, "evaluator");
	const budget = requiredRecord(config.budget, "budget");
	const agentModel = parseAgentModel(config);
	const maxInputTokens = optionalNumber(budget, "maxInputTokens", {
		minimum: 1,
		maximum: Number.MAX_SAFE_INTEGER,
		integer: true,
	});
	const maxOutputTokens = optionalNumber(budget, "maxOutputTokens", {
		minimum: 1,
		maximum: Number.MAX_SAFE_INTEGER,
		integer: true,
	});
	const maxCostUsd = optionalNumber(budget, "maxCostUsd", {
		minimum: Number.MIN_VALUE,
		maximum: Number.MAX_SAFE_INTEGER,
	});
	const direction = requiredString(metric, "direction", 20);
	if (direction !== "maximize" && direction !== "minimize") {
		throw new KernelRequestError("invalid_payload", "direction must be maximize or minimize.");
	}
	let protectedPaths: string[];
	try {
		protectedPaths = stringArray(evaluator, "protectedPaths").map((path) =>
			normalizeRepositoryRelativePath(path, "protectedPaths entry"),
		);
	} catch (error) {
		throw new KernelRequestError("invalid_payload", errorMessage(error));
	}
	const controlCwd = requiredString(evaluator, "controlCwd", 10_000);
	if (isAbsolute(controlCwd) || controlCwd.split(/[\\/]/).some((segment) => segment === "..")) {
		throw new KernelRequestError("invalid_payload", "controlCwd must stay inside the repository.");
	}
	let scoreBounds: Campaign["config"]["evaluator"]["scoreBounds"];
	if (evaluator.scoreBounds !== undefined) {
		const bounds = requiredRecord(evaluator.scoreBounds, "evaluator.scoreBounds");
		onlyKeys(bounds, "evaluator.scoreBounds", ["min", "max"]);
		const min = requiredNumber(bounds, "min", {
			minimum: -Number.MAX_VALUE,
			maximum: Number.MAX_VALUE,
		});
		const max = requiredNumber(bounds, "max", {
			minimum: -Number.MAX_VALUE,
			maximum: Number.MAX_VALUE,
		});
		if (min >= max) {
			throw new KernelRequestError("invalid_payload", "evaluator.scoreBounds.min must be less than max.");
		}
		scoreBounds = { min, max };
	}
	return {
		goal: requiredString(input, "goal"),
		metric: {
			name: requiredString(metric, "name", 1_000),
			direction,
			minimumImprovement: requiredNumber(metric, "minimumImprovement", {
				minimum: 0,
				maximum: Number.MAX_SAFE_INTEGER,
			}),
		},
		config: {
			workers: requiredNumber(config, "workers", { minimum: 1, maximum: 32, integer: true }),
			agentTimeoutMs: requiredNumber(config, "agentTimeoutMs", {
				minimum: 1_000,
				maximum: 24 * 60 * 60 * 1_000,
				integer: true,
			}),
			...(agentModel === undefined ? {} : { agentModel }),
			evaluator: {
				command: requiredString(evaluator, "command", 10_000),
				controlCwd,
				samples: requiredNumber(evaluator, "samples", { minimum: 2, maximum: 100, integer: true }),
				warmups: requiredNumber(evaluator, "warmups", { minimum: 0, maximum: 100, integer: true }),
				timeoutMs: requiredNumber(evaluator, "timeoutMs", {
					minimum: 100,
					maximum: 24 * 60 * 60 * 1_000,
					integer: true,
				}),
				protectedPaths,
				...(scoreBounds === undefined ? {} : { scoreBounds }),
			},
			budget: {
				maxGenerations: requiredNumber(budget, "maxGenerations", {
					minimum: 1,
					maximum: 10_000,
					integer: true,
				}),
				maxExperiments: requiredNumber(budget, "maxExperiments", {
					minimum: 1,
					maximum: 100_000,
					integer: true,
				}),
				maxWallClockMs: requiredNumber(budget, "maxWallClockMs", {
					minimum: 1_000,
					maximum: 365 * 24 * 60 * 60 * 1_000,
					integer: true,
				}),
				maxConsecutivePlateaus: requiredNumber(budget, "maxConsecutivePlateaus", {
					minimum: 1,
					maximum: 10_000,
					integer: true,
				}),
				maxFailures: requiredNumber(budget, "maxFailures", {
					minimum: 1,
					maximum: 100_000,
					integer: true,
				}),
				...(maxInputTokens === undefined ? {} : { maxInputTokens }),
				...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
				...(maxCostUsd === undefined ? {} : { maxCostUsd }),
			},
		},
		...(sourceBundle ?? {}),
	};
}

interface ParsedLaunch {
	calibration: CampaignCalibrationInput;
	launch?: ConversationalMissionLaunch;
}

function parseLaunch(value: unknown, requestId: string): ParsedLaunch {
	const input = requiredRecord(value, "launch");
	const calibration = parseCalibration(input);
	const identityFieldCount = ["preflightId", "attemptId", "launchOperationId", "inputDigest"].filter(
		(key) => input[key] !== undefined,
	).length;
	if (identityFieldCount === 0) {
		return { calibration };
	}
	if (identityFieldCount !== 4) {
		throw new KernelRequestError(
			"invalid_payload",
			"Conversational launch identity requires preflightId, attemptId, launchOperationId, and inputDigest together.",
		);
	}
	const preflightId = requiredString(input, "preflightId", 200);
	const attemptId = requiredString(input, "attemptId", 200);
	const launchOperationId = requiredString(input, "launchOperationId", 200);
	const inputDigest = requiredString(input, "inputDigest", 64);
	assertPreflightIdentifier(preflightId, "preflightId");
	assertPreflightIdentifier(attemptId, "attemptId");
	assertPreflightIdentifier(launchOperationId, "launchOperationId");
	assertDigest(inputDigest, "inputDigest");
	const identity = preflightLaunchIdentity(preflightId, calibration);
	if (
		identity.launchOperationId !== launchOperationId ||
		identity.inputDigest !== inputDigest ||
		identity.requestId !== requestId
	) {
		throw new KernelRequestError(
			"idempotency_conflict",
			"Launch request identity does not match its preflight and canonical persisted input.",
		);
	}
	return {
		calibration,
		launch: {
			preflightId,
			attemptId,
			launchOperationId,
			inputDigest,
			requestId,
			requestFingerprint: identity.requestFingerprint,
		},
	};
}

type KernelControlCommand = "start" | "resume" | "pause" | "stop" | "note";

function isKernelControlCommand(command: KernelCommand): command is KernelControlCommand {
	return ["start", "resume", "pause", "stop", "note"].includes(command);
}

function parseKernelControlAction(command: KernelControlCommand, value: unknown): ResearchControlAction {
	if (command === "start" || command === "resume" || command === "pause") {
		return { kind: command };
	}
	if (command === "stop") {
		const payload = value === undefined ? {} : requiredRecord(value, "stop");
		const reason =
			typeof payload.reason === "string" && payload.reason.trim()
				? payload.reason.slice(0, 10_000).trim()
				: "Stopped by operator";
		return { kind: "stop", reason };
	}
	const payload = requiredRecord(value, "note");
	const hypothesis = payload.hypothesis === undefined ? undefined : parseProposal(payload.hypothesis);
	return {
		kind: "note",
		message: requiredString(payload, "message").trim(),
		hypothesis,
	};
}

async function kernelControlResult(
	runtime: IsoRuntime,
	command: KernelControlCommand,
	receipt: CurrentResearchControlReceipt,
): Promise<unknown> {
	const outcome = receipt.outcome;
	if (command === "start") {
		if (outcome.kind !== "start") {
			throw new Error("Stored start control receipt has an incompatible outcome.");
		}
		return { research: { runId: outcome.runId, started: outcome.started } };
	}
	if (command === "resume") {
		if (outcome.kind !== "resume") {
			throw new Error("Stored resume control receipt has an incompatible outcome.");
		}
		if (!outcome.missionId) {
			return { research: { runId: outcome.runId, started: outcome.started } };
		}
		const state = (await runtime.snapshot()).state;
		const storedMission = state.missions.find((mission) => mission.id === outcome.missionId);
		const mission: MissionReceipt = {
			missionId: outcome.missionId,
			preflightId: storedMission?.preflightId,
			launchOperationId: storedMission?.launchOperationId,
			phase: outcome.missionPhase ?? storedMission?.phase ?? "accepted",
			accepted: false,
			campaignId: outcome.campaignId,
		};
		return { mission };
	}
	if (command === "pause") {
		if (outcome.kind !== "pause") {
			throw new Error("Stored pause control receipt has an incompatible outcome.");
		}
		return { paused: true };
	}
	if (command === "stop") {
		if (outcome.kind !== "stop") {
			throw new Error("Stored stop control receipt has an incompatible outcome.");
		}
		return { stopped: true };
	}
	if (outcome.kind !== "note") {
		throw new Error("Stored note control receipt has an incompatible outcome.");
	}
	const state = (await runtime.snapshot()).state;
	const note = state.operatorNotes.find((candidate) => candidate.id === outcome.noteId);
	if (!note) {
		throw new Error(`Stored operator note ${outcome.noteId} is missing.`);
	}
	return { note: structuredClone(note) satisfies OperatorNote };
}

function matchesCalibration(campaign: Campaign, input: CampaignCalibrationInput, repoRoot: string): boolean {
	const expectedEvaluator = {
		...input.config.evaluator,
		controlCwd: resolve(repoRoot, input.config.evaluator.controlCwd),
	};
	const evaluatorRelative = relative(repoRoot, expectedEvaluator.controlCwd);
	if (evaluatorRelative.startsWith(`..${sep}`) || evaluatorRelative === ".." || isAbsolute(evaluatorRelative)) {
		return false;
	}
	return (
		campaign.goal === input.goal &&
		isDeepStrictEqual(campaign.metric, input.metric) &&
		campaign.config.workers === input.config.workers &&
		campaign.config.agentTimeoutMs === input.config.agentTimeoutMs &&
		isDeepStrictEqual(campaign.config.agentModel, input.config.agentModel) &&
		isDeepStrictEqual(campaign.config.evaluator, expectedEvaluator) &&
		isDeepStrictEqual(campaign.config.budget, input.config.budget) &&
		(input.sourceCommit === undefined ||
			(campaign.sourceCommit === input.sourceCommit &&
				campaign.sourceHeadCommit === input.sourceHeadCommit &&
				campaign.sourceSnapshotRef === input.sourceSnapshotRef &&
				campaign.sourceHadLocalChanges === input.sourceHadLocalChanges &&
				isDeepStrictEqual(campaign.sourceSnapshotPaths ?? [], input.sourceSnapshotPaths ?? []) &&
				campaign.dependencyDigest === input.dependencyDigest))
	);
}

function parseLock(value: string): LockRecord | undefined {
	try {
		const parsed: unknown = JSON.parse(value);
		if (
			isRecord(parsed) &&
			typeof parsed.pid === "number" &&
			typeof parsed.token === "string" &&
			typeof parsed.startedAt === "string"
		) {
			return { pid: parsed.pid, token: parsed.token, startedAt: parsed.startedAt };
		}
	} catch {
		return undefined;
	}
	return undefined;
}

function processExists(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return isRecord(error) && error.code === "EPERM";
	}
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function acquireLock(paths: KernelPaths): Promise<LockRecord> {
	mkdirSync(paths.directory, { recursive: true, mode: 0o700 });
	const directoryStat = lstatSync(paths.directory);
	if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
		throw new Error(`ISO state directory must be a real directory, not a symlink: ${paths.directory}`);
	}
	chmodSync(paths.directory, 0o700);
	const deadline = Date.now() + LOCK_WAIT_MS;
	while (true) {
		try {
			const descriptor = openSync(paths.lock, "wx", 0o600);
			const record: LockRecord = {
				pid: process.pid,
				token: randomUUID(),
				startedAt: new Date().toISOString(),
			};
			writeFileSync(descriptor, JSON.stringify(record));
			closeSync(descriptor);
			return record;
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") {
				throw error;
			}
			let lockStat: ReturnType<typeof lstatSync>;
			try {
				lockStat = lstatSync(paths.lock);
			} catch (statError) {
				if (isRecord(statError) && statError.code === "ENOENT") {
					continue;
				}
				throw statError;
			}
			if (lockStat.isSymbolicLink() || !lockStat.isFile()) {
				throw new Error(`ISO kernel lock must be a regular file, not a symlink: ${paths.lock}`);
			}
			let existing: LockRecord | undefined;
			try {
				existing = parseLock(readFileSync(paths.lock, "utf8"));
			} catch {
				await delay(50);
				continue;
			}
			if (existing && processExists(existing.pid)) {
				if (Date.now() >= deadline) {
					throw new Error(`ISO kernel lock is held by live process ${existing.pid}.`);
				}
				await delay(50);
				continue;
			}
			if (!existing && Date.now() < deadline) {
				await delay(50);
				continue;
			}
			rmSync(paths.lock, { force: true });
		}
	}
}

function releaseLock(paths: KernelPaths, lock: LockRecord): void {
	try {
		const current = parseLock(readFileSync(paths.lock, "utf8"));
		if (current?.token === lock.token) {
			rmSync(paths.lock, { force: true });
		}
	} catch {
		// The lock may already have been removed during process teardown.
	}
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

async function runLockedKernel(repoRoot: string, paths: KernelPaths): Promise<void> {
	rmSync(paths.socket, { force: true });
	const store = new IsoStore(repoRoot);
	const runtime = new IsoRuntime(repoRoot, store);
	const pending = new Map<string, Promise<unknown>>();
	let mutationQueue: Promise<void> = Promise.resolve();
	let controlQueue: Promise<void> = Promise.resolve();
	let closing = false;
	let dashboardPromise: Promise<DashboardServer> | undefined;
	let runtimeShutdownPromise: Promise<void> | undefined;
	let researchRecoveryPromise: Promise<void> | undefined;
	let preflightWatchdog: NodeJS.Timeout | undefined;

	const dashboard = (): Promise<DashboardServer> => {
		if (!dashboardPromise) {
			const mutationExecutor = <T>(operation: () => Promise<T>): Promise<T> => runControlMutation(operation);
			dashboardPromise = startDashboard(runtime, {
				host: "127.0.0.1",
				port: 4010,
				mutationExecutor,
			})
				.catch((error: unknown) => {
					if (isRecord(error) && error.code === "EADDRINUSE") {
						return startDashboard(runtime, {
							host: "127.0.0.1",
							port: 0,
							mutationExecutor,
						});
					}
					throw error;
				})
				.catch((error) => {
					dashboardPromise = undefined;
					throw error;
				});
		}
		return dashboardPromise;
	};

	const closeDashboard = async (): Promise<void> => {
		if (!dashboardPromise) {
			return;
		}
		try {
			const activeDashboard = await dashboardPromise;
			await activeDashboard.close();
		} finally {
			dashboardPromise = undefined;
		}
	};

	const shutdownRuntime = (): Promise<void> => {
		runtimeShutdownPromise ??= runtime.shutdown();
		return runtimeShutdownPromise;
	};

	const ensureResearchRunning = (): Promise<void> => {
		if (researchRecoveryPromise) {
			return researchRecoveryPromise;
		}
		const operation = (async () => {
			while (!closing) {
				const snapshot = await runtime.snapshot();
				if (snapshot.activeCampaign?.runIntent !== "running") {
					return;
				}
				const receipt = await runtime.resumePersistedResearch();
				if (receipt.runId !== "external") {
					return;
				}
				await delay(1_000);
			}
		})();
		researchRecoveryPromise = operation;
		void operation.then(
			() => {
				if (researchRecoveryPromise === operation) {
					researchRecoveryPromise = undefined;
				}
			},
			() => {
				if (researchRecoveryPromise === operation) {
					researchRecoveryPromise = undefined;
				}
			},
		);
		return operation;
	};

	const runMutation = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = mutationQueue.then(() => {
			if (closing) {
				throw new KernelRequestError("shutting_down", "ISO kernel is shutting down.");
			}
			return operation();
		});
		mutationQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const runControlMutation = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = controlQueue.then(() => {
			if (closing) {
				throw new KernelRequestError("shutting_down", "ISO kernel is shutting down.");
			}
			return operation();
		});
		controlQueue = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};

	const execute = async (request: WireRequest): Promise<unknown> => {
		if (request.command === "ping") {
			return { pid: process.pid, startedAt: runtime.startedAt, protocol: PROTOCOL };
		}
		if (request.command === "status") {
			return runtime.snapshot();
		}
		if (request.command === "summary") {
			const payload = request.payload === undefined ? {} : requiredRecord(request.payload, "summary");
			return runtime.summary(optionalString(payload, "campaignId", 1_000));
		}
		if (request.command === "query") {
			return runtime.queryEvidence(parseEvidenceQuery(request.payload));
		}
		if (request.command === "preflight/status") {
			const lookup = parsePreflightLookup(request.payload);
			const receipt = store.getPreflight(lookup);
			if (!receipt) {
				throw new PreflightError("preflight_not_found", "No preflight receipt matches that lookup.");
			}
			return { receipt };
		}
		if (request.command === "preflight/continuation") {
			const continuation = store.getPendingPreflightContinuation(parsePreflightContinuation(request.payload));
			return { continuation };
		}
		if (request.command === "champion") {
			const payload = request.payload === undefined ? {} : requiredRecord(request.payload, "champion");
			return { champion: await runtime.championHandoff(optionalString(payload, "campaignId", 1_000)) };
		}
		if (request.command === "dashboard") {
			const activeDashboard = await dashboard();
			return { url: activeDashboard.url };
		}
		const pendingKey = `${request.command}:${request.id}:${canonicalPayloadDigest(
			"iso.kernel.pending.v1",
			request.payload ?? null,
		)}`;
		const existing = pending.get(pendingKey);
		if (existing) {
			return existing;
		}
		let operation: Promise<unknown>;
		if (request.command === "shutdown") {
			closing = true;
			operation = (async () => {
				await closeDashboard();
				await shutdownRuntime();
				return { shuttingDown: true };
			})();
		} else if (isKernelControlCommand(request.command)) {
			const controlCommand = request.command;
			const action = parseKernelControlAction(controlCommand, request.payload);
			operation = runControlMutation(async () => {
				const receipt = await runtime.applyCurrentControl({
					actionId: `${controlCommand}:${canonicalPayloadDigest("iso.kernel.control-request.v1", {
						command: controlCommand,
						requestId: request.id,
					})}`,
					actionFingerprint: commandFingerprint(controlCommand, action),
					action,
				});
				if ((receipt.outcome.kind === "start" || receipt.outcome.kind === "resume") && receipt.outcome.campaignId) {
					const snapshot = await runtime.snapshot();
					if (snapshot.activeCampaign?.runIntent === "running") {
						void ensureResearchRunning().catch(() => undefined);
					}
				}
				return kernelControlResult(runtime, controlCommand, receipt);
			});
		} else {
			operation = runMutation<unknown>(() => {
				const idempotencyKey = `kernel:v1:${request.command}:${request.id}`;
				if (request.command === "preflight/open") {
					const input = parsePreflightOpen(request.payload);
					return store
						.openPreflightOnce(idempotencyKey, commandFingerprint(request.command, input), input)
						.then(({ value: receipt }) => ({ receipt }));
				}
				if (request.command === "preflight/begin") {
					const input = parsePreflightBegin(request.payload);
					return store
						.beginPreflightOnce(idempotencyKey, leaseReplayFingerprint(request.command, input), input)
						.then(({ value: receipt }) => ({ receipt }));
				}
				if (request.command === "preflight/claim") {
					const input = parsePreflightClaim(request.payload);
					return store
						.claimPreflightOnce(idempotencyKey, commandFingerprint(request.command, input), input)
						.then(({ value: receipt }) => ({ receipt }));
				}
				if (request.command === "preflight/renew") {
					const input = parsePreflightRenew(request.payload);
					return store.renewPreflightAttempt(input).then((receipt) => ({ receipt }));
				}
				if (request.command === "preflight/resume") {
					const input = parsePreflightResume(request.payload);
					return store
						.resumePreflightOnce(idempotencyKey, leaseReplayFingerprint(request.command, input), input)
						.then(({ value: receipt }) => ({ receipt }));
				}
				if (request.command === "preflight/defer") {
					const input = parsePreflightDefer(request.payload);
					return store
						.deferPreflightOnce(idempotencyKey, commandFingerprint(request.command, input), input)
						.then(({ value: receipt }) => ({ receipt }));
				}
				if (request.command === "preflight/correct") {
					const input = parsePreflightCorrect(request.payload);
					return store
						.correctPreflightOnce(idempotencyKey, commandFingerprint(request.command, input), input)
						.then(({ value: receipt }) => ({ receipt }));
				}
				if (request.command === "preflight/resolve") {
					const input = parsePreflightResolve(request.payload);
					return store
						.resolvePreflightOnce(idempotencyKey, commandFingerprint(request.command, input), input)
						.then(({ value: receipt }) => ({ receipt }));
				}
				if (request.command === "preflight/fail") {
					const input = parsePreflightFail(request.payload);
					return store
						.failPreflightOnce(idempotencyKey, commandFingerprint(request.command, input), input)
						.then(({ value: receipt }) => ({ receipt }));
				}
				if (request.command === "launch") {
					const parsed = parseLaunch(request.payload, request.id);
					if (parsed.launch) {
						return runtime.launchMissionWithPreflight(parsed.calibration, parsed.launch);
					}
					return runtime.launchMissionFromKernel(parsed.calibration, {
						requestId: request.id,
						requestFingerprint: commandFingerprint(request.command, parsed.calibration),
					});
				}
				return store.executeOnce(`kernel:v1:${request.command}:${request.id}`, async () => {
					switch (request.command) {
						case "calibrate": {
							const input = parseCalibration(request.payload);
							const snapshot = await runtime.snapshot();
							const campaign = snapshot.activeCampaign;
							if (
								campaign &&
								!["completed", "stopped", "failed"].includes(campaign.status) &&
								matchesCalibration(campaign, input, repoRoot)
							) {
								return { campaign };
							}
							return {
								campaign: await runtime.calibrateCampaign({
									...input,
									expectedAdmissionEpoch: snapshot.state.admissionEpoch,
								}),
							};
						}
						case "ack-updates": {
							const payload = requiredRecord(request.payload, "ack-updates");
							const cursor = requiredNumber(payload, "cursor", {
								minimum: 0,
								maximum: Number.MAX_SAFE_INTEGER,
								integer: true,
							});
							const acknowledged = await runtime.acknowledgeMaterialUpdates(
								cursor,
								optionalString(payload, "missionId", 1_000),
							);
							return { cursor: acknowledged };
						}
						case "steer": {
							const payload = requiredRecord(request.payload, "steer");
							await runtime.steer(
								requiredString(payload, "workerId", 1_000),
								requiredString(payload, "message", 100_000),
							);
							return { steered: true };
						}
						case "abort": {
							const payload = requiredRecord(request.payload, "abort");
							await runtime.abort(requiredString(payload, "workerId", 1_000));
							return { aborted: true };
						}
						default:
							throw new KernelRequestError("unknown_command", `Unknown command ${request.command}.`);
					}
				});
			});
		}
		pending.set(pendingKey, operation);
		void operation.finally(() => pending.delete(pendingKey)).catch(() => undefined);
		return operation;
	};

	const server = createServer(async (request, response) => {
		let requestId = "invalid";
		try {
			if (request.method !== "POST" || request.url !== "/v1/command") {
				throw new KernelRequestError("not_found", "Unknown ISO kernel endpoint.");
			}
			const wireRequest = parseWireRequest(await readBody(request));
			requestId = wireRequest.id;
			const result = await execute(wireRequest);
			const envelope: KernelResponse<unknown> = {
				protocol: PROTOCOL,
				id: requestId,
				ok: true,
				result,
			};
			sendJson(response, 200, envelope);
			if (closing) {
				server.close();
			}
		} catch (error) {
			const code =
				error instanceof KernelRequestError ||
				error instanceof PreflightError ||
				error instanceof ControlConflictError
					? error.code
					: error instanceof IdempotencyConflictError
						? "idempotency_conflict"
						: "internal_error";
			const envelope: KernelResponse<never> = {
				protocol: PROTOCOL,
				id: requestId,
				ok: false,
				error: { code, message: errorMessage(error) },
			};
			sendJson(response, code === "not_found" ? 404 : code === "internal_error" ? 500 : 400, envelope);
		}
	});

	const terminate = (): void => {
		if (closing) {
			return;
		}
		closing = true;
		if (preflightWatchdog !== undefined) {
			clearInterval(preflightWatchdog);
			preflightWatchdog = undefined;
		}
		void Promise.all([closeDashboard(), shutdownRuntime()])
			.catch((error: unknown) => console.error(`ISO kernel shutdown failed: ${errorMessage(error)}`))
			.finally(() => server.close());
	};
	process.once("SIGINT", terminate);
	process.once("SIGTERM", terminate);

	try {
		await runtime.reconcileAfterRestart();
		await store.expirePreflightAttempts();
		await store.failStaleDirectPreflights();
		await listen(server, paths.socket);
		chmodSync(paths.socket, 0o600);
		preflightWatchdog = setInterval(() => {
			void store
				.expirePreflightAttempts()
				.then(() => store.failStaleDirectPreflights())
				.catch((error: unknown) => console.error(`ISO preflight watchdog failed: ${errorMessage(error)}`));
		}, 5_000);
		preflightWatchdog.unref();
		console.log(`ISO kernel ${process.pid} listening on ${paths.socket}`);
		const recovered = await runtime.snapshot();
		const recoveredMission = recovered.state.missions
			.slice()
			.reverse()
			.find((mission) => !["completed", "stopped", "failed"].includes(mission.phase));
		if (recoveredMission?.desiredState === "running") {
			void runtime.resumePersistedMission().catch((error: unknown) => {
				console.error(`ISO mission recovery failed: ${errorMessage(error)}`);
			});
		} else if (recovered.activeCampaign?.runIntent === "running") {
			void ensureResearchRunning().catch((error: unknown) => {
				console.error(`ISO research recovery failed: ${errorMessage(error)}`);
			});
		}
		await new Promise<void>((resolve, reject) => {
			server.once("close", resolve);
			server.once("error", reject);
		});
	} finally {
		if (preflightWatchdog !== undefined) {
			clearInterval(preflightWatchdog);
			preflightWatchdog = undefined;
		}
		await closeDashboard().catch((error: unknown) => {
			console.error(`ISO dashboard shutdown failed: ${errorMessage(error)}`);
		});
		await shutdownRuntime().catch((error: unknown) => {
			console.error(`ISO runtime shutdown failed: ${errorMessage(error)}`);
		});
	}
}

export async function runKernel(repoRoot: string): Promise<void> {
	if (process.platform === "win32") {
		throw new Error("The ISO local kernel currently requires Unix domain sockets.");
	}
	const paths = pathsFor(repoRoot);
	const lock = await acquireLock(paths);
	const cleanup = (): void => {
		rmSync(paths.socket, { force: true });
		releaseLock(paths, lock);
	};
	process.once("exit", cleanup);
	try {
		await runLockedKernel(repoRoot, paths);
	} finally {
		process.off("exit", cleanup);
		cleanup();
	}
}
