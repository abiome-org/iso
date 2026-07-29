import { createHash } from "node:crypto";
import type { MissionReceipt } from "./types.ts";

export const PREFLIGHT_MAX_IDENTIFIER_BYTES = 200;
export const PREFLIGHT_MAX_CORRECTIONS = 2;
export const PREFLIGHT_MAX_QUESTION_BYTES = 2_048;
export const PREFLIGHT_ATTEMPT_TTL_MS = 60_000;
export const DIRECT_PREFLIGHT_ORPHAN_TTL_MS = 7 * 24 * 60 * 60 * 1_000;

export const PREFLIGHT_REASONS = ["metric_ambiguity", "credentials", "material_cost", "analysis_only"] as const;

export const PREFLIGHT_FAILURE_CODES = ["postcondition_exhausted", "kernel_unavailable", "launch_failed"] as const;

export type PreflightReason = (typeof PREFLIGHT_REASONS)[number];
export type PreflightFailureCode = (typeof PREFLIGHT_FAILURE_CODES)[number];
export type PreflightState = "pending" | "needs_input" | "analysis_only" | "launched" | "failed";
export type PreflightResolution = "pending" | "analysis_only" | "launched";

export interface PreflightReceipt {
	preflightId: string;
	intentKey: string;
	objectiveDigest: string;
	state: PreflightState;
	reason?: PreflightReason;
	failureCode?: PreflightFailureCode;
	correctionCount: number;
	missionId?: string;
	questionDigest?: string;
	answerDigest?: string;
	createdAt: string;
	updatedAt: string;
}

export interface PreflightOpenInput {
	intentKey: string;
	objectiveDigest: string;
}

export interface PreflightAttemptIdentity {
	attemptId: string;
	sessionDigest: string;
	leaseTtlMs: number;
}

export interface PreflightBeginInput extends PreflightOpenInput, PreflightAttemptIdentity {}

export interface PreflightClaimInput extends PreflightAttemptIdentity {
	preflightId: string;
}

export interface PreflightRenewInput {
	preflightId: string;
	attemptId: string;
	leaseTtlMs: number;
}

export interface PreflightResumeInput extends PreflightAttemptIdentity {
	preflightId: string;
	answerDigest: string;
}

export interface PreflightContinuationLookup {
	sessionDigest: string;
}

export type PreflightLookup = { preflightId: string } | { intentKey: string };

export interface PreflightDeferInput {
	preflightId: string;
	reason: Exclude<PreflightReason, "analysis_only">;
	questionDigest: string;
	attemptId: string;
}

export interface PreflightResolveInput {
	preflightId: string;
	state: PreflightResolution;
	missionId?: string;
	answerDigest?: string;
	attemptId: string;
}

export interface PreflightCorrectInput {
	preflightId: string;
	attemptId: string;
}

export interface PreflightFailInput {
	preflightId: string;
	failureCode: PreflightFailureCode;
	attemptId: string;
}

export interface PreflightContinuation {
	receipt: PreflightReceipt;
	correctionCount: number;
}

export interface PreflightLaunchIdentity {
	inputDigest: string;
	launchOperationId: string;
	requestId: string;
	requestFingerprint: string;
}

export interface DurableMissionLaunchReceipt {
	mission: MissionReceipt;
	preflight: PreflightReceipt;
}

export interface PreflightDeferredMarker {
	version: 1;
	preflightId: string;
	intentKey: string;
	objectiveDigest?: string;
	state: "needs_input";
	reason: Exclude<PreflightReason, "analysis_only">;
	questionDigest: string;
	question?: string;
	at: string;
}

export interface PreflightResumedMarker {
	version: 1;
	preflightId: string;
	answerDigest: string;
	at: string;
}

export interface PreflightImage {
	data: string;
	mimeType: string;
}

export class PreflightError extends Error {
	readonly code: "invalid_payload" | "preflight_not_found" | "preflight_conflict" | "invalid_transition";

	constructor(
		code: "invalid_payload" | "preflight_not_found" | "preflight_conflict" | "invalid_transition",
		message: string,
	) {
		super(message);
		this.name = "PreflightError";
		this.code = code;
	}
}

function canonicalJson(value: unknown, seen: WeakSet<object>): string {
	if (value === null) {
		return "null";
	}
	if (typeof value === "string" || typeof value === "boolean") {
		return JSON.stringify(value);
	}
	if (typeof value === "number") {
		if (!Number.isFinite(value)) {
			throw new PreflightError("invalid_payload", "Canonical payload numbers must be finite.");
		}
		return Object.is(value, -0) ? "0" : JSON.stringify(value);
	}
	if (Array.isArray(value)) {
		if (seen.has(value)) {
			throw new PreflightError("invalid_payload", "Canonical payloads must not contain cycles.");
		}
		seen.add(value);
		const result = `[${Array.from(value, (entry) => (entry === undefined ? "null" : canonicalJson(entry, seen))).join(
			",",
		)}]`;
		seen.delete(value);
		return result;
	}
	if (typeof value === "object") {
		if (seen.has(value)) {
			throw new PreflightError("invalid_payload", "Canonical payloads must not contain cycles.");
		}
		seen.add(value);
		const record = value as Record<string, unknown>;
		const fields = Object.keys(record)
			.filter((key) => record[key] !== undefined)
			.sort()
			.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], seen)}`);
		seen.delete(value);
		return `{${fields.join(",")}}`;
	}
	throw new PreflightError("invalid_payload", "Canonical payloads must contain only JSON values.");
}

export function canonicalPayloadDigest(domain: string, value: unknown): string {
	if (domain.trim() === "") {
		throw new PreflightError("invalid_payload", "Digest domain must not be empty.");
	}
	return createHash("sha256")
		.update(domain, "utf8")
		.update("\0", "utf8")
		.update(canonicalJson(value, new WeakSet()), "utf8")
		.digest("hex");
}

export function preflightImageDigest(image: PreflightImage): string {
	return createHash("sha256")
		.update("iso.preflight.image.v1\0", "utf8")
		.update(image.mimeType, "utf8")
		.update("\0", "utf8")
		.update(Buffer.from(image.data, "base64"))
		.digest("hex");
}

export function preflightTurnContentDigest(prompt: string, images: readonly PreflightImage[] = []): string {
	const digest = createHash("sha256")
		.update("iso.preflight.turn-content.v1\0", "utf8")
		.update(String(Buffer.byteLength(prompt)), "utf8")
		.update("\0", "utf8")
		.update(prompt, "utf8");
	for (const image of images) {
		digest.update("\0", "utf8").update(preflightImageDigest(image), "utf8");
	}
	return digest.digest("hex");
}

export function preflightIntentKey(sessionId: string, branchAnchor: string, contentDigest: string): string {
	assertDigest(contentDigest, "contentDigest");
	return createHash("sha256")
		.update("iso.preflight.intent.v2\0", "utf8")
		.update(sessionId, "utf8")
		.update("\0", "utf8")
		.update(branchAnchor, "utf8")
		.update("\0", "utf8")
		.update(contentDigest, "utf8")
		.digest("hex");
}

export function preflightLaunchIdentity(preflightId: string, persistedInput: unknown): PreflightLaunchIdentity {
	assertPreflightIdentifier(preflightId, "preflightId");
	const inputDigest = canonicalPayloadDigest("iso.mission.input.v1", persistedInput);
	const launchOperationId = `launch_${createHash("sha256")
		.update("iso.launch.operation.v1\0", "utf8")
		.update(preflightId, "utf8")
		.update("\0", "utf8")
		.update(inputDigest, "utf8")
		.digest("hex")}`;
	const requestFingerprint = canonicalPayloadDigest("iso.kernel.launch.v1", {
		preflightId,
		inputDigest,
		launchOperationId,
		input: persistedInput,
	});
	return {
		inputDigest,
		launchOperationId,
		requestId: `preflight:launch:${preflightId}:${inputDigest}`,
		requestFingerprint,
	};
}

export function boundedRedactedQuestion(question: string): string {
	const redacted = question
		.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, "Bearer [REDACTED]")
		.replace(
			/\b(api[_ -]?key|access[_ -]?token|auth(?:orization)?|password|secret)\s*[:=]\s*["']?[^\s,"']+/giu,
			"$1=[REDACTED]",
		)
		.replace(/\b(?:sk|gh[opusr]|xox[baprs])[-_][A-Za-z0-9_-]{8,}\b/gu, "[REDACTED]");
	let bounded = "";
	let bytes = 0;
	for (const character of redacted) {
		const characterBytes = Buffer.byteLength(character);
		if (bytes + characterBytes > PREFLIGHT_MAX_QUESTION_BYTES) {
			break;
		}
		bounded += character;
		bytes += characterBytes;
	}
	return bounded.trim() || "ISO needs one bounded clarification before research can launch.";
}

export function assertDigest(value: string, label: string): void {
	if (!/^[a-f0-9]{64}$/u.test(value)) {
		throw new PreflightError("invalid_payload", `${label} must be a lowercase SHA-256 digest.`);
	}
}

export function assertPreflightIntentKey(intentKey: string): void {
	assertDigest(intentKey, "intentKey");
}

export function assertPreflightIdentifier(
	value: string,
	label: "preflightId" | "missionId" | "launchOperationId" | "attemptId",
): void {
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		Buffer.byteLength(value) > PREFLIGHT_MAX_IDENTIFIER_BYTES ||
		!/^[a-zA-Z0-9:._-]+$/u.test(value)
	) {
		throw new PreflightError(
			"invalid_payload",
			`${label} must contain only letters, numbers, colon, dot, underscore, or hyphen and fit ${PREFLIGHT_MAX_IDENTIFIER_BYTES} bytes.`,
		);
	}
}

export function assertPreflightReason(
	reason: string,
	options: { allowAnalysisOnly: boolean },
): asserts reason is PreflightReason {
	if (
		!PREFLIGHT_REASONS.includes(reason as PreflightReason) ||
		(!options.allowAnalysisOnly && reason === "analysis_only")
	) {
		const allowed = options.allowAnalysisOnly
			? PREFLIGHT_REASONS.join(", ")
			: PREFLIGHT_REASONS.filter((candidate) => candidate !== "analysis_only").join(", ");
		throw new PreflightError("invalid_payload", `reason must be one of: ${allowed}.`);
	}
}

export function assertPreflightFailureCode(failureCode: string): asserts failureCode is PreflightFailureCode {
	if (!PREFLIGHT_FAILURE_CODES.includes(failureCode as PreflightFailureCode)) {
		throw new PreflightError("invalid_payload", `failureCode must be one of: ${PREFLIGHT_FAILURE_CODES.join(", ")}.`);
	}
}
