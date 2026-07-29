import { createHash, randomUUID } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { isDeepStrictEqual } from "node:util";
import {
	assertDigest,
	assertPreflightFailureCode,
	assertPreflightIdentifier,
	assertPreflightIntentKey,
	assertPreflightReason,
	DIRECT_PREFLIGHT_ORPHAN_TTL_MS,
	type DurableMissionLaunchReceipt,
	PREFLIGHT_MAX_CORRECTIONS,
	type PreflightBeginInput,
	type PreflightClaimInput,
	type PreflightContinuation,
	type PreflightContinuationLookup,
	type PreflightCorrectInput,
	type PreflightDeferInput,
	PreflightError,
	type PreflightFailInput,
	type PreflightLookup,
	type PreflightOpenInput,
	type PreflightReceipt,
	type PreflightRenewInput,
	type PreflightResolveInput,
	type PreflightResumeInput,
	type PreflightState,
	preflightLaunchIdentity,
} from "./preflight.ts";
import type {
	AgentCallAttempt,
	AgentCallRole,
	AgentProvenance,
	Campaign,
	CampaignCreateInput,
	ExperimentRetry,
	Idea,
	IsoEvent,
	IsoState,
	MaterialUpdate,
	MissionPhase,
	MissionReceipt,
	ProposedIdea,
	ResearchMission,
	ResearchMissionInput,
} from "./types.ts";

const EVENT_WINDOW = 2_000;
const MAX_DIAGNOSTICS = 100;

interface StateRow {
	state_json: string;
}

interface CommandRow {
	response_json: string;
}

interface TableColumnRow {
	name: string;
}

interface EventRow {
	sequence: number;
	id: string;
	campaign_id: string;
	generation_id: string | null;
	experiment_id: string | null;
	type: string;
	summary: string;
	actor: IsoEvent["actor"];
	at: string;
	refs_json: string;
	data_json: string | null;
}

interface PreflightRow {
	preflight_id: string;
	intent_key: string;
	objective_digest: string;
	admission_kind: "direct" | "conversational";
	state: PreflightState;
	reason: PreflightReceipt["reason"] | null;
	failure_code: PreflightReceipt["failureCode"] | null;
	correction_count: number;
	mission_id: string | null;
	question_digest: string | null;
	answer_digest: string | null;
	admission_epoch: number;
	created_at: string;
	updated_at: string;
}

interface PreflightAttemptRow {
	preflight_id: string;
	session_digest: string;
	attempt_id: string;
	lease_expires_at: number;
	continuation_pending: number;
	updated_at: string;
}

interface AtomicUpdateEnvelope<T> {
	version: 1;
	requestFingerprint: string;
	value: T;
}

type LegacyPreflightResolveInput = Omit<PreflightResolveInput, "attemptId"> & {
	attemptId?: string;
};

type LegacyPreflightFailInput = Omit<PreflightFailInput, "attemptId"> & {
	attemptId?: string;
};

export interface AtomicUpdateContext {
	state: IsoState;
	nextRevision: number;
}

export interface AtomicUpdateResult<T> {
	value: T;
	replayed: boolean;
}

export interface AtomicMissionLaunchInput {
	idempotencyKey: string;
	requestFingerprint: string;
	preflightId: string;
	attemptId?: string;
	launchOperationId: string;
	inputDigest: string;
	input: ResearchMissionInput;
}

export class IdempotencyConflictError extends Error {
	readonly idempotencyKey: string;

	constructor(idempotencyKey: string) {
		super(`Idempotency key ${idempotencyKey} is already bound to a different command.`);
		this.name = "IdempotencyConflictError";
		this.idempotencyKey = idempotencyKey;
	}
}

function emptyState(): IsoState {
	return {
		schemaVersion: 2,
		revision: 0,
		admissionEpoch: 0,
		campaigns: [],
		ideas: [],
		generations: [],
		experiments: [],
		reflections: [],
		events: [],
		missions: [],
		operatorNotes: [],
		retryQueue: [],
		agentCallAttempts: [],
		materialUpdates: [],
		nextMaterialUpdateSequence: 1,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isAtomicUpdateEnvelope(value: unknown): value is AtomicUpdateEnvelope<unknown> {
	return isRecord(value) && value.version === 1 && typeof value.requestFingerprint === "string" && "value" in value;
}

function isIsoState(value: unknown): value is IsoState {
	return (
		isRecord(value) &&
		value.schemaVersion === 2 &&
		typeof value.revision === "number" &&
		Array.isArray(value.campaigns) &&
		Array.isArray(value.ideas) &&
		Array.isArray(value.generations) &&
		Array.isArray(value.experiments) &&
		Array.isArray(value.reflections)
	);
}

function stateWithoutEvents(state: IsoState): Omit<IsoState, "events"> {
	return {
		schemaVersion: state.schemaVersion,
		revision: state.revision,
		admissionEpoch: state.admissionEpoch,
		campaigns: state.campaigns,
		ideas: state.ideas,
		generations: state.generations,
		experiments: state.experiments,
		reflections: state.reflections,
		missions: state.missions,
		operatorNotes: state.operatorNotes,
		retryQueue: state.retryQueue,
		agentCallAttempts: state.agentCallAttempts,
		materialUpdates: state.materialUpdates,
		nextMaterialUpdateSequence: state.nextMaterialUpdateSequence,
	};
}

function normalizeState(state: IsoState): IsoState {
	const legacy = state as IsoState & {
		missions?: IsoState["missions"];
		operatorNotes?: IsoState["operatorNotes"];
		retryQueue?: IsoState["retryQueue"];
		agentCallAttempts?: IsoState["agentCallAttempts"];
		materialUpdates?: IsoState["materialUpdates"];
		nextMaterialUpdateSequence?: number;
		admissionEpoch?: number;
	};
	legacy.admissionEpoch ??= 0;
	legacy.missions ??= [];
	legacy.operatorNotes ??= [];
	legacy.retryQueue ??= [];
	if (legacy.agentCallAttempts === undefined) {
		legacy.agentCallAttempts = [];
		for (const generation of legacy.generations) {
			for (const [role, provenance] of [
				["planner", generation.planner],
				["critic", generation.critic],
			] as const) {
				if (provenance) {
					legacy.agentCallAttempts.push(
						legacyAgentCallAttempt({
							id: `legacy-${role}-${generation.id}`,
							campaignId: generation.campaignId,
							generationId: generation.id,
							role,
							provenance,
							startedAt: generation.startedAt ?? generation.createdAt,
							finishedAt: generation.finishedAt ?? generation.updatedAt,
						}),
					);
				}
			}
		}
		for (const experiment of legacy.experiments) {
			if (experiment.agent) {
				legacy.agentCallAttempts.push(
					legacyAgentCallAttempt({
						id: `legacy-worker-${experiment.id}`,
						campaignId: experiment.campaignId,
						generationId: experiment.generationId,
						experimentId: experiment.id,
						ideaId: experiment.ideaId,
						role: "worker",
						attempt: experiment.attempt,
						provenance: experiment.agent,
						startedAt: experiment.startedAt ?? experiment.createdAt,
						finishedAt: experiment.finishedAt ?? experiment.updatedAt,
					}),
				);
			}
		}
	}
	legacy.materialUpdates ??= [];
	legacy.nextMaterialUpdateSequence ??= Math.max(0, ...legacy.materialUpdates.map((update) => update.sequence)) + 1;
	for (const experiment of legacy.experiments) {
		if (experiment.screeningPassed === undefined) {
			const campaign = legacy.campaigns.find((candidate) => candidate.id === experiment.campaignId);
			const improvement = experiment.improvement;
			const uncertainty = experiment.uncertainty;
			experiment.screeningPassed =
				experiment.evaluation?.valid === true &&
				experiment.changedPaths.length > 0 &&
				improvement !== undefined &&
				Number.isFinite(improvement) &&
				uncertainty !== undefined &&
				Number.isFinite(uncertainty) &&
				improvement > 0 &&
				campaign !== undefined &&
				improvement - uncertainty >= campaign.metric.minimumImprovement;
		}
		if (!experiment.confirmationHistory?.some((evidence) => evidence.confirmed)) {
			experiment.credibleImprovement = false;
		}
	}
	for (const mission of legacy.missions) {
		mission.diagnostics ??= [];
		mission.notificationCursor ??= 0;
	}
	return legacy;
}

function legacyAgentCallAttempt(options: {
	id: string;
	campaignId: string;
	generationId: string;
	experimentId?: string;
	ideaId?: string;
	role: AgentCallRole;
	attempt?: number;
	provenance: AgentProvenance;
	startedAt: string;
	finishedAt: string;
}): AgentCallAttempt {
	return {
		id: options.id,
		campaignId: options.campaignId,
		generationId: options.generationId,
		experimentId: options.experimentId,
		ideaId: options.ideaId,
		role: options.role,
		attempt: options.attempt ?? 1,
		status: "succeeded",
		provider: options.provenance.provider,
		model: options.provenance.model,
		thinkingLevel: options.provenance.thinkingLevel,
		sessionId: options.provenance.sessionId,
		inputTokens: options.provenance.inputTokens,
		outputTokens: options.provenance.outputTokens,
		costUsd: options.provenance.cost,
		missingTokenAccounting:
			options.provenance.inputTokens === undefined || options.provenance.outputTokens === undefined,
		missingCostAccounting: options.provenance.cost === undefined,
		startedAt: options.startedAt,
		finishedAt: options.finishedAt,
	};
}

function parseStringArray(value: string): string[] {
	const parsed: unknown = JSON.parse(value);
	return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}

function parseEventData(value: string | null): Record<string, unknown> | undefined {
	if (!value) {
		return undefined;
	}
	const parsed: unknown = JSON.parse(value);
	return isRecord(parsed) ? parsed : undefined;
}

export function now(): string {
	return new Date().toISOString();
}

export function makeId(prefix: string): string {
	return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

export class IsoStore {
	readonly repoRoot: string;
	readonly statePath: string;
	private readonly database: DatabaseSync;
	private readonly commandsInFlight = new Map<string, Promise<unknown>>();
	private writeQueue: Promise<void> = Promise.resolve();

	constructor(repoRoot: string) {
		this.repoRoot = repoRoot;
		const isoDirectory = join(repoRoot, ".iso");
		mkdirSync(isoDirectory, { recursive: true, mode: 0o700 });
		const directoryStat = lstatSync(isoDirectory);
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
			throw new Error(`ISO state directory must be a real directory, not a symlink: ${isoDirectory}`);
		}
		chmodSync(isoDirectory, 0o700);
		this.statePath = join(isoDirectory, "iso.db");
		if (existsSync(this.statePath)) {
			const stateStat = lstatSync(this.statePath);
			if (stateStat.isSymbolicLink() || !stateStat.isFile()) {
				throw new Error(`ISO database must be a regular file, not a symlink: ${this.statePath}`);
			}
		}
		this.database = new DatabaseSync(this.statePath);
		chmodSync(this.statePath, 0o600);
		this.database.exec(`
			PRAGMA journal_mode = WAL;
			PRAGMA synchronous = FULL;
			PRAGMA busy_timeout = 10000;
			PRAGMA secure_delete = ON;
			CREATE TABLE IF NOT EXISTS state (
				id INTEGER PRIMARY KEY CHECK (id = 1),
				state_json TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS events (
				sequence INTEGER PRIMARY KEY AUTOINCREMENT,
				id TEXT NOT NULL UNIQUE,
				campaign_id TEXT NOT NULL,
				generation_id TEXT,
				experiment_id TEXT,
				type TEXT NOT NULL,
				summary TEXT NOT NULL,
				actor TEXT NOT NULL,
				at TEXT NOT NULL,
				refs_json TEXT NOT NULL,
				data_json TEXT
			);
			CREATE INDEX IF NOT EXISTS events_campaign_sequence
				ON events(campaign_id, sequence);
			CREATE TABLE IF NOT EXISTS commands (
				idempotency_key TEXT PRIMARY KEY,
				response_json TEXT NOT NULL,
				created_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS leases (
				name TEXT PRIMARY KEY,
				owner TEXT NOT NULL,
				expires_at INTEGER NOT NULL
			);
			CREATE TABLE IF NOT EXISTS preflight_receipts (
				preflight_id TEXT PRIMARY KEY,
				intent_key TEXT NOT NULL UNIQUE,
				objective TEXT NOT NULL,
				admission_kind TEXT NOT NULL DEFAULT 'direct' CHECK (
					admission_kind IN ('direct', 'conversational')
				),
				state TEXT NOT NULL CHECK (
					state IN ('pending', 'needs_input', 'analysis_only', 'launched', 'failed')
				),
				reason TEXT CHECK (
					reason IS NULL OR reason IN (
						'metric_ambiguity', 'credentials', 'material_cost', 'analysis_only'
					)
				),
				failure_code TEXT CHECK (
					failure_code IS NULL OR failure_code IN (
						'postcondition_exhausted', 'kernel_unavailable', 'launch_failed'
					)
				),
				correction_count INTEGER NOT NULL DEFAULT 0 CHECK (
					correction_count >= 0 AND correction_count <= 2
				),
				mission_id TEXT,
				question_digest TEXT,
				answer_digest TEXT,
				admission_epoch INTEGER NOT NULL DEFAULT 0 CHECK (admission_epoch >= 0),
				created_at TEXT NOT NULL,
				updated_at TEXT NOT NULL
			);
			CREATE TABLE IF NOT EXISTS preflight_attempts (
				preflight_id TEXT PRIMARY KEY,
				session_digest TEXT NOT NULL,
				attempt_id TEXT NOT NULL,
				lease_expires_at INTEGER NOT NULL,
				continuation_pending INTEGER NOT NULL DEFAULT 0 CHECK (
					continuation_pending IN (0, 1)
				),
				updated_at TEXT NOT NULL
			);
			CREATE INDEX IF NOT EXISTS preflight_attempts_session
				ON preflight_attempts(session_digest, lease_expires_at);
		`);
		const preflightColumns = new Set(
			(this.database.prepare("PRAGMA table_info(preflight_receipts)").all() as unknown as TableColumnRow[]).map(
				(column) => column.name,
			),
		);
		if (!preflightColumns.has("question_digest")) {
			this.database.exec("ALTER TABLE preflight_receipts ADD COLUMN question_digest TEXT");
		}
		if (!preflightColumns.has("answer_digest")) {
			this.database.exec("ALTER TABLE preflight_receipts ADD COLUMN answer_digest TEXT");
		}
		if (!preflightColumns.has("admission_epoch")) {
			this.database.exec("ALTER TABLE preflight_receipts ADD COLUMN admission_epoch INTEGER NOT NULL DEFAULT 0");
		}
		if (!preflightColumns.has("admission_kind")) {
			this.database.exec("ALTER TABLE preflight_receipts ADD COLUMN admission_kind TEXT NOT NULL DEFAULT 'direct'");
			this.database.exec(`
				UPDATE preflight_receipts
				SET admission_kind = 'conversational'
				WHERE preflight_id IN (SELECT preflight_id FROM preflight_attempts)
			`);
		}
		const legacyObjectives = this.database
			.prepare("SELECT preflight_id, objective FROM preflight_receipts")
			.all() as unknown as Array<{ preflight_id: string; objective: string }>;
		const scrubObjective = this.database.prepare(
			"UPDATE preflight_receipts SET objective = ? WHERE preflight_id = ?",
		);
		let scrubbedLegacyObjectives = 0;
		for (const legacy of legacyObjectives) {
			if (!/^[a-f0-9]{64}$/u.test(legacy.objective)) {
				const digest = createHash("sha256")
					.update("iso.preflight.legacy-objective.v1\0", "utf8")
					.update(legacy.objective, "utf8")
					.digest("hex");
				scrubObjective.run(digest, legacy.preflight_id);
				scrubbedLegacyObjectives += 1;
			}
		}
		if (scrubbedLegacyObjectives > 0) {
			this.database.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM");
		}
		const row = this.database.prepare("SELECT state_json FROM state WHERE id = 1").get() as StateRow | undefined;
		if (!row) {
			this.database
				.prepare("INSERT INTO state (id, state_json) VALUES (1, ?)")
				.run(JSON.stringify(stateWithoutEvents(emptyState())));
		}
	}

	async exists(): Promise<boolean> {
		return (await this.read()).campaigns.length > 0;
	}

	hasActiveCampaign(): boolean {
		return getActiveCampaign(this.readSync()) !== undefined;
	}

	async read(): Promise<IsoState> {
		return this.readSync();
	}

	async update<T>(mutate: (state: IsoState) => T): Promise<T> {
		return this.writeTransaction(() => {
			const state = this.readSync();
			const existingEvents = new Set(state.events.map((event) => event.id));
			const result = mutate(state);
			state.revision += 1;
			this.persistState(state, existingEvents);
			return result;
		});
	}

	/**
	 * Applies a synchronous state transition and records its response in the
	 * same BEGIN IMMEDIATE transaction. A committed response therefore implies
	 * that its state and events committed, and replay never reruns the mutation.
	 */
	async updateOnce<T>(
		idempotencyKey: string,
		requestFingerprint: string,
		mutate: (context: AtomicUpdateContext) => T,
	): Promise<AtomicUpdateResult<T>> {
		return this.atomicReceiptTransaction(idempotencyKey, requestFingerprint, () => {
			const state = this.readSync();
			const existingEvents = new Set(state.events.map((event) => event.id));
			const nextRevision = state.revision + 1;
			const value = mutate({ state, nextRevision });
			state.revision = nextRevision;
			this.persistState(state, existingEvents);
			return value;
		});
	}

	readAtomicReceipt<T>(idempotencyKey: string, requestFingerprint: string): AtomicUpdateResult<T> | undefined {
		this.assertAtomicReceiptIdentity(idempotencyKey, requestFingerprint);
		const existing = this.database
			.prepare("SELECT response_json FROM commands WHERE idempotency_key = ?")
			.get(idempotencyKey) as CommandRow | undefined;
		if (!existing) {
			return undefined;
		}
		const parsed: unknown = JSON.parse(existing.response_json);
		if (!isAtomicUpdateEnvelope(parsed) || parsed.requestFingerprint !== requestFingerprint) {
			throw new IdempotencyConflictError(idempotencyKey);
		}
		return {
			value: structuredClone(parsed.value) as T,
			replayed: true,
		};
	}

	async openPreflightOnce(
		idempotencyKey: string,
		requestFingerprint: string,
		input: PreflightOpenInput,
	): Promise<AtomicUpdateResult<PreflightReceipt>> {
		return this.atomicReceiptTransaction(idempotencyKey, requestFingerprint, () =>
			this.openPreflightSync(input, "direct"),
		);
	}

	async beginPreflightOnce(
		idempotencyKey: string,
		requestFingerprint: string,
		input: PreflightBeginInput,
	): Promise<AtomicUpdateResult<PreflightReceipt>> {
		return this.replayableLeaseTransaction(idempotencyKey, requestFingerprint, () => {
			const receipt = this.openPreflightSync(input, "conversational");
			if (receipt.state === "pending") {
				this.claimPreflightSync({
					preflightId: receipt.preflightId,
					attemptId: input.attemptId,
					sessionDigest: input.sessionDigest,
					leaseTtlMs: input.leaseTtlMs,
				});
			}
			return preflightReceiptFromRow(this.requirePreflight(receipt.preflightId));
		});
	}

	async claimPreflightOnce(
		idempotencyKey: string,
		requestFingerprint: string,
		input: PreflightClaimInput,
	): Promise<AtomicUpdateResult<PreflightReceipt>> {
		return this.atomicReceiptTransaction(idempotencyKey, requestFingerprint, () => {
			this.claimPreflightSync(input);
			return preflightReceiptFromRow(this.requirePreflight(input.preflightId));
		});
	}

	async renewPreflightAttempt(input: PreflightRenewInput): Promise<PreflightReceipt> {
		return this.writeTransaction(() => {
			this.validateAttemptIdentity(input);
			const current = this.requirePreflight(input.preflightId);
			if (current.state !== "pending") {
				throw invalidPreflightTransition(current.state, "pending");
			}
			const timestamp = Date.now();
			const result = this.database
				.prepare(`
					UPDATE preflight_attempts
					SET lease_expires_at = ?, updated_at = ?
					WHERE preflight_id = ?
						AND attempt_id = ?
						AND lease_expires_at > ?
				`)
				.run(timestamp + input.leaseTtlMs, now(), input.preflightId, input.attemptId, timestamp);
			if (result.changes !== 1) {
				throw new PreflightError(
					"preflight_conflict",
					`Preflight ${input.preflightId} is owned by another principal attempt.`,
				);
			}
			return preflightReceiptFromRow(current);
		});
	}

	async resumePreflightOnce(
		idempotencyKey: string,
		requestFingerprint: string,
		input: PreflightResumeInput,
	): Promise<AtomicUpdateResult<PreflightReceipt>> {
		return this.replayableLeaseTransaction(idempotencyKey, requestFingerprint, () => {
			const receipt = this.resolvePreflightSync({
				preflightId: input.preflightId,
				state: "pending",
				answerDigest: input.answerDigest,
			});
			this.claimPreflightSync(input);
			return receipt;
		});
	}

	getPendingPreflightContinuation(lookup: PreflightContinuationLookup): PreflightContinuation | undefined {
		assertDigest(lookup.sessionDigest, "sessionDigest");
		const timestamp = Date.now();
		const row = this.database
			.prepare(`
				SELECT p.preflight_id, p.intent_key, p.objective AS objective_digest,
					p.admission_kind, p.state, p.reason, p.failure_code,
					p.correction_count, p.mission_id, p.question_digest,
					p.answer_digest, p.admission_epoch, p.created_at, p.updated_at
				FROM preflight_receipts AS p
				JOIN preflight_attempts AS a ON a.preflight_id = p.preflight_id
				WHERE a.session_digest = ?
					AND p.state = 'pending'
					AND (a.continuation_pending = 1 OR a.lease_expires_at <= ?)
				ORDER BY a.continuation_pending DESC, a.updated_at DESC
				LIMIT 1
			`)
			.get(lookup.sessionDigest, timestamp) as PreflightRow | undefined;
		if (!row) {
			return undefined;
		}
		return {
			receipt: preflightReceiptFromRow(row),
			correctionCount: row.correction_count,
		};
	}

	async expirePreflightAttempts(timestamp = Date.now()): Promise<PreflightReceipt[]> {
		return this.writeTransaction(() => {
			const expired = this.database
				.prepare(`
					SELECT p.preflight_id, p.intent_key, p.objective AS objective_digest,
						p.admission_kind, p.state, p.reason, p.failure_code,
						p.correction_count, p.mission_id, p.question_digest,
						p.answer_digest, p.admission_epoch, p.created_at, p.updated_at
					FROM preflight_receipts AS p
					JOIN preflight_attempts AS a ON a.preflight_id = p.preflight_id
					WHERE p.state = 'pending'
						AND a.lease_expires_at > 0
						AND a.lease_expires_at <= ?
				`)
				.all(timestamp) as unknown as PreflightRow[];
			const released: PreflightReceipt[] = [];
			for (const row of expired) {
				this.database
					.prepare(`
						UPDATE preflight_attempts
						SET lease_expires_at = 0, updated_at = ?
						WHERE preflight_id = ?
							AND lease_expires_at > 0
							AND lease_expires_at <= ?
					`)
					.run(now(), row.preflight_id, timestamp);
				released.push(preflightReceiptFromRow(this.requirePreflight(row.preflight_id)));
			}
			return released;
		});
	}

	async failStaleDirectPreflights(timestamp = Date.now()): Promise<PreflightReceipt[]> {
		return this.writeTransaction(() => {
			const cutoff = new Date(timestamp - DIRECT_PREFLIGHT_ORPHAN_TTL_MS).toISOString();
			const stale = this.database
				.prepare(`
					SELECT p.preflight_id, p.intent_key, p.objective AS objective_digest,
						p.admission_kind, p.state, p.reason, p.failure_code,
						p.correction_count, p.mission_id, p.question_digest,
						p.answer_digest, p.admission_epoch, p.created_at, p.updated_at
					FROM preflight_receipts AS p
					LEFT JOIN preflight_attempts AS a ON a.preflight_id = p.preflight_id
					WHERE p.admission_kind = 'direct'
						AND p.state = 'pending'
						AND p.updated_at <= ?
						AND a.preflight_id IS NULL
				`)
				.all(cutoff) as unknown as PreflightRow[];
			const failed: PreflightReceipt[] = [];
			for (const row of stale) {
				const result = this.database
					.prepare(`
						UPDATE preflight_receipts
						SET state = 'failed', reason = NULL, failure_code = 'kernel_unavailable',
							mission_id = NULL, question_digest = NULL, answer_digest = NULL, updated_at = ?
						WHERE preflight_id = ?
							AND admission_kind = 'direct'
							AND state = 'pending'
					`)
					.run(now(), row.preflight_id);
				if (result.changes === 1) {
					failed.push(preflightReceiptFromRow(this.requirePreflight(row.preflight_id)));
				}
			}
			return failed;
		});
	}

	async deferPreflightOnce(
		idempotencyKey: string,
		requestFingerprint: string,
		input: PreflightDeferInput,
	): Promise<AtomicUpdateResult<PreflightReceipt>> {
		assertPreflightIdentifier(input.attemptId, "attemptId");
		return this.atomicReceiptTransaction(idempotencyKey, requestFingerprint, () =>
			this.deferPreflightSync(input.preflightId, input.reason, input.questionDigest, input.attemptId),
		);
	}

	async correctPreflightOnce(
		idempotencyKey: string,
		requestFingerprint: string,
		input: PreflightCorrectInput,
	): Promise<AtomicUpdateResult<PreflightReceipt>> {
		return this.atomicReceiptTransaction(idempotencyKey, requestFingerprint, () => {
			this.assertPreflightAttempt(input.preflightId, input.attemptId);
			const receipt = this.correctPreflightSync(input.preflightId);
			this.database
				.prepare(`
					UPDATE preflight_attempts
					SET continuation_pending = 1, updated_at = ?
					WHERE preflight_id = ? AND attempt_id = ?
				`)
				.run(now(), input.preflightId, input.attemptId);
			return receipt;
		});
	}

	async resolvePreflightOnce(
		idempotencyKey: string,
		requestFingerprint: string,
		input: PreflightResolveInput,
	): Promise<AtomicUpdateResult<PreflightReceipt>> {
		assertPreflightIdentifier(input.attemptId, "attemptId");
		return this.atomicReceiptTransaction(idempotencyKey, requestFingerprint, () => this.resolvePreflightSync(input));
	}

	async failPreflightOnce(
		idempotencyKey: string,
		requestFingerprint: string,
		input: PreflightFailInput,
	): Promise<AtomicUpdateResult<PreflightReceipt>> {
		assertPreflightIdentifier(input.attemptId, "attemptId");
		return this.atomicReceiptTransaction(idempotencyKey, requestFingerprint, () => this.failPreflightSync(input));
	}

	async acceptMissionOnce(input: AtomicMissionLaunchInput): Promise<AtomicUpdateResult<DurableMissionLaunchReceipt>> {
		assertPreflightIdentifier(input.preflightId, "preflightId");
		if (input.attemptId !== undefined) {
			assertPreflightIdentifier(input.attemptId, "attemptId");
		}
		assertPreflightIdentifier(input.launchOperationId, "launchOperationId");
		assertDigest(input.inputDigest, "inputDigest");
		const expectedIdentity = preflightLaunchIdentity(input.preflightId, input.input);
		if (
			expectedIdentity.inputDigest !== input.inputDigest ||
			expectedIdentity.launchOperationId !== input.launchOperationId
		) {
			throw new PreflightError(
				"preflight_conflict",
				"Launch identity does not match the canonical persisted mission input.",
			);
		}
		return this.atomicReceiptTransaction(input.idempotencyKey, input.requestFingerprint, () => {
			const state = this.readSync();
			const preflight = this.requirePreflight(input.preflightId);
			const exactMission = state.missions.find((mission) => mission.launchOperationId === input.launchOperationId);
			if (exactMission) {
				if (
					exactMission.preflightId !== input.preflightId ||
					exactMission.launchInputDigest !== input.inputDigest ||
					!isDeepStrictEqual(exactMission.input, input.input)
				) {
					throw new PreflightError(
						"preflight_conflict",
						"Launch operation is already bound to a different durable mission payload.",
					);
				}
				this.bindLaunchedPreflight(preflight, exactMission.id);
				return this.missionLaunchReceipt(exactMission, false);
			}
			const preflightMission = state.missions.find((mission) => mission.preflightId === input.preflightId);
			if (preflightMission || preflight.state === "launched") {
				throw new PreflightError(
					"preflight_conflict",
					`Preflight ${input.preflightId} is already bound to another launch operation.`,
				);
			}
			if (preflight.state !== "pending") {
				throw invalidPreflightTransition(preflight.state, "launched");
			}
			if (input.attemptId !== undefined) {
				this.assertPreflightAttempt(input.preflightId, input.attemptId);
			}
			if (preflight.admission_epoch !== state.admissionEpoch) {
				throw new PreflightError(
					"preflight_conflict",
					`Preflight ${input.preflightId} was cancelled by a newer pause or stop control barrier.`,
				);
			}
			const activeMission = getActiveMission(state);
			if (activeMission) {
				throw new PreflightError(
					"preflight_conflict",
					`Unrelated mission ${activeMission.id} became active before this preflight could launch.`,
				);
			}
			const activeCampaign = getActiveCampaign(state);
			if (activeCampaign) {
				throw new PreflightError(
					"preflight_conflict",
					`Unrelated campaign ${activeCampaign.id} became active before this preflight could launch.`,
				);
			}

			const existingEvents = new Set(state.events.map((event) => event.id));
			const timestamp = now();
			const mission: ResearchMission = {
				id: makeId("mission"),
				preflightId: input.preflightId,
				launchOperationId: input.launchOperationId,
				launchInputDigest: input.inputDigest,
				input: structuredClone(input.input),
				desiredState: "running",
				phase: "accepted",
				diagnostics: [],
				notificationCursor: 0,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			appendMissionDiagnostic(mission, {
				phase: "accepted",
				code: "mission_accepted",
				message: "Mission accepted durably; calibration will continue in the local kernel.",
				retryable: false,
			});
			state.missions.push(mission);
			appendMaterialUpdate(state, {
				missionId: mission.id,
				kind: "mission",
				summary: "Research mission accepted",
				refs: [mission.id, input.preflightId, input.launchOperationId],
			});
			state.revision += 1;
			this.persistState(state, existingEvents);
			this.bindLaunchedPreflight(preflight, mission.id);
			return this.missionLaunchReceipt(mission, true);
		});
	}

	async openPreflight(input: PreflightOpenInput): Promise<PreflightReceipt> {
		return this.writeTransaction(() => this.openPreflightSync(input, "direct"));
	}

	getPreflight(lookup: PreflightLookup): PreflightReceipt | undefined {
		if ("preflightId" in lookup) {
			assertPreflightIdentifier(lookup.preflightId, "preflightId");
		} else {
			assertPreflightIntentKey(lookup.intentKey);
		}
		const row = this.preflightByLookup(lookup);
		return row ? preflightReceiptFromRow(row) : undefined;
	}

	async deferPreflight(
		preflightId: string,
		reason: Exclude<PreflightReceipt["reason"], "analysis_only" | undefined>,
		questionDigest = createHash("sha256")
			.update("iso.preflight.legacy-question.v1\0", "utf8")
			.update(reason ?? "", "utf8")
			.digest("hex"),
	): Promise<PreflightReceipt> {
		return this.writeTransaction(() => this.deferPreflightSync(preflightId, reason, questionDigest));
	}

	async resolvePreflight(input: LegacyPreflightResolveInput): Promise<PreflightReceipt> {
		return this.writeTransaction(() => this.resolvePreflightSync(input));
	}

	async correctPreflight(preflightId: string): Promise<PreflightReceipt> {
		return this.writeTransaction(() => this.correctPreflightSync(preflightId));
	}

	async failPreflight(input: LegacyPreflightFailInput): Promise<PreflightReceipt> {
		return this.writeTransaction(() => this.failPreflightSync(input));
	}

	async initialize(
		options: CampaignCreateInput,
		missionId?: string,
		expectedAdmissionEpoch?: number,
	): Promise<Campaign> {
		return this.update((state) => {
			if (expectedAdmissionEpoch !== undefined && state.admissionEpoch !== expectedAdmissionEpoch) {
				throw new Error("Campaign admission was cancelled by a newer pause or stop control barrier.");
			}
			const active = getActiveCampaign(state);
			if (active) {
				throw new Error(`ISO already has active campaign ${active.id}. Stop or complete it first.`);
			}
			const timestamp = now();
			const mission = missionId ? state.missions.find((candidate) => candidate.id === missionId) : undefined;
			if (missionId && !mission) {
				throw new Error(`Mission ${missionId} disappeared before campaign initialization.`);
			}
			if (mission && mission.desiredState !== "running") {
				throw new Error(`Mission ${mission.id} is no longer running.`);
			}
			const campaign: Campaign = {
				id: makeId("campaign"),
				missionId,
				goal: options.goal,
				metric: options.metric,
				config: options.config,
				status: "ready",
				runIntent: mission ? "running" : "idle",
				sourceCommit: options.sourceCommit,
				sourceHeadCommit: options.sourceHeadCommit,
				sourceSnapshotRef: options.sourceSnapshotRef,
				sourceHadLocalChanges: options.sourceHadLocalChanges,
				sourceSnapshotPaths: options.sourceSnapshotPaths,
				dependencyDigest: options.dependencyDigest,
				evaluatorDigest: options.evaluatorDigest,
				runtimeProvenance: options.runtimeProvenance,
				baseline: options.baseline,
				generationsCompleted: 0,
				experimentsStarted: 0,
				failures: 0,
				consecutivePlateaus: 0,
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			state.campaigns.push(campaign);
			if (mission) {
				mission.campaignId = campaign.id;
				mission.phase = "starting";
				mission.startedAt ??= timestamp;
				mission.updatedAt = timestamp;
				for (const note of state.operatorNotes) {
					if (note.missionId === mission.id && note.campaignId === undefined) {
						note.campaignId = campaign.id;
					}
				}
				appendMaterialUpdate(state, {
					missionId: mission.id,
					campaignId: campaign.id,
					kind: "mission",
					summary: `Calibration completed at baseline ${campaign.baseline.evaluation.score.mean}`,
					refs: [mission.id, campaign.id],
				});
			}
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					type: "campaign.calibrated",
					summary: `Campaign calibrated at baseline ${campaign.baseline.evaluation.score.mean}`,
					actor: "conductor",
					refs: [campaign.id],
				}),
			);
			return structuredClone(campaign);
		});
	}

	queryEvents(options: {
		campaignId?: string;
		generationId?: string;
		experimentId?: string;
		afterSequence?: number;
		limit: number;
	}): { events: IsoEvent[]; nextSequence?: number } {
		const clauses = ["sequence > ?"];
		const parameters: Array<string | number> = [options.afterSequence ?? 0];
		if (options.campaignId) {
			clauses.push("campaign_id = ?");
			parameters.push(options.campaignId);
		}
		if (options.generationId) {
			clauses.push("generation_id = ?");
			parameters.push(options.generationId);
		}
		if (options.experimentId) {
			clauses.push("experiment_id = ?");
			parameters.push(options.experimentId);
		}
		parameters.push(options.limit + 1);
		const rows = this.database
			.prepare(`
				SELECT sequence, id, campaign_id, generation_id, experiment_id, type,
					summary, actor, at, refs_json, data_json
				FROM events
				WHERE ${clauses.join(" AND ")}
				ORDER BY sequence ASC
				LIMIT ?
			`)
			.all(...parameters) as unknown as EventRow[];
		const hasMore = rows.length > options.limit;
		const page = rows.slice(0, options.limit);
		return {
			events: page.map(eventFromRow),
			nextSequence: hasMore ? page.at(-1)?.sequence : undefined,
		};
	}

	async addIdea(
		campaignId: string,
		generationId: string,
		proposal: ProposedIdea,
		source: Idea["source"] = "human",
	): Promise<Idea> {
		return this.update((state) => {
			const timestamp = now();
			const idea: Idea = {
				id: makeId("idea"),
				campaignId,
				generationId,
				title: proposal.title,
				hypothesis: proposal.hypothesis,
				rationale: proposal.rationale,
				implementationPlan: proposal.implementationPlan,
				predictedEffect: proposal.predictedEffect,
				strategy: proposal.strategy,
				status: "queued",
				source,
				parentIdeaIds: proposal.parentIdeaIds ?? [],
				fingerprint: fingerprintIdea(proposal),
				createdAt: timestamp,
				updatedAt: timestamp,
			};
			state.ideas.push(idea);
			state.events.push(
				createEvent({
					campaignId,
					generationId,
					type: "idea.proposed",
					summary: `Idea proposed: ${idea.title}`,
					actor: source === "human" ? "human" : "planner",
					refs: [idea.id, ...idea.parentIdeaIds],
				}),
			);
			return structuredClone(idea);
		});
	}

	async executeOnce<T>(idempotencyKey: string, execute: () => Promise<T>): Promise<T> {
		if (idempotencyKey.trim() === "") {
			throw new Error("Idempotency key must not be empty.");
		}
		const running = this.commandsInFlight.get(idempotencyKey);
		if (running) {
			return (await running) as T;
		}
		const operation = (async (): Promise<T> => {
			const existing = this.database
				.prepare("SELECT response_json FROM commands WHERE idempotency_key = ?")
				.get(idempotencyKey) as CommandRow | undefined;
			if (existing) {
				return JSON.parse(existing.response_json) as T;
			}
			const result = await execute();
			const inserted = this.database
				.prepare("INSERT OR IGNORE INTO commands (idempotency_key, response_json, created_at) VALUES (?, ?, ?)")
				.run(idempotencyKey, JSON.stringify(result), now());
			if (inserted.changes === 1) {
				return result;
			}
			const winner = this.database
				.prepare("SELECT response_json FROM commands WHERE idempotency_key = ?")
				.get(idempotencyKey) as CommandRow | undefined;
			if (!winner) {
				throw new Error(`Idempotent command ${idempotencyKey} completed without a durable response.`);
			}
			return JSON.parse(winner.response_json) as T;
		})();
		this.commandsInFlight.set(idempotencyKey, operation);
		try {
			return await operation;
		} finally {
			if (this.commandsInFlight.get(idempotencyKey) === operation) {
				this.commandsInFlight.delete(idempotencyKey);
			}
		}
	}

	tryAcquireLease(name: string, owner: string, ttlMs: number): boolean {
		const timestamp = Date.now();
		const result = this.database
			.prepare(`
				INSERT INTO leases (name, owner, expires_at)
				VALUES (?, ?, ?)
				ON CONFLICT(name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
				WHERE leases.expires_at < ? OR leases.owner = excluded.owner
			`)
			.run(name, owner, timestamp + ttlMs, timestamp);
		return result.changes === 1;
	}

	renewLease(name: string, owner: string, ttlMs: number): boolean {
		const result = this.database
			.prepare("UPDATE leases SET expires_at = ? WHERE name = ? AND owner = ?")
			.run(Date.now() + ttlMs, name, owner);
		return result.changes === 1;
	}

	releaseLease(name: string, owner: string): void {
		this.database.prepare("DELETE FROM leases WHERE name = ? AND owner = ?").run(name, owner);
	}

	close(): void {
		this.database.close();
	}

	private atomicReceiptTransaction<T>(
		idempotencyKey: string,
		requestFingerprint: string,
		execute: () => T,
	): Promise<AtomicUpdateResult<T>> {
		this.assertAtomicReceiptIdentity(idempotencyKey, requestFingerprint);
		return this.writeTransaction(() => {
			const existing = this.database
				.prepare("SELECT response_json FROM commands WHERE idempotency_key = ?")
				.get(idempotencyKey) as CommandRow | undefined;
			if (existing) {
				const parsed: unknown = JSON.parse(existing.response_json);
				if (!isAtomicUpdateEnvelope(parsed) || parsed.requestFingerprint !== requestFingerprint) {
					throw new IdempotencyConflictError(idempotencyKey);
				}
				return {
					value: structuredClone(parsed.value) as T,
					replayed: true,
				};
			}
			const value = execute();
			const envelope: AtomicUpdateEnvelope<T> = {
				version: 1,
				requestFingerprint,
				value,
			};
			const serializedEnvelope = JSON.stringify(envelope);
			const durableEnvelope: unknown = JSON.parse(serializedEnvelope);
			if (!isAtomicUpdateEnvelope(durableEnvelope)) {
				throw new Error("Atomic update responses must be JSON-serializable values.");
			}
			this.database
				.prepare("INSERT INTO commands (idempotency_key, response_json, created_at) VALUES (?, ?, ?)")
				.run(idempotencyKey, serializedEnvelope, now());
			return {
				value: structuredClone(durableEnvelope.value) as T,
				replayed: false,
			};
		});
	}

	/**
	 * Lease acquisition is intentionally replayable with a replacement
	 * attempt. The durable command identity binds the stable session and
	 * objective, while each replay still executes the live ownership check and
	 * rotates or renews the transient attempt lease.
	 */
	private replayableLeaseTransaction<T>(
		idempotencyKey: string,
		requestFingerprint: string,
		execute: () => T,
	): Promise<AtomicUpdateResult<T>> {
		this.assertAtomicReceiptIdentity(idempotencyKey, requestFingerprint);
		return this.writeTransaction(() => {
			const existing = this.database
				.prepare("SELECT response_json FROM commands WHERE idempotency_key = ?")
				.get(idempotencyKey) as CommandRow | undefined;
			if (existing) {
				const parsed: unknown = JSON.parse(existing.response_json);
				if (!isAtomicUpdateEnvelope(parsed) || parsed.requestFingerprint !== requestFingerprint) {
					throw new IdempotencyConflictError(idempotencyKey);
				}
				return { value: execute(), replayed: true };
			}
			const value = execute();
			const envelope: AtomicUpdateEnvelope<T> = {
				version: 1,
				requestFingerprint,
				value,
			};
			const serializedEnvelope = JSON.stringify(envelope);
			const durableEnvelope: unknown = JSON.parse(serializedEnvelope);
			if (!isAtomicUpdateEnvelope(durableEnvelope)) {
				throw new Error("Atomic update responses must be JSON-serializable values.");
			}
			this.database
				.prepare("INSERT INTO commands (idempotency_key, response_json, created_at) VALUES (?, ?, ?)")
				.run(idempotencyKey, serializedEnvelope, now());
			return {
				value: structuredClone(durableEnvelope.value) as T,
				replayed: false,
			};
		});
	}

	private assertAtomicReceiptIdentity(idempotencyKey: string, requestFingerprint: string): void {
		if (idempotencyKey.trim() === "") {
			throw new Error("Idempotency key must not be empty.");
		}
		if (requestFingerprint.trim() === "" || requestFingerprint.length > 1_024) {
			throw new Error("Request fingerprint must be a non-empty string of at most 1024 characters.");
		}
	}

	private validateAttemptIdentity(
		input: Pick<PreflightRenewInput, "preflightId" | "attemptId" | "leaseTtlMs"> & {
			sessionDigest?: string;
		},
	): void {
		assertPreflightIdentifier(input.preflightId, "preflightId");
		assertPreflightIdentifier(input.attemptId, "attemptId");
		if (input.sessionDigest !== undefined) {
			assertDigest(input.sessionDigest, "sessionDigest");
		}
		if (!Number.isSafeInteger(input.leaseTtlMs) || input.leaseTtlMs < 5_000 || input.leaseTtlMs > 300_000) {
			throw new PreflightError("invalid_payload", "leaseTtlMs must be an integer from 5000 to 300000.");
		}
	}

	private claimPreflightSync(input: PreflightClaimInput): void {
		this.validateAttemptIdentity(input);
		const current = this.requirePreflight(input.preflightId);
		if (current.state !== "pending") {
			throw invalidPreflightTransition(current.state, "pending");
		}
		if (current.admission_kind !== "conversational") {
			throw new PreflightError(
				"preflight_conflict",
				`Direct preflight ${input.preflightId} cannot be claimed by a conversational principal.`,
			);
		}
		const existing = this.database
			.prepare(`
				SELECT preflight_id, session_digest, attempt_id, lease_expires_at,
					continuation_pending, updated_at
				FROM preflight_attempts
				WHERE preflight_id = ?
			`)
			.get(input.preflightId) as PreflightAttemptRow | undefined;
		if (existing && existing.session_digest !== input.sessionDigest) {
			throw new PreflightError(
				"preflight_conflict",
				`Preflight ${input.preflightId} belongs to another principal session.`,
			);
		}
		if (existing && existing.attempt_id !== input.attemptId && existing.lease_expires_at > Date.now()) {
			throw new PreflightError(
				"preflight_conflict",
				`Preflight ${input.preflightId} is owned by another live principal attempt.`,
			);
		}
		const timestamp = now();
		this.database
			.prepare(`
				INSERT INTO preflight_attempts (
					preflight_id, session_digest, attempt_id, lease_expires_at,
					continuation_pending, updated_at
				) VALUES (?, ?, ?, ?, 0, ?)
				ON CONFLICT(preflight_id) DO UPDATE SET
					session_digest = excluded.session_digest,
					attempt_id = excluded.attempt_id,
					lease_expires_at = excluded.lease_expires_at,
					continuation_pending = 0,
					updated_at = excluded.updated_at
			`)
			.run(input.preflightId, input.sessionDigest, input.attemptId, Date.now() + input.leaseTtlMs, timestamp);
	}

	private assertPreflightAttempt(preflightId: string, attemptId: string): void {
		assertPreflightIdentifier(attemptId, "attemptId");
		const attempt = this.database
			.prepare(`
				SELECT preflight_id, session_digest, attempt_id, lease_expires_at,
					continuation_pending, updated_at
				FROM preflight_attempts
				WHERE preflight_id = ?
			`)
			.get(preflightId) as PreflightAttemptRow | undefined;
		if (!attempt || attempt.attempt_id !== attemptId || attempt.lease_expires_at <= Date.now()) {
			throw new PreflightError(
				"preflight_conflict",
				`Principal attempt does not own live preflight ${preflightId}.`,
			);
		}
	}

	private deletePreflightAttempt(preflightId: string): void {
		this.database.prepare("DELETE FROM preflight_attempts WHERE preflight_id = ?").run(preflightId);
	}

	private releasePreflightAttempt(preflightId: string, attemptId: string): void {
		this.database
			.prepare(`
				UPDATE preflight_attempts
				SET lease_expires_at = 0, continuation_pending = 0, updated_at = ?
				WHERE preflight_id = ? AND attempt_id = ?
			`)
			.run(now(), preflightId, attemptId);
	}

	private openPreflightSync(
		input: PreflightOpenInput,
		admissionKind: PreflightRow["admission_kind"],
	): PreflightReceipt {
		assertPreflightIntentKey(input.intentKey);
		assertDigest(input.objectiveDigest, "objectiveDigest");
		const existing = this.preflightByLookup({ intentKey: input.intentKey });
		if (existing) {
			if (existing.objective_digest !== input.objectiveDigest) {
				throw new PreflightError(
					"preflight_conflict",
					"intentKey is already bound to a different objective digest.",
				);
			}
			if (existing.admission_kind !== admissionKind) {
				throw new PreflightError(
					"preflight_conflict",
					"intentKey is already bound to another preflight admission mode.",
				);
			}
			return preflightReceiptFromRow(existing);
		}
		const timestamp = now();
		const preflightId = makeId("preflight");
		this.database
			.prepare(`
					INSERT INTO preflight_receipts (
						preflight_id, intent_key, objective, admission_kind, state, reason, failure_code,
						correction_count, mission_id, question_digest, answer_digest,
						admission_epoch, created_at, updated_at
					) VALUES (?, ?, ?, ?, 'pending', NULL, NULL, 0, NULL, NULL, NULL, ?, ?, ?)
				`)
			.run(
				preflightId,
				input.intentKey,
				input.objectiveDigest,
				admissionKind,
				this.readSync().admissionEpoch,
				timestamp,
				timestamp,
			);
		const created = this.preflightByLookup({ preflightId });
		if (!created) {
			throw new Error(`Preflight ${preflightId} was not durable after insertion.`);
		}
		return preflightReceiptFromRow(created);
	}

	private deferPreflightSync(
		preflightId: string,
		reason: Exclude<PreflightReceipt["reason"], "analysis_only" | undefined>,
		questionDigest: string,
		attemptId?: string,
	): PreflightReceipt {
		assertPreflightIdentifier(preflightId, "preflightId");
		assertPreflightReason(reason, { allowAnalysisOnly: false });
		assertDigest(questionDigest, "questionDigest");
		const current = this.requirePreflight(preflightId);
		if (attemptId !== undefined) {
			this.assertPreflightAttempt(preflightId, attemptId);
		}
		if (current.state === "needs_input") {
			if (current.reason === reason && current.question_digest === questionDigest) {
				return preflightReceiptFromRow(current);
			}
			throw new PreflightError("preflight_conflict", "Preflight already requires a different bounded input.");
		}
		if (current.state !== "pending") {
			throw invalidPreflightTransition(current.state, "needs_input");
		}
		if (current.correction_count >= PREFLIGHT_MAX_CORRECTIONS) {
			throw new PreflightError(
				"invalid_transition",
				`Preflight ${preflightId} has exhausted its ${PREFLIGHT_MAX_CORRECTIONS} correction rounds.`,
			);
		}
		this.database
			.prepare(`
				UPDATE preflight_receipts
				SET state = 'needs_input', reason = ?, failure_code = NULL,
					mission_id = NULL, question_digest = ?, answer_digest = NULL, updated_at = ?
				WHERE preflight_id = ?
			`)
			.run(reason, questionDigest, now(), preflightId);
		if (attemptId !== undefined) {
			this.releasePreflightAttempt(preflightId, attemptId);
		}
		return preflightReceiptFromRow(this.requirePreflight(preflightId));
	}

	private resolvePreflightSync(input: LegacyPreflightResolveInput): PreflightReceipt {
		assertPreflightIdentifier(input.preflightId, "preflightId");
		if (!["pending", "analysis_only", "launched"].includes(input.state)) {
			throw new PreflightError("invalid_payload", "state must be pending, analysis_only, or launched.");
		}
		if (input.missionId !== undefined) {
			assertPreflightIdentifier(input.missionId, "missionId");
		}
		if (input.answerDigest !== undefined) {
			assertDigest(input.answerDigest, "answerDigest");
		}
		if (input.state !== "launched" && input.missionId !== undefined) {
			throw new PreflightError("invalid_payload", "missionId is only valid when state is launched.");
		}
		if (input.state === "launched" && input.missionId === undefined) {
			throw new PreflightError("invalid_payload", "Launching a preflight requires missionId.");
		}
		if (input.state !== "pending" && input.answerDigest !== undefined) {
			throw new PreflightError("invalid_payload", "answerDigest is only valid when resuming pending.");
		}
		const current = this.requirePreflight(input.preflightId);
		if (input.attemptId !== undefined) {
			this.assertPreflightAttempt(input.preflightId, input.attemptId);
		}
		if (input.state === "pending") {
			if (current.state === "pending") {
				if (input.answerDigest === undefined) {
					return preflightReceiptFromRow(current);
				}
				if (current.answer_digest === input.answerDigest) {
					return preflightReceiptFromRow(current);
				}
				throw new PreflightError(
					"preflight_conflict",
					"Pending preflight is not bound to this clarification answer.",
				);
			}
			if (current.state !== "needs_input") {
				throw invalidPreflightTransition(current.state, "pending");
			}
			if (input.answerDigest === undefined) {
				throw new PreflightError("invalid_payload", "Resuming needs_input requires an answerDigest.");
			}
			if (current.correction_count >= PREFLIGHT_MAX_CORRECTIONS) {
				throw new PreflightError(
					"invalid_transition",
					`Preflight ${input.preflightId} has exhausted its ${PREFLIGHT_MAX_CORRECTIONS} correction rounds.`,
				);
			}
			this.database
				.prepare(`
					UPDATE preflight_receipts
					SET state = 'pending', reason = NULL, failure_code = NULL,
						correction_count = correction_count + 1, mission_id = NULL,
						answer_digest = ?, updated_at = ?
					WHERE preflight_id = ?
				`)
				.run(input.answerDigest, now(), input.preflightId);
			return preflightReceiptFromRow(this.requirePreflight(input.preflightId));
		}
		if (input.state === "analysis_only") {
			if (current.state === "analysis_only") {
				return preflightReceiptFromRow(current);
			}
			if (current.state !== "pending") {
				throw invalidPreflightTransition(current.state, "analysis_only");
			}
			this.database
				.prepare(`
					UPDATE preflight_receipts
					SET state = 'analysis_only', reason = 'analysis_only', failure_code = NULL,
						mission_id = NULL, question_digest = NULL, answer_digest = NULL, updated_at = ?
					WHERE preflight_id = ?
				`)
				.run(now(), input.preflightId);
			this.deletePreflightAttempt(input.preflightId);
			return preflightReceiptFromRow(this.requirePreflight(input.preflightId));
		}
		if (current.state === "launched") {
			if (input.missionId !== undefined && current.mission_id !== null && current.mission_id !== input.missionId) {
				throw new PreflightError(
					"preflight_conflict",
					`Preflight ${input.preflightId} is already bound to another mission.`,
				);
			}
			if (current.mission_id === null && input.missionId !== undefined) {
				this.bindLaunchedPreflight(current, input.missionId);
				return preflightReceiptFromRow(this.requirePreflight(input.preflightId));
			}
			return preflightReceiptFromRow(current);
		}
		if (current.state !== "pending") {
			throw invalidPreflightTransition(current.state, "launched");
		}
		const missionId = input.missionId;
		if (missionId === undefined) {
			throw new PreflightError("invalid_payload", "Launching a preflight requires missionId.");
		}
		this.bindLaunchedPreflight(current, missionId);
		return preflightReceiptFromRow(this.requirePreflight(input.preflightId));
	}

	private correctPreflightSync(preflightId: string): PreflightReceipt {
		assertPreflightIdentifier(preflightId, "preflightId");
		const current = this.requirePreflight(preflightId);
		if (current.state !== "pending") {
			throw invalidPreflightTransition(current.state, "pending");
		}
		if (current.correction_count >= PREFLIGHT_MAX_CORRECTIONS) {
			throw new PreflightError(
				"invalid_transition",
				`Preflight ${preflightId} has exhausted its ${PREFLIGHT_MAX_CORRECTIONS} correction rounds.`,
			);
		}
		this.database
			.prepare(`
				UPDATE preflight_receipts
				SET correction_count = correction_count + 1, updated_at = ?
				WHERE preflight_id = ?
			`)
			.run(now(), preflightId);
		return preflightReceiptFromRow(this.requirePreflight(preflightId));
	}

	private failPreflightSync(input: LegacyPreflightFailInput): PreflightReceipt {
		assertPreflightIdentifier(input.preflightId, "preflightId");
		assertPreflightFailureCode(input.failureCode);
		const current = this.requirePreflight(input.preflightId);
		if (input.attemptId !== undefined) {
			this.assertPreflightAttempt(input.preflightId, input.attemptId);
		}
		if (current.state === "failed" && current.failure_code === input.failureCode) {
			return preflightReceiptFromRow(current);
		}
		if (current.state !== "pending" && current.state !== "needs_input") {
			throw invalidPreflightTransition(current.state, "failed");
		}
		this.database
			.prepare(`
				UPDATE preflight_receipts
				SET state = 'failed', reason = NULL, failure_code = ?,
					mission_id = NULL, question_digest = NULL, answer_digest = NULL, updated_at = ?
				WHERE preflight_id = ?
			`)
			.run(input.failureCode, now(), input.preflightId);
		this.deletePreflightAttempt(input.preflightId);
		return preflightReceiptFromRow(this.requirePreflight(input.preflightId));
	}

	private bindLaunchedPreflight(current: PreflightRow, missionId: string): void {
		assertPreflightIdentifier(missionId, "missionId");
		if (current.state === "launched") {
			if (current.mission_id !== null && current.mission_id !== missionId) {
				throw new PreflightError(
					"preflight_conflict",
					`Preflight ${current.preflight_id} is already bound to another mission.`,
				);
			}
		} else if (current.state !== "pending") {
			throw invalidPreflightTransition(current.state, "launched");
		}
		this.database
			.prepare(`
				UPDATE preflight_receipts
				SET state = 'launched', reason = NULL, failure_code = NULL,
					mission_id = ?, updated_at = ?
				WHERE preflight_id = ?
			`)
			.run(missionId, now(), current.preflight_id);
		this.deletePreflightAttempt(current.preflight_id);
	}

	private missionLaunchReceipt(mission: ResearchMission, accepted: boolean): DurableMissionLaunchReceipt {
		const preflightId = mission.preflightId;
		const launchOperationId = mission.launchOperationId;
		if (!preflightId || !launchOperationId) {
			throw new Error(`Mission ${mission.id} is missing its durable launch identity.`);
		}
		const receipt: MissionReceipt = {
			missionId: mission.id,
			preflightId,
			launchOperationId,
			phase: mission.phase,
			accepted,
			campaignId: mission.campaignId,
		};
		return {
			mission: receipt,
			preflight: preflightReceiptFromRow(this.requirePreflight(preflightId)),
		};
	}

	private writeTransaction<T>(execute: () => T): Promise<T> {
		const operation = this.writeQueue.then(() => {
			this.database.exec("BEGIN IMMEDIATE");
			try {
				const result = execute();
				this.database.exec("COMMIT");
				return result;
			} catch (error) {
				this.database.exec("ROLLBACK");
				throw error;
			}
		});
		this.writeQueue = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	}

	private persistState(state: IsoState, existingEvents: ReadonlySet<string>): void {
		const newEvents = state.events.filter((event) => !existingEvents.has(event.id));
		this.database
			.prepare("UPDATE state SET state_json = ? WHERE id = 1")
			.run(JSON.stringify(stateWithoutEvents(state)));
		const insertEvent = this.database.prepare(`
			INSERT INTO events (
				id, campaign_id, generation_id, experiment_id, type, summary,
				actor, at, refs_json, data_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		`);
		for (const event of newEvents) {
			insertEvent.run(
				event.id,
				event.campaignId,
				event.generationId ?? null,
				event.experimentId ?? null,
				event.type,
				event.summary,
				event.actor,
				event.at,
				JSON.stringify(event.refs),
				event.data ? JSON.stringify(event.data) : null,
			);
		}
	}

	private preflightByLookup(lookup: PreflightLookup): PreflightRow | undefined {
		if ("preflightId" in lookup) {
			return this.database
				.prepare(`
					SELECT preflight_id, intent_key, objective AS objective_digest,
						admission_kind, state, reason, failure_code,
						correction_count, mission_id, question_digest,
						answer_digest, admission_epoch, created_at, updated_at
					FROM preflight_receipts
					WHERE preflight_id = ?
				`)
				.get(lookup.preflightId) as PreflightRow | undefined;
		}
		return this.database
			.prepare(`
				SELECT preflight_id, intent_key, objective AS objective_digest,
					admission_kind, state, reason, failure_code,
					correction_count, mission_id, question_digest,
					answer_digest, admission_epoch, created_at, updated_at
				FROM preflight_receipts
				WHERE intent_key = ?
			`)
			.get(lookup.intentKey) as PreflightRow | undefined;
	}

	private requirePreflight(preflightId: string): PreflightRow {
		const row = this.preflightByLookup({ preflightId });
		if (!row) {
			throw new PreflightError("preflight_not_found", `Preflight ${preflightId} does not exist.`);
		}
		return row;
	}

	private readSync(): IsoState {
		const row = this.database.prepare("SELECT state_json FROM state WHERE id = 1").get() as StateRow | undefined;
		if (!row) {
			throw new Error(`Missing ISO state in ${this.statePath}`);
		}
		const parsed: unknown = JSON.parse(row.state_json);
		if (!isIsoState(parsed)) {
			throw new Error(`Invalid ISO state in ${this.statePath}`);
		}
		const state = normalizeState(parsed);
		const rows = this.database
			.prepare(`
				SELECT sequence, id, campaign_id, generation_id, experiment_id, type,
					summary, actor, at, refs_json, data_json
				FROM events
				ORDER BY sequence DESC
				LIMIT ?
			`)
			.all(EVENT_WINDOW) as unknown as EventRow[];
		return {
			...structuredClone(state),
			events: rows.reverse().map(eventFromRow),
		};
	}
}

function preflightReceiptFromRow(row: PreflightRow): PreflightReceipt {
	return {
		preflightId: row.preflight_id,
		intentKey: row.intent_key,
		objectiveDigest: row.objective_digest,
		state: row.state,
		...(row.reason === null ? {} : { reason: row.reason }),
		...(row.failure_code === null ? {} : { failureCode: row.failure_code }),
		correctionCount: row.correction_count,
		...(row.mission_id === null ? {} : { missionId: row.mission_id }),
		...(row.question_digest === null ? {} : { questionDigest: row.question_digest }),
		...(row.answer_digest === null ? {} : { answerDigest: row.answer_digest }),
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

function invalidPreflightTransition(from: PreflightState, to: PreflightState): PreflightError {
	return new PreflightError("invalid_transition", `Cannot transition preflight from ${from} to ${to}.`);
}

function eventFromRow(event: EventRow): IsoEvent {
	return {
		id: event.id,
		sequence: event.sequence,
		campaignId: event.campaign_id,
		generationId: event.generation_id ?? undefined,
		experimentId: event.experiment_id ?? undefined,
		type: event.type,
		summary: event.summary,
		actor: event.actor,
		at: event.at,
		refs: parseStringArray(event.refs_json),
		data: parseEventData(event.data_json),
	};
}

export function getActiveCampaign(state: IsoState): Campaign | undefined {
	return state.campaigns
		.slice()
		.reverse()
		.find((campaign) => !["completed", "stopped", "failed"].includes(campaign.status));
}

export function getActiveMission(state: IsoState): ResearchMission | undefined {
	return state.missions
		.slice()
		.reverse()
		.find((mission) => !["completed", "stopped", "failed"].includes(mission.phase));
}

export function appendMissionDiagnostic(
	mission: ResearchMission,
	options: {
		phase: MissionPhase;
		code: string;
		message: string;
		retryable: boolean;
	},
): void {
	mission.diagnostics.push({
		id: makeId("diagnostic"),
		phase: options.phase,
		code: options.code,
		message: options.message.slice(0, 8_000),
		retryable: options.retryable,
		at: now(),
	});
	if (mission.diagnostics.length > MAX_DIAGNOSTICS) {
		mission.diagnostics.splice(0, mission.diagnostics.length - MAX_DIAGNOSTICS);
	}
}

export function appendMaterialUpdate(
	state: IsoState,
	options: Omit<MaterialUpdate, "sequence" | "at"> & { at?: string },
): MaterialUpdate {
	const update: MaterialUpdate = {
		sequence: state.nextMaterialUpdateSequence,
		missionId: options.missionId,
		campaignId: options.campaignId,
		kind: options.kind,
		summary: options.summary.slice(0, 8_000),
		at: options.at ?? now(),
		refs: options.refs.slice(0, 32).map((reference) => reference.slice(0, 512)),
	};
	state.nextMaterialUpdateSequence += 1;
	state.materialUpdates.push(update);
	return update;
}

export function queueRetry(
	state: IsoState,
	options: Omit<ExperimentRetry, "id" | "createdAt" | "status">,
): ExperimentRetry {
	const existing = state.retryQueue.find(
		(retry) => retry.sourceExperimentId === options.sourceExperimentId && retry.attempt === options.attempt,
	);
	if (existing) {
		return existing;
	}
	const retry: ExperimentRetry = {
		...options,
		id: makeId("retry"),
		status: "queued",
		createdAt: now(),
	};
	state.retryQueue.push(retry);
	return retry;
}

export function fingerprintIdea(proposal: ProposedIdea): string {
	return `${proposal.hypothesis} ${proposal.implementationPlan}`
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}

export function createEvent(options: {
	campaignId: string;
	generationId?: string;
	experimentId?: string;
	type: string;
	summary: string;
	actor: IsoEvent["actor"];
	refs?: string[];
	data?: Record<string, unknown>;
}): IsoEvent {
	return {
		id: makeId("event"),
		campaignId: options.campaignId,
		generationId: options.generationId,
		experimentId: options.experimentId,
		type: options.type,
		summary: options.summary,
		actor: options.actor,
		at: now(),
		refs: options.refs ?? [],
		data: options.data,
	};
}
