import { createHash, randomBytes } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { hostname } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";
import { PiResearchAgents, type ResearchAgents, type WorkerControl, type WorkerOutcome } from "./agents.ts";
import {
	assertControlPrecondition,
	ControlConflictError,
	type ControlContext,
	controlContextForState,
	type ResearchControlAction,
	type ResearchControlOutcome,
	type ResearchControlReceipt,
	type ResearchControlRequest,
} from "./control.ts";
import { EvaluatorContractError, type Evaluation as EvaluatorEvaluation, runEvaluator } from "./evaluator.ts";
import {
	activateDependencySnapshot,
	assertEvaluatorDigest,
	CandidatePolicyError,
	createDetachedWorktree,
	createEvaluatorControlWorktree,
	createExperimentWorktree,
	createGenerationWorktree,
	EvaluatorIntegrityError,
	evaluatorDigest,
	isoWorktreeRoot,
	normalizeRepositoryRelativePath,
	pinSourceSnapshot,
	prepareDependencySnapshot,
	removeIsoWorktrees,
	removeWorktree,
	resolveCommit,
	snapshotCurrentWorktree,
	snapshotExperiment,
	sourceSnapshotChangedPaths,
} from "./git.ts";
import { buildIdeaGraph } from "./graph.ts";
import { canonicalPayloadDigest, type DurableMissionLaunchReceipt, preflightLaunchIdentity } from "./preflight.ts";
import { currentRuntimeProvenance, sameRuntimeProvenance } from "./provenance.ts";
import { decidePostSelection, type PostSelectionTrial } from "./selection.ts";
import {
	appendMaterialUpdate,
	appendMissionDiagnostic,
	createEvent,
	fingerprintIdea,
	getActiveCampaign,
	getActiveMission,
	IsoStore,
	makeId,
	now,
	queueRetry,
} from "./store.ts";
import type {
	AgentCallAttempt,
	AgentCallRole,
	AgentCallStatus,
	AgentProvenance,
	AgentUsageSummary,
	Campaign,
	CampaignCompletionReport,
	CampaignCreateInput,
	CampaignSummary,
	ChampionHandoff,
	ConfirmationEvidence,
	ConfirmationIntervalEvidence,
	DashboardSnapshot,
	EvaluationAggregate,
	EvaluationSample,
	EvaluationSampleIdentity,
	EvidencePage,
	EvidenceQueryInput,
	Experiment,
	ExperimentEvidence,
	ExperimentFailure,
	ExperimentRetry,
	Generation,
	GenerationReflection,
	Idea,
	IsoState,
	MissionReceipt,
	OperatorNote,
	PairedEvaluationPlan,
	ProposedIdea,
	Reflection,
	ResearchMission,
	ResearchMissionInput,
	SourceBundleIdentity,
	StatisticSummary,
	WorkerSnapshot,
} from "./types.ts";

interface ActiveExperiment {
	snapshot: WorkerSnapshot;
	controller: AbortController;
	control?: WorkerControl;
	detachRunAbort?: () => void;
}

class IncumbentInvalidError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "IncumbentInvalidError";
	}
}

class PostFreezeEvaluationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "PostFreezeEvaluationError";
	}
}

export interface ResearchReceipt {
	runId: string;
	started: boolean;
}

export interface CampaignCalibrationInput {
	goal: string;
	metric: CampaignCreateInput["metric"];
	config: CampaignCreateInput["config"];
	sourceCommit?: string;
	sourceHeadCommit?: string;
	sourceSnapshotRef?: string;
	sourceHadLocalChanges?: boolean;
	sourceSnapshotPaths?: string[];
	dependencyDigest?: string;
	/** Internal compare-and-swap barrier for standalone calibration admission. */
	expectedAdmissionEpoch?: number;
	signal?: AbortSignal;
}

export interface ConversationalMissionLaunch {
	preflightId: string;
	attemptId?: string;
	launchOperationId: string;
	inputDigest: string;
	requestId: string;
	requestFingerprint: string;
}

export interface DirectMissionLaunch {
	requestId: string;
	requestFingerprint: string;
}

export interface CurrentResearchControlRequest {
	actionId: string;
	actionFingerprint: string;
	action: ResearchControlAction;
}

export interface NoTargetResearchControlReceipt {
	actionId: string;
	actionFingerprint: string;
	targetKind: "none";
	targetId: "none";
	acceptedControlFingerprint: "none";
	revision: number;
	outcome: Exclude<ResearchControlOutcome, { kind: "note" }>;
}

export type CurrentResearchControlReceipt = ResearchControlReceipt | NoTargetResearchControlReceipt;

interface PlannedProposal {
	proposal: ProposedIdea;
	source: Idea["source"];
	attempt: number;
	retryOfExperimentId?: string;
	operatorNoteId?: string;
	retryId?: string;
}

const ORCHESTRATOR_LEASE = "orchestrator";
const LEASE_TTL_MS = 30_000;
const MAX_EXPERIMENT_ATTEMPTS = 3;
const MAX_POST_FREEZE_ATTEMPTS_PER_RUN = 3;
const MAX_EVIDENCE_PAGE = 20;
const DEFAULT_EVIDENCE_PAGE = 20;
const MAX_EVIDENCE_TEXT = 8_000;
const MAX_RECENT_UPDATES = 10;
const MAX_CONFIRMATION_HISTORY = 10;
const FROZEN_EVALUATOR_PATH = /^\.iso\/evaluators\/frozen\/([a-f0-9]{64})\.mjs$/u;
const GIT_COMMIT_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u;
const DEPENDENCY_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const PERSISTED_SAMPLE_OUTPUT_BYTES = 4_096;
const NORMAL_975 = 1.959963984540054;
const STUDENT_T_975 = [
	12.706204736174705, 4.302652729749464, 3.1824463052837095, 2.7764451051977943, 2.5705818356363155, 2.44691185114497,
	2.3646242515927853, 2.3060041352041667, 2.2621571627982053, 2.228138851986275, 2.2009851600916397, 2.178812829667229,
	2.1603686564627926, 2.144786687917804, 2.1314495455597755, 2.1199052992212546, 2.109815577833317, 2.1009220402410387,
	2.0930240544083096, 2.085963447265865, 2.0796138447276804, 2.0738730679040263, 2.0686576104190486, 2.063898561628026,
	2.0595385527532977, 2.055529438642873, 2.0518305164802855, 2.048407141795245, 2.0452296421327043, 2.042272456301238,
] as const;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function selectedCampaign(state: IsoState): Campaign | undefined {
	const activeMission = getActiveMission(state);
	if (activeMission) {
		return activeMission.campaignId
			? state.campaigns.find((campaign) => campaign.id === activeMission.campaignId)
			: undefined;
	}
	return getActiveCampaign(state) ?? state.campaigns.at(-1);
}

function selectedMission(state: IsoState, campaign?: Campaign, preferActive = true): ResearchMission | undefined {
	if (preferActive) {
		const activeMission = getActiveMission(state);
		if (activeMission) {
			return activeMission;
		}
	}
	if (campaign) {
		return campaign.missionId ? state.missions.find((mission) => mission.id === campaign.missionId) : undefined;
	}
	return state.missions.at(-1);
}

function campaignFor(state: IsoState): Campaign {
	const campaign = getActiveCampaign(state);
	if (!campaign) {
		throw new Error("No active ISO campaign. Ask ISO to establish a research campaign first.");
	}
	return campaign;
}

function persistedMissionInput(input: CampaignCalibrationInput): ResearchMissionInput {
	const source = sourceBundleFromInput(input);
	if (!source) {
		throw new Error("A durable research mission requires a frozen source bundle.");
	}
	return {
		goal: input.goal,
		metric: structuredClone(input.metric),
		config: structuredClone(input.config),
		...source,
	};
}

function sourceBundleFromInput(input: CampaignCalibrationInput): SourceBundleIdentity | undefined {
	const fields = [
		input.sourceCommit,
		input.sourceHeadCommit,
		input.sourceSnapshotRef,
		input.sourceHadLocalChanges,
		input.sourceSnapshotPaths,
		input.dependencyDigest,
	];
	const present = fields.filter((value) => value !== undefined).length;
	if (present === 0) {
		return undefined;
	}
	if (present !== fields.length) {
		throw new Error(
			"Source bundle identity must include sourceCommit, sourceHeadCommit, sourceSnapshotRef, sourceHadLocalChanges, sourceSnapshotPaths, and dependencyDigest.",
		);
	}
	const {
		sourceCommit,
		sourceHeadCommit,
		sourceSnapshotRef,
		sourceHadLocalChanges,
		sourceSnapshotPaths,
		dependencyDigest,
	} = input;
	if (
		typeof sourceCommit !== "string" ||
		!GIT_COMMIT_PATTERN.test(sourceCommit) ||
		typeof sourceHeadCommit !== "string" ||
		!GIT_COMMIT_PATTERN.test(sourceHeadCommit)
	) {
		throw new Error("Source bundle commits must be lowercase Git object IDs.");
	}
	if (sourceSnapshotRef !== `refs/iso/source-snapshots/${sourceCommit}`) {
		throw new Error("Source snapshot ref must be the immutable private ref for sourceCommit.");
	}
	if (typeof sourceHadLocalChanges !== "boolean") {
		throw new Error("sourceHadLocalChanges must be a boolean.");
	}
	if (!Array.isArray(sourceSnapshotPaths) || sourceSnapshotPaths.length > 250) {
		throw new Error("sourceSnapshotPaths must contain at most 250 repository-relative paths.");
	}
	const normalizedPaths = sourceSnapshotPaths.map((path) => {
		if (typeof path !== "string" || Buffer.byteLength(path) > 4 * 1024) {
			throw new Error("Each source snapshot path must be a string of at most 4096 bytes.");
		}
		const normalized = normalizeRepositoryRelativePath(path, "Source snapshot path");
		if (normalized !== path) {
			throw new Error(`Source snapshot path was not canonical: ${path}`);
		}
		return normalized;
	});
	if (
		new Set(normalizedPaths).size !== normalizedPaths.length ||
		normalizedPaths.reduce((total, path) => total + Buffer.byteLength(path), 0) > 256 * 1024
	) {
		throw new Error("Source snapshot paths must be unique and fit ISO's bounded path budget.");
	}
	if (sourceHadLocalChanges !== (sourceCommit !== sourceHeadCommit)) {
		throw new Error("sourceHadLocalChanges does not match the frozen source commits.");
	}
	if (typeof dependencyDigest !== "string" || !DEPENDENCY_DIGEST_PATTERN.test(dependencyDigest)) {
		throw new Error("dependencyDigest must be a lowercase SHA-256 digest.");
	}
	return {
		sourceCommit,
		sourceHeadCommit,
		sourceSnapshotRef,
		sourceHadLocalChanges,
		sourceSnapshotPaths: [...normalizedPaths].sort(),
		dependencyDigest,
	};
}

function boundedText(value: string | undefined, maximum = MAX_EVIDENCE_TEXT): string | undefined {
	return value === undefined ? undefined : value.slice(0, maximum);
}

function championHandoffFor(state: IsoState, campaign: Campaign): ChampionHandoff | undefined {
	const experiment = state.experiments.find((candidate) => candidate.id === campaign.championExperimentId);
	if (!experiment?.candidateCommit) {
		return undefined;
	}
	const baselineScore = campaign.baseline.evaluation.score.mean;
	const championEvaluation = experiment.confirmationEvaluation ?? experiment.evaluation;
	const championScore = championEvaluation?.score.mean ?? baselineScore;
	const cumulativeImprovement = improvementFor(campaign, championScore, baselineScore);
	const cumulativeUncertainty = championEvaluation
		? confidenceIntervalFor(championEvaluation, campaign.baseline.evaluation).uncertainty
		: undefined;
	const stepImprovement = experiment.confirmationImprovement ?? experiment.improvement;
	const stepUncertainty = experiment.confirmationUncertainty ?? experiment.uncertainty;
	return {
		campaignId: campaign.id,
		experimentId: experiment.id,
		ideaId: experiment.ideaId,
		sourceCommit: campaign.sourceCommit,
		candidateCommit: experiment.candidateCommit,
		diffStat: boundedText(experiment.diffStat, 4_000),
		changedPaths: experiment.changedPaths.slice(0, 100).map((path) => path.slice(0, 1_024)),
		baselineScore,
		championScore,
		cumulativeImprovement,
		cumulativeUncertainty,
		stepImprovement,
		stepUncertainty,
		improvement: cumulativeImprovement,
		uncertainty: cumulativeUncertainty,
		confirmationRoundsPassed: experiment.confirmationRoundsPassed ?? 0,
		applyPrecondition: {
			expectedHead: campaign.sourceHeadCommit ?? campaign.sourceCommit,
			requiresCleanWorktree: true,
			requiresDirtySourceReconciliation: campaign.sourceHadLocalChanges === true,
			sourceSnapshotPaths: (campaign.sourceSnapshotPaths ?? []).slice(0, 100).map((path) => path.slice(0, 1_024)),
		},
	};
}

function agentUsageFor(state: IsoState, campaignId: string): AgentUsageSummary {
	const attempts = state.agentCallAttempts.filter((attempt) => attempt.campaignId === campaignId);
	return {
		inputTokens: attempts.reduce((total, attempt) => total + (attempt.inputTokens ?? 0), 0),
		outputTokens: attempts.reduce((total, attempt) => total + (attempt.outputTokens ?? 0), 0),
		costUsd: attempts.reduce((total, attempt) => total + (attempt.costUsd ?? 0), 0),
		agentCalls: attempts.length,
		callsMissingTokenAccounting: attempts.filter((attempt) => attempt.missingTokenAccounting).length,
		callsMissingCostAccounting: attempts.filter((attempt) => attempt.missingCostAccounting).length,
	};
}

function completionReportFor(
	state: IsoState,
	campaign: Campaign,
	outcome: CampaignCompletionReport["outcome"],
	reason: string,
): CampaignCompletionReport {
	const findings = state.reflections
		.filter((reflection) => reflection.campaignId === campaign.id)
		.slice(-10)
		.flatMap((reflection) => [reflection.summary, ...reflection.lessons.slice(0, 5)])
		.map((finding) => finding.slice(0, 2_000));
	return {
		campaignId: campaign.id,
		missionId: campaign.missionId,
		outcome,
		reason: reason.slice(0, MAX_EVIDENCE_TEXT),
		goal: campaign.goal.slice(0, MAX_EVIDENCE_TEXT),
		metric: { ...campaign.metric, name: campaign.metric.name.slice(0, 1_000) },
		baselineScore: campaign.baseline.evaluation.score.mean,
		champion: championHandoffFor(state, campaign),
		generationsCompleted: campaign.generationsCompleted,
		experimentsStarted: campaign.experimentsStarted,
		measuredExperiments: state.experiments.filter(
			(experiment) => experiment.campaignId === campaign.id && experiment.status === "measured",
		).length,
		failures: campaign.failures,
		agentUsage: agentUsageFor(state, campaign.id),
		keyFindings: findings.slice(0, 30),
		generatedAt: now(),
	};
}

function finishMissionForCampaign(
	state: IsoState,
	campaign: Campaign,
	outcome: CampaignCompletionReport["outcome"],
	reason: string,
): void {
	const report = completionReportFor(state, campaign, outcome, reason);
	campaign.completionReport = report;
	if (!campaign.missionId) {
		return;
	}
	const mission = state.missions.find((candidate) => candidate.id === campaign.missionId);
	if (!mission) {
		return;
	}
	mission.phase = outcome;
	mission.desiredState = outcome === "stopped" ? "stopped" : mission.desiredState;
	mission.completionReport = report;
	mission.completedAt = report.generatedAt;
	mission.updatedAt = report.generatedAt;
	appendMissionDiagnostic(mission, {
		phase: mission.phase,
		code: `campaign_${outcome}`,
		message: reason,
		retryable: false,
	});
	appendMaterialUpdate(state, {
		missionId: mission.id,
		campaignId: campaign.id,
		kind: outcome === "failed" ? "failure" : "completion",
		summary: reason,
		refs: [mission.id, campaign.id, ...(report.champion ? [report.champion.experimentId] : [])],
	});
}

function parseOffsetCursor(cursor: string | undefined): number {
	if (cursor === undefined) {
		return 0;
	}
	if (!/^(0|[1-9][0-9]{0,9})$/.test(cursor)) {
		throw new Error("Evidence cursor is invalid.");
	}
	return Number(cursor);
}

async function frozenEvaluatorReadPaths(repoRoot: string, protectedPaths: string[]): Promise<string[]> {
	const evaluatorPaths = protectedPaths.filter((path) => path.startsWith(".iso/evaluators/"));
	if (evaluatorPaths.some((path) => !FROZEN_EVALUATOR_PATH.test(path))) {
		throw new Error("Frozen evaluator paths must match .iso/evaluators/frozen/<64 lowercase hex>.mjs exactly.");
	}
	if (evaluatorPaths.length > 1) {
		throw new Error("A campaign may trust at most one frozen evaluator artifact.");
	}
	const canonicalRepoRoot = await realpath(repoRoot);
	return Promise.all(
		evaluatorPaths.map(async (path) => {
			const match = FROZEN_EVALUATOR_PATH.exec(path);
			const expectedDigest = match?.[1];
			if (expectedDigest === undefined) {
				throw new Error("Frozen evaluator path did not contain a content digest.");
			}
			const absolutePath = resolve(canonicalRepoRoot, path);
			const before = await lstat(absolutePath);
			if (!before.isFile() || before.isSymbolicLink() || (await realpath(absolutePath)) !== absolutePath) {
				throw new Error("Frozen evaluator must be a real file inside the repository.");
			}
			const content = await readFile(absolutePath);
			const after = await lstat(absolutePath);
			if (
				after.dev !== before.dev ||
				after.ino !== before.ino ||
				after.mode !== before.mode ||
				after.size !== before.size ||
				after.mtimeMs !== before.mtimeMs ||
				after.ctimeMs !== before.ctimeMs ||
				createHash("sha256").update(content).digest("hex") !== expectedDigest
			) {
				throw new Error("Frozen evaluator failed content-address verification.");
			}
			return absolutePath;
		}),
	);
}

async function captureSourceBundle(repoRoot: string, goal: string): Promise<SourceBundleIdentity> {
	const snapshot = await snapshotCurrentWorktree({
		repoRoot,
		message: `ISO source snapshot for ${goal.slice(0, 512)}`,
		publishRef: false,
	});
	const dependencyDigest = await prepareDependencySnapshot(repoRoot);
	const confirmation = await snapshotCurrentWorktree({
		repoRoot,
		message: `ISO source verification for ${goal.slice(0, 512)}`,
		publishRef: false,
	});
	if (
		confirmation.baseCommit !== snapshot.baseCommit ||
		confirmation.tree !== snapshot.tree ||
		!isDeepStrictEqual(confirmation.changedPaths, snapshot.changedPaths) ||
		!isDeepStrictEqual(confirmation.excludedPaths, snapshot.excludedPaths)
	) {
		throw new Error("Repository source changed while ISO froze its dependency bundle.");
	}
	const sourceSnapshotRef = await pinSourceSnapshot(repoRoot, snapshot.commit);
	return {
		sourceCommit: snapshot.commit,
		sourceHeadCommit: snapshot.baseCommit,
		sourceSnapshotRef,
		sourceHadLocalChanges: snapshot.commit !== snapshot.baseCommit,
		sourceSnapshotPaths: snapshot.changedPaths,
		dependencyDigest,
	};
}

async function verifySourceBundle(repoRoot: string, source: SourceBundleIdentity): Promise<void> {
	const [refCommit, directCommit, headCommit] = await Promise.all([
		resolveCommit(repoRoot, source.sourceSnapshotRef),
		resolveCommit(repoRoot, source.sourceCommit),
		resolveCommit(repoRoot, source.sourceHeadCommit),
	]);
	if (
		refCommit !== source.sourceCommit ||
		directCommit !== source.sourceCommit ||
		headCommit !== source.sourceHeadCommit
	) {
		throw new Error("Frozen source bundle no longer resolves to its accepted commits.");
	}
	if (source.sourceCommit !== source.sourceHeadCommit) {
		const parentCommit = await resolveCommit(repoRoot, `${source.sourceCommit}^`);
		if (parentCommit !== source.sourceHeadCommit) {
			throw new Error("Frozen dirty source snapshot is not rooted at its accepted HEAD commit.");
		}
	}
	const changedPaths = await sourceSnapshotChangedPaths(repoRoot, source.sourceHeadCommit, source.sourceCommit);
	if (!isDeepStrictEqual(changedPaths, source.sourceSnapshotPaths)) {
		throw new Error("Frozen source snapshot paths do not match the accepted source commit.");
	}
	await activateDependencySnapshot(repoRoot, source.dependencyDigest);
}

function statistic(values: number[]): StatisticSummary {
	const sorted = [...values].sort((left, right) => left - right);
	const mean = sorted.reduce((total, value) => total + value, 0) / sorted.length;
	const middle = Math.floor(sorted.length / 2);
	const median = sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
	const variance =
		sorted.length > 1 ? sorted.reduce((total, value) => total + (value - mean) ** 2, 0) / (sorted.length - 1) : 0;
	return {
		mean,
		median,
		stddev: Math.sqrt(variance),
		min: sorted[0],
		max: sorted.at(-1) ?? sorted[0],
	};
}

function domainEvaluation(evaluation: EvaluatorEvaluation): EvaluationAggregate {
	const metricNames = new Set(evaluation.samples.flatMap((sample) => Object.keys(sample.metrics)));
	const metrics: Record<string, StatisticSummary> = {};
	for (const name of metricNames) {
		const values = evaluation.samples
			.map((sample) => sample.metrics[name])
			.filter((value): value is number => value !== undefined);
		if (values.length > 0) {
			metrics[name] = statistic(values);
		}
	}
	const samples: EvaluationSample[] = evaluation.samples.map((sample) => ({
		score: sample.score,
		metrics: sample.metrics,
		summary: sample.summary,
		valid: sample.valid,
		constraints: sample.constraints,
		trialId: sample.trialId,
		phase: sample.phase,
		sampleIndex: sample.sampleIndex,
		seed: sample.seed,
		durationMs: sample.durationMs,
		stdout: sample.stdout.slice(-PERSISTED_SAMPLE_OUTPUT_BYTES),
		stderr: sample.stderr.slice(-PERSISTED_SAMPLE_OUTPUT_BYTES),
	}));
	return {
		score: statistic(evaluation.samples.map((sample) => sample.score)),
		metrics,
		samples,
		valid: evaluation.valid,
		failedConstraints: Object.entries(evaluation.constraints)
			.filter(([, passed]) => !passed)
			.map(([name]) => name),
		measuredAt: now(),
	};
}

function combineIndependentEvaluations(evaluations: EvaluationAggregate[]): EvaluationAggregate {
	const samples = evaluations.flatMap((evaluation, sampleIndex) =>
		evaluation.samples.map((sample) => ({ ...sample, sampleIndex })),
	);
	if (samples.length !== evaluations.length || samples.length === 0) {
		throw new EvaluatorContractError(
			"Each fresh evaluator materialization must produce exactly one measured sample.",
		);
	}
	const metricNames = new Set(samples.flatMap((sample) => Object.keys(sample.metrics)));
	const metrics: Record<string, StatisticSummary> = {};
	for (const name of metricNames) {
		const values = samples
			.map((sample) => sample.metrics[name])
			.filter((value): value is number => value !== undefined);
		if (values.length > 0) {
			metrics[name] = statistic(values);
		}
	}
	return {
		score: statistic(samples.map((sample) => sample.score)),
		metrics,
		samples,
		valid: evaluations.every((evaluation) => evaluation.valid),
		failedConstraints: [...new Set(evaluations.flatMap((evaluation) => evaluation.failedConstraints))].sort(),
		measuredAt: now(),
	};
}

function improvementFor(campaign: Campaign, candidate: number, incumbent: number): number {
	return campaign.metric.direction === "maximize" ? candidate - incumbent : incumbent - candidate;
}

interface EvaluationResultSchema {
	metrics: string[];
	constraints: string[];
}

function resultSchemaForSample(sample: EvaluationSample): EvaluationResultSchema {
	return {
		metrics: Object.keys(sample.metrics).sort(),
		constraints: Object.keys(sample.constraints).sort(),
	};
}

function assertMatchingResultSchema(expected: EvaluationResultSchema, actual: EvaluationResultSchema): void {
	if (!isDeepStrictEqual(expected.metrics, actual.metrics)) {
		throw new EvaluatorContractError(
			`Evaluator metric schema changed from [${expected.metrics.join(", ")}] to [${actual.metrics.join(", ")}].`,
		);
	}
	if (!isDeepStrictEqual(expected.constraints, actual.constraints)) {
		throw new EvaluatorContractError(
			`Evaluator constraint schema changed from [${expected.constraints.join(", ")}] to [${actual.constraints.join(", ")}].`,
		);
	}
}

function resultSchemaForEvaluation(evaluation: EvaluationAggregate): EvaluationResultSchema {
	const firstSample = evaluation.samples[0];
	if (!firstSample) {
		throw new EvaluatorContractError("Evaluator aggregate must contain at least one measured sample.");
	}
	const schema = resultSchemaForSample(firstSample);
	for (const sample of evaluation.samples) {
		assertMatchingResultSchema(schema, resultSchemaForSample(sample));
	}
	return schema;
}

function assertFrozenResultContract(campaign: Campaign, evaluation: EvaluationAggregate): void {
	const expectedDigest = campaign.baseline.resultSchemaDigest;
	const baselineSchema = resultSchemaForEvaluation(campaign.baseline.evaluation);
	for (const sample of evaluation.samples) {
		assertMatchingResultSchema(baselineSchema, resultSchemaForSample(sample));
	}
	const baselineDigest = resultSchemaDigest(campaign.baseline.evaluation);
	if (expectedDigest && baselineDigest !== expectedDigest) {
		throw new EvaluatorContractError("Baseline evaluator result schema no longer matches calibration.");
	}
	if (expectedDigest && resultSchemaDigest(evaluation) !== expectedDigest) {
		throw new EvaluatorContractError("Evaluator result schema changed after calibration.");
	}
	assertEvaluationWithinScoreBounds(campaign.config.evaluator.scoreBounds, evaluation);
}

function assertEvaluationWithinScoreBounds(
	scoreBounds: Campaign["config"]["evaluator"]["scoreBounds"],
	evaluation: EvaluationAggregate,
): void {
	if (!scoreBounds) {
		return;
	}
	for (const [index, sample] of evaluation.samples.entries()) {
		if (sample.score < scoreBounds.min || sample.score > scoreBounds.max) {
			throw new EvaluatorContractError(
				`Evaluator score ${sample.score} at sample ${index} is outside declared bounds [${scoreBounds.min}, ${scoreBounds.max}].`,
			);
		}
	}
}

function resultSchemaDigest(evaluation: EvaluationAggregate): string {
	return createHash("sha256")
		.update(JSON.stringify(resultSchemaForEvaluation(evaluation)))
		.digest("hex");
}

export function critical95(degreesOfFreedom: number): number {
	if (!Number.isInteger(degreesOfFreedom) || degreesOfFreedom < 1) {
		throw new RangeError("degreesOfFreedom must be a positive integer.");
	}
	const exact = STUDENT_T_975[degreesOfFreedom - 1];
	if (exact !== undefined) {
		return exact;
	}

	// Cornish-Fisher expansion of the t quantile through the 1 / df^4 term.
	const inverseDegrees = 1 / degreesOfFreedom;
	const z = NORMAL_975;
	const z2 = z * z;
	const z3 = z2 * z;
	const z5 = z3 * z2;
	const z7 = z5 * z2;
	const z9 = z7 * z2;
	return (
		z +
		((z3 + z) / 4) * inverseDegrees +
		((5 * z5 + 16 * z3 + 3 * z) / 96) * inverseDegrees ** 2 +
		((3 * z7 + 19 * z5 + 17 * z3 - 15 * z) / 384) * inverseDegrees ** 3 +
		((79 * z9 + 776 * z7 + 1482 * z5 - 1920 * z3 - 945 * z) / 92_160) * inverseDegrees ** 4
	);
}

type ConfidenceIntervalCalculation = Omit<ConfirmationIntervalEvidence, "lowerBound">;

function confidenceIntervalFor(
	candidate: EvaluationAggregate,
	incumbent: EvaluationAggregate,
): ConfidenceIntervalCalculation {
	const paired =
		candidate.samples.length === incumbent.samples.length &&
		candidate.samples.length > 1 &&
		candidate.samples.every(
			(sample, index) =>
				sample.trialId !== undefined &&
				sample.trialId === incumbent.samples[index].trialId &&
				sample.sampleIndex === incumbent.samples[index].sampleIndex &&
				sample.seed === incumbent.samples[index].seed,
		);
	if (paired) {
		const differences = candidate.samples.map((sample, index) => sample.score - incumbent.samples[index].score);
		const differenceStatistic = statistic(differences);
		const df = differences.length - 1;
		const criticalValue = critical95(df);
		return {
			method: "paired-student-t",
			df,
			alpha: 0.05,
			criticalValue,
			uncertainty: criticalValue * (differenceStatistic.stddev / Math.sqrt(differences.length)),
		};
	}
	const candidateVariance = candidate.score.stddev ** 2 / candidate.samples.length;
	const incumbentVariance = incumbent.score.stddev ** 2 / incumbent.samples.length;
	const standardErrorSquared = candidateVariance + incumbentVariance;
	if (standardErrorSquared === 0) {
		const df = Math.max(1, candidate.samples.length + incumbent.samples.length - 2);
		return {
			method: "welch-student-t",
			df,
			alpha: 0.05,
			criticalValue: critical95(df),
			uncertainty: 0,
		};
	}
	const candidateDegrees =
		candidate.samples.length > 1 ? candidateVariance ** 2 / (candidate.samples.length - 1) : Number.POSITIVE_INFINITY;
	const incumbentDegrees =
		incumbent.samples.length > 1 ? incumbentVariance ** 2 / (incumbent.samples.length - 1) : Number.POSITIVE_INFINITY;
	const df = Math.max(1, Math.floor(standardErrorSquared ** 2 / (candidateDegrees + incumbentDegrees)));
	const criticalValue = critical95(df);
	return {
		method: "welch-student-t",
		df,
		alpha: 0.05,
		criticalValue,
		uncertainty: criticalValue * Math.sqrt(standardErrorSquared),
	};
}

function sampleIdentity(sample: EvaluationSample): EvaluationSampleIdentity {
	return {
		trialId: sample.trialId,
		phase: sample.phase,
		sampleIndex: sample.sampleIndex,
		seed: sample.seed,
	};
}

function postSelectionTrials(evaluation: EvaluationAggregate): PostSelectionTrial[] {
	return evaluation.samples.map((sample, index) => {
		if (sample.trialId === undefined || sample.seed === undefined || sample.sampleIndex === undefined) {
			throw new EvaluatorContractError(
				`Post-selection sample ${index} is missing its frozen trial ID, seed, or sample index.`,
			);
		}
		return {
			trialId: sample.trialId,
			seed: sample.seed,
			sampleIndex: sample.sampleIndex,
			score: sample.score,
		};
	});
}

function isTerminalExperiment(experiment: Experiment): boolean {
	return ["measured", "invalid", "failed", "cancelled", "interrupted"].includes(experiment.status);
}

function failure(
	phase: ExperimentFailure["phase"],
	kind: ExperimentFailure["kind"],
	message: string,
	retryable: boolean,
): ExperimentFailure {
	return { phase, kind, message, retryable };
}

type TerminalExperimentStatus = Extract<Experiment["status"], "invalid" | "failed" | "cancelled" | "interrupted">;

interface TerminalExperimentTransition {
	status: TerminalExperimentStatus;
	failure: ExperimentFailure;
	ideaStatus: Extract<Idea["status"], "rejected" | "failed">;
	countFailure?: boolean;
	enqueueRetry?: boolean;
	requeueClaimIfUnstarted?: boolean;
	eventType?: string;
	eventSummary?: string;
	eventRefs?: string[];
}

function claimedRetryForExperiment(state: IsoState, experiment: Experiment): ExperimentRetry | undefined {
	if (!experiment.retryOfExperimentId) {
		return undefined;
	}
	return state.retryQueue.find(
		(retry) =>
			retry.status === "claimed" &&
			retry.sourceExperimentId === experiment.retryOfExperimentId &&
			retry.attempt === experiment.attempt &&
			retry.claimedGenerationId === experiment.generationId,
	);
}

function settleRetryClaim(state: IsoState, experiment: Experiment, status: "queued" | "exhausted"): void {
	const retry = claimedRetryForExperiment(state, experiment);
	if (!retry) {
		return;
	}
	retry.status = status;
	if (status === "queued") {
		retry.claimedAt = undefined;
		retry.claimedGenerationId = undefined;
	}
}

function transitionExperimentToTerminal(
	state: IsoState,
	experiment: Experiment,
	options: TerminalExperimentTransition,
): { transitioned: boolean; retry?: ExperimentRetry } {
	if (isTerminalExperiment(experiment)) {
		return { transitioned: false };
	}
	const timestamp = now();
	const idea = state.ideas.find((candidate) => candidate.id === experiment.ideaId);
	const campaign = state.campaigns.find((candidate) => candidate.id === experiment.campaignId);
	const enqueueRetry = options.enqueueRetry ?? options.failure.retryable;
	if (options.requeueClaimIfUnstarted && experiment.startedAt === undefined && !enqueueRetry) {
		settleRetryClaim(state, experiment, "queued");
	} else {
		settleRetryClaim(state, experiment, "exhausted");
	}
	experiment.status = options.status;
	experiment.failure = structuredClone(options.failure);
	experiment.finishedAt = timestamp;
	experiment.updatedAt = timestamp;
	if (idea) {
		idea.status = options.ideaStatus;
		idea.updatedAt = timestamp;
	}
	if (campaign && (options.countFailure ?? options.failure.kind !== "cancelled")) {
		campaign.failures += 1;
		campaign.updatedAt = timestamp;
	}

	let retry: ExperimentRetry | undefined;
	if (
		enqueueRetry &&
		experiment.attempt < MAX_EXPERIMENT_ATTEMPTS &&
		idea &&
		campaign &&
		!["completed", "stopped", "failed"].includes(campaign.status)
	) {
		retry = queueRetry(state, {
			campaignId: experiment.campaignId,
			sourceExperimentId: experiment.id,
			sourceIdeaId: idea.id,
			proposal: {
				title: idea.title,
				hypothesis: idea.hypothesis,
				rationale: idea.rationale,
				implementationPlan: idea.implementationPlan,
				predictedEffect: idea.predictedEffect,
				strategy: idea.strategy,
				parentIdeaIds: [...new Set([...idea.parentIdeaIds, idea.id])],
			},
			attempt: experiment.attempt + 1,
		});
		appendMaterialUpdate(state, {
			missionId: campaign.missionId,
			campaignId: campaign.id,
			kind: "recovery",
			summary: `Queued retry ${retry.attempt}/${MAX_EXPERIMENT_ATTEMPTS} for ${idea.title}`,
			refs: [retry.id, experiment.id, idea.id],
		});
	}
	if (options.eventType && options.eventSummary) {
		state.events.push(
			createEvent({
				campaignId: experiment.campaignId,
				generationId: experiment.generationId,
				experimentId: experiment.id,
				type: options.eventType,
				summary: options.eventSummary,
				actor: "system",
				refs: options.eventRefs ?? [experiment.id],
			}),
		);
	}
	return { transitioned: true, retry };
}

function confirmationForPlan(
	experiment: Experiment,
	plan: PairedEvaluationPlan,
	round: number,
): ConfirmationEvidence | undefined {
	return experiment.confirmationHistory?.find(
		(evidence) => evidence.planId === plan.id || (evidence.planId === undefined && evidence.round === round),
	);
}

function promoteConfirmedExperiment(
	state: IsoState,
	campaign: Campaign,
	generation: Generation,
	experiment: Experiment,
	evidence: ConfirmationEvidence,
): boolean {
	if (!evidence.confirmed || !experiment.candidateCommit) {
		throw new Error(`Experiment ${experiment.id} cannot be promoted without confirmed frozen evidence.`);
	}
	const alreadyPromoted =
		campaign.championExperimentId === experiment.id &&
		generation.selectedExperimentId === experiment.id &&
		generation.status === "reflecting" &&
		experiment.credibleImprovement === true;
	experiment.credibleImprovement = true;
	experiment.rejectionReason = undefined;
	experiment.confirmationRoundsPassed = Math.max(experiment.confirmationRoundsPassed ?? 0, evidence.round);
	experiment.updatedAt = now();
	generation.selectedExperimentId = experiment.id;
	generation.status = "reflecting";
	generation.updatedAt = now();
	campaign.championExperimentId = experiment.id;
	campaign.consecutivePlateaus = 0;
	campaign.updatedAt = now();
	if (alreadyPromoted) {
		return false;
	}
	if (
		!state.events.some(
			(event) =>
				event.campaignId === campaign.id &&
				event.generationId === generation.id &&
				event.experimentId === experiment.id &&
				event.type === "champion.promoted",
		)
	) {
		state.events.push(
			createEvent({
				campaignId: campaign.id,
				generationId: generation.id,
				experimentId: experiment.id,
				type: "champion.promoted",
				summary: `New confirmed champion at ${evidence.candidateMean}`,
				actor: "selector",
				refs: [experiment.id, experiment.candidateCommit],
			}),
		);
	}
	if (
		!state.materialUpdates.some(
			(update) =>
				update.campaignId === campaign.id && update.kind === "champion" && update.refs.includes(experiment.id),
		)
	) {
		appendMaterialUpdate(state, {
			missionId: campaign.missionId,
			campaignId: campaign.id,
			kind: "champion",
			summary: `New confirmed champion at ${evidence.candidateMean}`,
			refs: [experiment.id, experiment.candidateCommit],
		});
	}
	return true;
}

function cancellationError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

async function retryAgentOperation<T>(signal: AbortSignal, operation: (attempt: number) => Promise<T>): Promise<T> {
	for (let attempt = 1; attempt <= 3; attempt += 1) {
		if (signal.aborted) {
			throw cancellationError("Research agent operation was cancelled.");
		}
		try {
			return await operation(attempt);
		} catch (error) {
			if (signal.aborted || (error instanceof Error && error.name === "AbortError") || attempt === 3) {
				throw error;
			}
			await delay(250 * attempt, undefined, { signal });
		}
	}
	throw new Error("Research agent operation exhausted its retry policy.");
}

function failedAgentCallStatus(
	error: unknown,
	signal: AbortSignal,
): Exclude<AgentCallStatus, "running" | "succeeded" | "interrupted"> {
	if (signal.aborted || (error instanceof Error && error.name === "AbortError")) {
		return "aborted";
	}
	return /timed out/iu.test(errorMessage(error)) ? "timed-out" : "failed";
}

function assertPositiveInteger(value: number, name: string, minimum = 1): void {
	if (!Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`${name} must be an integer greater than or equal to ${minimum}.`);
	}
}

function validateCalibration(input: CampaignCalibrationInput): void {
	if (input.goal.trim() === "") {
		throw new Error("Research goal must not be empty.");
	}
	if (input.metric.name.trim() === "") {
		throw new Error("Metric name must not be empty.");
	}
	if (!Number.isFinite(input.metric.minimumImprovement) || input.metric.minimumImprovement < 0) {
		throw new Error("Minimum improvement must be a finite non-negative number.");
	}
	if (input.config.evaluator.command.trim() === "") {
		throw new Error("Evaluator command must not be empty.");
	}
	assertPositiveInteger(input.config.workers, "workers");
	assertPositiveInteger(input.config.agentTimeoutMs, "agentTimeoutMs");
	if (input.config.agentModel) {
		const { provider, model, thinkingLevel } = input.config.agentModel;
		if (
			provider.trim() !== provider ||
			provider.length === 0 ||
			provider.length > 200 ||
			model.trim() !== model ||
			model.length === 0 ||
			model.length > 1_000
		) {
			throw new Error("agentModel provider and model must be bounded non-empty strings without outer whitespace.");
		}
		if (!["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(thinkingLevel)) {
			throw new Error("agentModel thinkingLevel is invalid.");
		}
	}
	assertPositiveInteger(input.config.evaluator.samples, "evaluator.samples", 2);
	assertPositiveInteger(input.config.evaluator.warmups, "evaluator.warmups", 0);
	assertPositiveInteger(input.config.evaluator.timeoutMs, "evaluator.timeoutMs");
	if (input.config.evaluator.scoreBounds) {
		const { min, max } = input.config.evaluator.scoreBounds;
		if (!Number.isFinite(min) || !Number.isFinite(max) || min >= max) {
			throw new Error("evaluator.scoreBounds must contain finite min < max.");
		}
	}
	assertPositiveInteger(input.config.budget.maxGenerations, "budget.maxGenerations");
	assertPositiveInteger(input.config.budget.maxExperiments, "budget.maxExperiments");
	assertPositiveInteger(input.config.budget.maxWallClockMs, "budget.maxWallClockMs");
	assertPositiveInteger(input.config.budget.maxConsecutivePlateaus, "budget.maxConsecutivePlateaus");
	assertPositiveInteger(input.config.budget.maxFailures, "budget.maxFailures");
	if (input.config.budget.maxInputTokens !== undefined) {
		assertPositiveInteger(input.config.budget.maxInputTokens, "budget.maxInputTokens");
	}
	if (input.config.budget.maxOutputTokens !== undefined) {
		assertPositiveInteger(input.config.budget.maxOutputTokens, "budget.maxOutputTokens");
	}
	if (
		input.config.budget.maxCostUsd !== undefined &&
		(!Number.isFinite(input.config.budget.maxCostUsd) || input.config.budget.maxCostUsd <= 0)
	) {
		throw new Error("budget.maxCostUsd must be a finite positive number.");
	}
	sourceBundleFromInput(input);
}

export class IsoRuntime {
	readonly repoRoot: string;
	readonly store: IsoStore;
	readonly ownerId: string;
	readonly startedAt: string;
	private readonly agents: ResearchAgents;
	private readonly activeExperiments = new Map<string, ActiveExperiment>();
	private readonly listeners = new Set<() => void>();
	private loopPromise?: Promise<void>;
	private startPromise?: Promise<ResearchReceipt>;
	private calibrationPromise?: Promise<Campaign>;
	private calibrationController?: AbortController;
	private missionPromise?: Promise<void>;
	private loopError?: unknown;
	private activeRunId?: string;
	private runController?: AbortController;
	private leaseTimer?: NodeJS.Timeout;
	private shutdownPromise?: Promise<void>;

	constructor(repoRoot: string, store = new IsoStore(repoRoot), agents: ResearchAgents = new PiResearchAgents()) {
		this.repoRoot = repoRoot;
		this.store = store;
		this.agents = agents;
		this.ownerId = `${hostname()}:${process.pid}:${makeId("runtime")}`;
		this.startedAt = now();
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	workers(): WorkerSnapshot[] {
		return [...this.activeExperiments.values()].map((worker) => structuredClone(worker.snapshot));
	}

	async snapshot(): Promise<DashboardSnapshot> {
		const state = await this.store.read();
		const activeCampaign = selectedCampaign(state);
		const activeMission = getActiveMission(state);
		return {
			state,
			graph: activeMission && !activeCampaign ? { nodes: [], edges: [] } : buildIdeaGraph(state, activeCampaign?.id),
			workers: this.workers(),
			activeCampaign,
			kernel: { pid: process.pid, startedAt: this.startedAt },
		};
	}

	async summary(campaignId?: string): Promise<CampaignSummary> {
		const state = await this.store.read();
		const campaign = campaignId
			? state.campaigns.find((candidate) => candidate.id === campaignId)
			: selectedCampaign(state);
		const mission = selectedMission(state, campaign, campaignId === undefined);
		const boundedCampaign: CampaignSummary["campaign"] = campaign
			? {
					id: campaign.id,
					missionId: campaign.missionId,
					goal: campaign.goal.slice(0, MAX_EVIDENCE_TEXT),
					metric: { ...campaign.metric, name: campaign.metric.name.slice(0, 1_000) },
					status: campaign.status,
					runIntent: campaign.runIntent,
					agentModel: campaign.config.agentModel
						? {
								provider: campaign.config.agentModel.provider.slice(0, 200),
								model: campaign.config.agentModel.model.slice(0, 1_000),
								thinkingLevel: campaign.config.agentModel.thinkingLevel,
							}
						: undefined,
					sourceCommit: campaign.sourceCommit,
					sourceHeadCommit: campaign.sourceHeadCommit,
					sourceSnapshotRef: campaign.sourceSnapshotRef,
					sourceHadLocalChanges: campaign.sourceHadLocalChanges,
					sourceSnapshotPaths: (campaign.sourceSnapshotPaths ?? [])
						.slice(0, 100)
						.map((path) => path.slice(0, 1_024)),
					dependencyDigest: campaign.dependencyDigest,
					baselineScore: campaign.baseline.evaluation.score.mean,
					championExperimentId: campaign.championExperimentId,
					activeGenerationId: campaign.activeGenerationId,
					generationsCompleted: campaign.generationsCompleted,
					experimentsStarted: campaign.experimentsStarted,
					failures: campaign.failures,
					consecutivePlateaus: campaign.consecutivePlateaus,
					startedAt: campaign.startedAt,
					stopReason: boundedText(campaign.stopReason),
					createdAt: campaign.createdAt,
					updatedAt: campaign.updatedAt,
				}
			: undefined;
		const boundedMission: CampaignSummary["mission"] = mission
			? {
					id: mission.id,
					preflightId: mission.preflightId,
					launchOperationId: mission.launchOperationId,
					desiredState: mission.desiredState,
					phase: mission.phase,
					campaignId: mission.campaignId,
					goal: mission.input.goal.slice(0, MAX_EVIDENCE_TEXT),
					metric: { ...mission.input.metric, name: mission.input.metric.name.slice(0, 1_000) },
					diagnostics: mission.diagnostics.slice(-10).map((diagnostic) => ({
						...diagnostic,
						message: diagnostic.message.slice(0, 2_000),
					})),
					notificationCursor: mission.notificationCursor,
					createdAt: mission.createdAt,
					updatedAt: mission.updatedAt,
					startedAt: mission.startedAt,
					completedAt: mission.completedAt,
				}
			: undefined;
		const campaignExperiments = campaign
			? state.experiments.filter((experiment) => experiment.campaignId === campaign.id)
			: [];
		const cursor = mission?.notificationCursor ?? 0;
		const updates = state.materialUpdates
			.filter(
				(update) =>
					update.sequence > cursor &&
					(!mission || update.missionId === mission.id) &&
					(!campaign || update.campaignId === undefined || update.campaignId === campaign.id),
			)
			.slice(0, MAX_RECENT_UPDATES)
			.map((update) => ({
				...update,
				summary: update.summary.slice(0, 2_000),
				refs: update.refs.slice(0, 16).map((reference) => reference.slice(0, 256)),
			}));
		return {
			revision: state.revision,
			mission: boundedMission,
			campaign: boundedCampaign,
			counts: {
				generations: campaign
					? state.generations.filter((generation) => generation.campaignId === campaign.id).length
					: 0,
				experiments: campaignExperiments.length,
				measured: campaignExperiments.filter((experiment) => experiment.status === "measured").length,
				failed: campaignExperiments.filter((experiment) =>
					["failed", "invalid", "interrupted"].includes(experiment.status),
				).length,
				queuedOperatorNotes: state.operatorNotes.filter(
					(note) =>
						note.status === "queued" &&
						(!mission || note.missionId === mission.id) &&
						(!campaign || note.campaignId === undefined || note.campaignId === campaign.id),
				).length,
				queuedRetries: campaign
					? state.retryQueue.filter((retry) => retry.campaignId === campaign.id && retry.status === "queued")
							.length
					: 0,
			},
			champion: campaign ? championHandoffFor(state, campaign) : undefined,
			completionReport: mission?.completionReport ?? campaign?.completionReport,
			agentUsage: campaign
				? agentUsageFor(state, campaign.id)
				: {
						inputTokens: 0,
						outputTokens: 0,
						costUsd: 0,
						agentCalls: 0,
						callsMissingTokenAccounting: 0,
						callsMissingCostAccounting: 0,
					},
			workers: this.workers()
				.slice(0, 32)
				.map((worker) => ({
					...worker,
					id: worker.id.slice(0, 1_000),
					ideaId: worker.ideaId.slice(0, 1_000),
					experimentId: worker.experimentId.slice(0, 1_000),
					generationId: worker.generationId.slice(0, 1_000),
					label: worker.label.slice(0, 512),
					activity: worker.activity.slice(0, 2_000),
				})),
			materialUpdates: updates,
			nextNotificationCursor: updates.at(-1)?.sequence ?? cursor,
		};
	}

	async queryEvidence(input: EvidenceQueryInput): Promise<EvidencePage> {
		const limit = Math.max(1, Math.min(MAX_EVIDENCE_PAGE, input.limit ?? DEFAULT_EVIDENCE_PAGE));
		if (input.kind === "events") {
			const afterSequence = parseOffsetCursor(input.cursor);
			const page = this.store.queryEvents({
				campaignId: input.campaignId,
				generationId: input.generationId,
				experimentId: input.experimentId,
				afterSequence,
				limit,
			});
			return {
				kind: input.kind,
				items: page.events.map((event) => {
					const serializedData = event.data ? JSON.stringify(event.data) : undefined;
					return {
						...event,
						summary: event.summary.slice(0, 4_000),
						refs: event.refs.slice(0, 16).map((reference) => reference.slice(0, 256)),
						data: serializedData && serializedData.length <= 4_000 ? event.data : undefined,
					};
				}),
				nextCursor: page.nextSequence?.toString(),
			};
		}

		const state = await this.store.read();
		const offset = parseOffsetCursor(input.cursor);
		if (input.kind === "experiments") {
			const matches = state.experiments.filter(
				(experiment) =>
					(!input.campaignId || experiment.campaignId === input.campaignId) &&
					(!input.generationId || experiment.generationId === input.generationId) &&
					(!input.experimentId || experiment.id === input.experimentId),
			);
			const sourcePage = matches.slice(offset, offset + limit + 1);
			const hasMore = sourcePage.length > limit;
			return {
				kind: input.kind,
				items: sourcePage.slice(0, limit).map(
					(experiment): ExperimentEvidence => ({
						id: experiment.id,
						campaignId: experiment.campaignId,
						generationId: experiment.generationId,
						ideaId: experiment.ideaId,
						attempt: experiment.attempt,
						retryOfExperimentId: experiment.retryOfExperimentId,
						status: experiment.status,
						baseCommit: experiment.baseCommit,
						candidateCommit: experiment.candidateCommit,
						diffStat: boundedText(experiment.diffStat, 2_000),
						changedPaths: experiment.changedPaths.slice(0, 20).map((path) => path.slice(0, 512)),
						score: experiment.evaluation?.score,
						incumbentScore: experiment.incumbentEvaluation?.score,
						improvement: experiment.improvement,
						uncertainty: experiment.uncertainty,
						confirmationRoundsPassed: experiment.confirmationRoundsPassed,
						confirmationHistory: experiment.confirmationHistory
							? structuredClone(experiment.confirmationHistory.slice(-MAX_CONFIRMATION_HISTORY))
							: undefined,
						screeningPlan: experiment.screeningPlan ? structuredClone(experiment.screeningPlan) : undefined,
						confirmationPlan: experiment.confirmationPlan
							? structuredClone(experiment.confirmationPlan)
							: undefined,
						screeningAttempts: experiment.screeningAttempts,
						confirmationAttempts: experiment.confirmationAttempts,
						screeningPassed: experiment.screeningPassed,
						credibleImprovement: experiment.credibleImprovement,
						rejectionReason: boundedText(experiment.rejectionReason, 4_000),
						failure: experiment.failure
							? { ...experiment.failure, message: experiment.failure.message.slice(0, 4_000) }
							: undefined,
						assistantSummary: boundedText(experiment.assistantSummary, 4_000),
						createdAt: experiment.createdAt,
						updatedAt: experiment.updatedAt,
						finishedAt: experiment.finishedAt,
					}),
				),
				nextCursor: hasMore ? String(offset + limit) : undefined,
			};
		}
		if (input.kind === "generations") {
			const matches = state.generations.filter(
				(generation) =>
					(!input.campaignId || generation.campaignId === input.campaignId) &&
					(!input.generationId || generation.id === input.generationId),
			);
			const sourcePage = matches.slice(offset, offset + limit + 1);
			const hasMore = sourcePage.length > limit;
			return {
				kind: input.kind,
				items: sourcePage.slice(0, limit).map((generation) => ({
					...structuredClone(generation),
					ideaIds: generation.ideaIds.slice(0, 20).map((id) => id.slice(0, 256)),
					experimentIds: generation.experimentIds.slice(0, 20).map((id) => id.slice(0, 256)),
				})),
				nextCursor: hasMore ? String(offset + limit) : undefined,
			};
		}
		if (input.kind === "reflections") {
			const matches = state.reflections.filter(
				(reflection) =>
					(!input.campaignId || reflection.campaignId === input.campaignId) &&
					(!input.generationId || reflection.generationId === input.generationId),
			);
			const sourcePage = matches.slice(offset, offset + limit + 1);
			const hasMore = sourcePage.length > limit;
			return {
				kind: input.kind,
				items: sourcePage.slice(0, limit).map((reflection) => ({
					...reflection,
					summary: reflection.summary.slice(0, 4_000),
					lessons: reflection.lessons.slice(0, 10).map((lesson) => lesson.slice(0, 1_000)),
					deadEnds: reflection.deadEnds.slice(0, 10).map((deadEnd) => deadEnd.slice(0, 1_000)),
					nextFocus: reflection.nextFocus.slice(0, 10).map((focus) => focus.slice(0, 1_000)),
				})),
				nextCursor: hasMore ? String(offset + limit) : undefined,
			};
		}
		const updates = state.materialUpdates
			.filter(
				(update) =>
					(!input.campaignId || update.campaignId === input.campaignId) &&
					update.sequence > parseOffsetCursor(input.cursor),
			)
			.slice(0, limit + 1);
		const hasMore = updates.length > limit;
		const page = updates.slice(0, limit);
		return {
			kind: input.kind,
			items: page,
			nextCursor: hasMore ? page.at(-1)?.sequence.toString() : undefined,
		};
	}

	async applyControl(request: ResearchControlRequest): Promise<ResearchControlReceipt> {
		const normalizedRequest = {
			...request,
			action: this.normalizeControlAction(request.action),
		};
		return this.commitControl("dashboard-control", normalizedRequest, (state) =>
			assertControlPrecondition(state, normalizedRequest),
		);
	}

	async applyCurrentControl(request: CurrentResearchControlRequest): Promise<CurrentResearchControlReceipt> {
		const normalizedRequest = {
			...request,
			action: this.normalizeControlAction(request.action),
		};
		this.validateControlRequest(normalizedRequest);
		const transaction = await this.store.updateOnce(
			`kernel-control:v1:${normalizedRequest.actionId}`,
			normalizedRequest.actionFingerprint,
			({ state, nextRevision }) => {
				const context = controlContextForState(state);
				if (!context) {
					if (normalizedRequest.action.kind === "note") {
						throw new ControlConflictError({
							code: "no_control_target",
							message: "There is no active mission or campaign to control.",
							revision: state.revision,
						});
					}
					if (normalizedRequest.action.kind === "pause" || normalizedRequest.action.kind === "stop") {
						state.admissionEpoch += 1;
					}
					const outcome: Exclude<ResearchControlOutcome, { kind: "note" }> =
						normalizedRequest.action.kind === "start" || normalizedRequest.action.kind === "resume"
							? {
									kind: normalizedRequest.action.kind,
									missionResumed: false,
									started: false,
									runId: "none",
								}
							: normalizedRequest.action.kind === "pause"
								? { kind: "pause", paused: true }
								: { kind: "stop", stopped: true };
					return {
						actionId: normalizedRequest.actionId,
						actionFingerprint: normalizedRequest.actionFingerprint,
						targetKind: "none",
						targetId: "none",
						acceptedControlFingerprint: "none",
						revision: nextRevision,
						outcome,
					} satisfies NoTargetResearchControlReceipt;
				}
				const outcome = this.applyControlToState(state, context, normalizedRequest.action);
				return {
					actionId: normalizedRequest.actionId,
					actionFingerprint: normalizedRequest.actionFingerprint,
					targetKind: context.target.kind,
					targetId: context.target.id,
					acceptedControlFingerprint: context.target.fingerprint,
					revision: nextRevision,
					outcome,
				} satisfies ResearchControlReceipt;
			},
		);
		if (transaction.value.targetKind !== "none") {
			await this.reconcileControl(transaction.value, transaction.replayed);
		}
		return transaction.value;
	}

	private normalizeControlAction(action: ResearchControlAction): ResearchControlAction {
		if (action.kind === "note") {
			const message = action.message.trim();
			if (message.length === 0 || message.length > 100_000) {
				throw new Error("Operator note must be a non-empty string of at most 100000 bytes.");
			}
			return {
				kind: "note",
				message,
				hypothesis: action.hypothesis ? structuredClone(action.hypothesis) : undefined,
			};
		}
		if (action.kind === "stop") {
			return {
				kind: "stop",
				reason: action.reason.trim() || "Stopped by operator",
			};
		}
		return { kind: action.kind };
	}

	private async commitControl(
		namespace: "dashboard-control" | "kernel-control",
		request: CurrentResearchControlRequest,
		resolveContext: (state: IsoState) => ControlContext,
	): Promise<ResearchControlReceipt> {
		this.validateControlRequest(request);
		const transaction = await this.store.updateOnce(
			`${namespace}:v1:${request.actionId}`,
			request.actionFingerprint,
			({ state, nextRevision }) => {
				const context = resolveContext(state);
				const outcome = this.applyControlToState(state, context, request.action);
				return {
					actionId: request.actionId,
					actionFingerprint: request.actionFingerprint,
					targetKind: context.target.kind,
					targetId: context.target.id,
					acceptedControlFingerprint: context.target.fingerprint,
					revision: nextRevision,
					outcome,
				} satisfies ResearchControlReceipt;
			},
		);
		await this.reconcileControl(transaction.value, transaction.replayed);
		return transaction.value;
	}

	private validateControlRequest(request: CurrentResearchControlRequest): void {
		if (request.actionId.trim() === "" || request.actionId.length > 200) {
			throw new Error("Control actionId must be a non-empty string of at most 200 characters.");
		}
		if (request.actionFingerprint.trim() === "") {
			throw new Error("Control action fingerprint must not be empty.");
		}
	}

	private applyControlToState(
		state: IsoState,
		context: ControlContext,
		action: ResearchControlAction,
	): ResearchControlOutcome {
		const mission = context.mission;
		const campaign = context.campaign;
		const timestamp = now();
		if (action.kind === "pause" || action.kind === "stop") {
			state.admissionEpoch += 1;
		}
		if (action.kind === "start" || action.kind === "resume") {
			const wasRunning =
				(mission === undefined || mission.desiredState === "running") &&
				(campaign === undefined || campaign.runIntent === "running");
			if (mission) {
				mission.desiredState = "running";
				mission.phase = mission.campaignId ? "starting" : "accepted";
				mission.completedAt = undefined;
				mission.updatedAt = timestamp;
			}
			if (campaign) {
				campaign.runIntent = "running";
				if (campaign.status === "paused" || campaign.status === "pausing") {
					campaign.status = "ready";
					campaign.stopReason = undefined;
				}
				campaign.updatedAt = timestamp;
			}
			if (mission) {
				appendMaterialUpdate(state, {
					missionId: mission.id,
					campaignId: campaign?.id,
					kind: "operator",
					summary: "Mission resume requested",
					refs: [mission.id, ...(campaign ? [campaign.id] : [])],
				});
			}
			return {
				kind: action.kind,
				missionResumed: mission !== undefined,
				missionPhase: mission?.phase,
				started: !wasRunning,
				runId: campaign ? `campaign:${campaign.id}` : "mission-calibration",
				missionId: mission?.id,
				campaignId: campaign?.id,
			};
		}

		if (action.kind === "pause") {
			if (mission) {
				mission.desiredState = "paused";
				if (!campaign || mission.phase === "accepted" || mission.phase === "calibrating") {
					mission.phase = "paused";
					mission.completedAt = undefined;
				}
				mission.updatedAt = timestamp;
				appendMissionDiagnostic(mission, {
					phase: mission.phase,
					code: "pause_requested",
					message: "Operator requested a pause at the next durable boundary.",
					retryable: true,
				});
				appendMaterialUpdate(state, {
					missionId: mission.id,
					campaignId: campaign?.id,
					kind: "operator",
					summary: "Mission pause requested",
					refs: [mission.id, ...(campaign ? [campaign.id] : [])],
				});
			}
			if (campaign) {
				campaign.runIntent = "paused";
				campaign.status = ["planning", "running"].includes(campaign.status) ? "pausing" : "paused";
				campaign.updatedAt = timestamp;
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: campaign.activeGenerationId,
						type: "campaign.pause-requested",
						summary: "Research will pause at the next durable boundary",
						actor: "human",
						refs: [campaign.id],
					}),
				);
			}
			return {
				kind: "pause",
				paused: true,
				missionId: mission?.id,
				campaignId: campaign?.id,
			};
		}

		if (action.kind === "note") {
			const record: OperatorNote = {
				id: makeId("note"),
				missionId: campaign?.missionId ?? mission?.id,
				campaignId: campaign?.id,
				message: action.message,
				hypothesis: action.hypothesis ? structuredClone(action.hypothesis) : undefined,
				status: "queued",
				createdAt: timestamp,
			};
			state.operatorNotes.push(record);
			appendMaterialUpdate(state, {
				missionId: record.missionId,
				campaignId: record.campaignId,
				kind: "operator",
				summary: action.hypothesis
					? `Queued operator hypothesis: ${action.hypothesis.title}`
					: "Queued operator guidance",
				refs: [record.id],
			});
			if (campaign) {
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						type: action.hypothesis ? "operator.hypothesis-queued" : "operator.note-queued",
						summary: action.message.slice(0, MAX_EVIDENCE_TEXT),
						actor: "human",
						refs: [record.id],
					}),
				);
			}
			return {
				kind: "note",
				queued: true,
				noteId: record.id,
				missionId: record.missionId,
				campaignId: record.campaignId,
			};
		}

		const reason = action.reason;
		if (mission) {
			mission.desiredState = "stopped";
			mission.phase = "stopped";
			mission.completedAt = timestamp;
			mission.updatedAt = timestamp;
			appendMissionDiagnostic(mission, {
				phase: "stopped",
				code: "operator_stopped",
				message: reason,
				retryable: false,
			});
			if (!campaign) {
				appendMaterialUpdate(state, {
					missionId: mission.id,
					kind: "completion",
					summary: reason,
					refs: [mission.id],
				});
			}
		}
		if (campaign) {
			const activeGenerationId = campaign.activeGenerationId;
			campaign.status = "stopped";
			campaign.runIntent = "stopped";
			campaign.stopReason = reason;
			campaign.activeGenerationId = undefined;
			campaign.updatedAt = timestamp;
			if (activeGenerationId) {
				const generation = state.generations.find((candidate) => candidate.id === activeGenerationId);
				if (generation && !["completed", "cancelled", "failed"].includes(generation.status)) {
					generation.status = "cancelled";
					generation.finishedAt = timestamp;
					generation.updatedAt = timestamp;
				}
				for (const experiment of state.experiments.filter(
					(candidate) => candidate.generationId === activeGenerationId && !isTerminalExperiment(candidate),
				)) {
					transitionExperimentToTerminal(state, experiment, {
						status: "cancelled",
						failure: failure("selection", "cancelled", reason, false),
						ideaStatus: "rejected",
						countFailure: false,
					});
				}
			}
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					generationId: activeGenerationId,
					type: "campaign.stopped",
					summary: reason,
					actor: "human",
					refs: [campaign.id],
				}),
			);
			finishMissionForCampaign(state, campaign, "stopped", reason);
		}
		return {
			kind: "stop",
			stopped: true,
			missionId: mission?.id,
			campaignId: campaign?.id,
		};
	}

	private async reconcileControl(receipt: ResearchControlReceipt, replayed: boolean): Promise<void> {
		if (replayed) {
			if (receipt.outcome.kind !== "start" && receipt.outcome.kind !== "resume") {
				return;
			}
			const context = controlContextForState(await this.store.read());
			if (!context || context.target.kind !== receipt.targetKind || context.target.id !== receipt.targetId) {
				return;
			}
		}
		this.changed();
		const outcome = receipt.outcome;
		if (outcome.kind === "start" || outcome.kind === "resume") {
			if (outcome.missionId) {
				await this.resumePersistedMission();
			} else if (outcome.campaignId) {
				await this.queueCommittedResearchStart(outcome.campaignId);
			}
			return;
		}
		if (outcome.kind === "pause") {
			if (!outcome.campaignId) {
				const activeCalibration = this.calibrationPromise;
				this.calibrationController?.abort();
				await activeCalibration?.catch(() => undefined);
				await this.missionPromise?.catch(() => undefined);
			}
			return;
		}
		if (outcome.kind === "stop") {
			const activeCalibration = this.calibrationPromise;
			this.calibrationController?.abort();
			this.requestQuiescence();
			await activeCalibration?.catch(() => undefined);
			await this.missionPromise?.catch(() => undefined);
			await this.startPromise?.catch(() => undefined);
			this.requestQuiescence();
			await this.loopPromise;
		}
	}

	async queueOperatorNote(message: string, hypothesis?: ProposedIdea): Promise<OperatorNote> {
		const normalizedMessage = message.trim();
		if (normalizedMessage.length === 0 || normalizedMessage.length > 100_000) {
			throw new Error("Operator note must be a non-empty string of at most 100000 bytes.");
		}
		const note = await this.store.update((state) => {
			const campaign = getActiveCampaign(state);
			const mission = getActiveMission(state);
			if (!campaign && !mission) {
				throw new Error("No active ISO campaign or mission can receive an operator note.");
			}
			const record: OperatorNote = {
				id: makeId("note"),
				missionId: campaign?.missionId ?? mission?.id,
				campaignId: campaign?.id,
				message: normalizedMessage,
				hypothesis: hypothesis ? structuredClone(hypothesis) : undefined,
				status: "queued",
				createdAt: now(),
			};
			state.operatorNotes.push(record);
			appendMaterialUpdate(state, {
				missionId: record.missionId,
				campaignId: record.campaignId,
				kind: "operator",
				summary: hypothesis ? `Queued operator hypothesis: ${hypothesis.title}` : "Queued operator guidance",
				refs: [record.id],
			});
			if (campaign) {
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						type: hypothesis ? "operator.hypothesis-queued" : "operator.note-queued",
						summary: normalizedMessage.slice(0, MAX_EVIDENCE_TEXT),
						actor: "human",
						refs: [record.id],
					}),
				);
			}
			return structuredClone(record);
		});
		this.changed();
		return note;
	}

	async acknowledgeMaterialUpdates(cursor: number, missionId?: string): Promise<number> {
		if (!Number.isSafeInteger(cursor) || cursor < 0) {
			throw new Error("Notification cursor must be a non-negative integer.");
		}
		const acknowledged = await this.store.update((state) => {
			const mission = missionId
				? state.missions.find((candidate) => candidate.id === missionId)
				: (getActiveMission(state) ?? state.missions.at(-1));
			if (!mission) {
				throw new Error("No ISO mission is available to acknowledge.");
			}
			const maximum = state.nextMaterialUpdateSequence - 1;
			mission.notificationCursor = Math.max(mission.notificationCursor, Math.min(cursor, maximum));
			mission.updatedAt = now();
			const oldestRetained = Math.max(0, mission.notificationCursor - 100);
			state.materialUpdates = state.materialUpdates.filter(
				(update) => update.missionId !== mission.id || update.sequence > oldestRetained,
			);
			return mission.notificationCursor;
		});
		this.changed();
		return acknowledged;
	}

	async championHandoff(campaignId?: string): Promise<ChampionHandoff | undefined> {
		const state = await this.store.read();
		const campaign = campaignId
			? state.campaigns.find((candidate) => candidate.id === campaignId)
			: selectedCampaign(state);
		return campaign ? championHandoffFor(state, campaign) : undefined;
	}

	async launchMission(input: CampaignCalibrationInput): Promise<MissionReceipt> {
		return (await this.launchMissionInternal(input)).mission;
	}

	async launchMissionFromKernel(
		input: CampaignCalibrationInput,
		launch: DirectMissionLaunch,
	): Promise<DurableMissionLaunchReceipt> {
		return this.launchMissionInternal(input, undefined, launch);
	}

	async launchMissionWithPreflight(
		input: CampaignCalibrationInput,
		launch: ConversationalMissionLaunch,
	): Promise<DurableMissionLaunchReceipt> {
		return this.launchMissionInternal(input, launch);
	}

	private async launchMissionInternal(
		input: CampaignCalibrationInput,
		launch?: ConversationalMissionLaunch,
		directLaunch?: DirectMissionLaunch,
	): Promise<DurableMissionLaunchReceipt> {
		validateCalibration(input);
		if (directLaunch) {
			if (directLaunch.requestId.trim() === "" || directLaunch.requestId.length > 200) {
				throw new Error("Direct launch requestId must be a non-empty string of at most 200 characters.");
			}
			const replay = this.store.readAtomicReceipt<DurableMissionLaunchReceipt>(
				`kernel:v1:launch:${directLaunch.requestId}`,
				directLaunch.requestFingerprint,
			);
			if (replay) {
				return replay.value;
			}
		}
		let validatedConversationalInput: ResearchMissionInput | undefined;
		if (launch) {
			validatedConversationalInput = persistedMissionInput(input);
			const identity = preflightLaunchIdentity(launch.preflightId, validatedConversationalInput);
			if (
				launch.launchOperationId !== identity.launchOperationId ||
				launch.inputDigest !== identity.inputDigest ||
				launch.requestId !== identity.requestId ||
				launch.requestFingerprint !== identity.requestFingerprint
			) {
				throw new Error("Conversational launch identity does not match the canonical persisted mission input.");
			}
			const replay = this.store.readAtomicReceipt<DurableMissionLaunchReceipt>(
				`kernel:v1:launch:${launch.requestId}`,
				launch.requestFingerprint,
			);
			if (replay) {
				return replay.value;
			}
			if (!launch.attemptId) {
				throw new Error("Conversational launch requires its live principal attempt identity.");
			}
		}
		if (this.shutdownPromise) {
			throw new Error("ISO runtime is shutting down.");
		}
		if (input.signal?.aborted) {
			throw cancellationError("Mission launch was cancelled.");
		}
		let directAdmissionPreflightId: string | undefined;
		if (!launch) {
			const admissionObjective = {
				goal: input.goal,
				metric: structuredClone(input.metric),
				config: structuredClone(input.config),
				...(sourceBundleFromInput(input) ?? {}),
			};
			const objectiveDigest = canonicalPayloadDigest(
				"iso.runtime.direct-admission-objective.v1",
				admissionObjective,
			);
			const intentKey = canonicalPayloadDigest("iso.runtime.direct-admission-intent.v1", {
				repoRoot: this.repoRoot,
				...(directLaunch ? { requestId: directLaunch.requestId } : { objectiveDigest }),
			});
			directAdmissionPreflightId = (
				await this.store.openPreflight({
					intentKey,
					objectiveDigest,
				})
			).preflightId;
		}
		let source = sourceBundleFromInput(input);
		if (source) {
			await verifySourceBundle(this.repoRoot, source);
		} else {
			await removeIsoWorktrees(this.repoRoot);
			source = await captureSourceBundle(this.repoRoot, input.goal);
		}
		const protectedPaths = input.config.evaluator.protectedPaths.map((path) =>
			normalizeRepositoryRelativePath(path, "Protected evaluator path"),
		);
		if (new Set(protectedPaths).size !== protectedPaths.length) {
			throw new Error("Protected evaluator paths must be unique after normalization.");
		}
		await frozenEvaluatorReadPaths(this.repoRoot, protectedPaths);
		if (input.signal?.aborted) {
			throw cancellationError("Mission launch was cancelled.");
		}
		const persistedInput = persistedMissionInput({ ...input, ...source });
		if (validatedConversationalInput && !isDeepStrictEqual(validatedConversationalInput, persistedInput)) {
			throw new Error("Verified source bundle changed the canonical conversational launch input.");
		}
		let durableLaunch = launch;
		if (!durableLaunch) {
			if (!directAdmissionPreflightId) {
				throw new Error("Direct mission launch lost its durable pre-admission receipt.");
			}
			const identity = preflightLaunchIdentity(directAdmissionPreflightId, persistedInput);
			durableLaunch = {
				preflightId: directAdmissionPreflightId,
				launchOperationId: identity.launchOperationId,
				inputDigest: identity.inputDigest,
				requestId: directLaunch?.requestId ?? identity.requestId,
				requestFingerprint: directLaunch?.requestFingerprint ?? identity.requestFingerprint,
			};
		}
		if (!launch) {
			const expected = preflightLaunchIdentity(durableLaunch.preflightId, persistedInput);
			if (
				durableLaunch.launchOperationId !== expected.launchOperationId ||
				durableLaunch.inputDigest !== expected.inputDigest ||
				(!directLaunch &&
					(durableLaunch.requestId !== expected.requestId ||
						durableLaunch.requestFingerprint !== expected.requestFingerprint))
			) {
				throw new Error("Direct launch identity does not match the canonical persisted mission input.");
			}
		}
		const accepted = await this.store.acceptMissionOnce({
			idempotencyKey: `kernel:v1:launch:${durableLaunch.requestId}`,
			requestFingerprint: durableLaunch.requestFingerprint,
			preflightId: durableLaunch.preflightId,
			...(launch ? { attemptId: launch.attemptId } : {}),
			launchOperationId: durableLaunch.launchOperationId,
			inputDigest: durableLaunch.inputDigest,
			input: persistedInput,
		});
		if (!accepted.replayed) {
			this.changed();
		}
		void this.resumePersistedMission().catch(() => undefined);
		return accepted.value;
	}

	async resumePersistedMission(): Promise<MissionReceipt | undefined> {
		const state = await this.store.read();
		const mission = getActiveMission(state);
		if (!mission || mission.desiredState !== "running") {
			return undefined;
		}
		if (!this.missionPromise) {
			const operation = this.continueMission(mission.id);
			this.missionPromise = operation;
			void operation.then(
				() => {
					if (this.missionPromise === operation) {
						this.missionPromise = undefined;
					}
				},
				() => {
					if (this.missionPromise === operation) {
						this.missionPromise = undefined;
					}
				},
			);
		}
		return {
			missionId: mission.id,
			preflightId: mission.preflightId,
			launchOperationId: mission.launchOperationId,
			phase: mission.phase,
			accepted: false,
			campaignId: mission.campaignId,
		};
	}

	private async continueMission(missionId: string): Promise<void> {
		try {
			let state = await this.store.read();
			let mission = state.missions.find((candidate) => candidate.id === missionId);
			if (!mission || mission.desiredState !== "running") {
				return;
			}
			const initialCampaignId = mission.campaignId;
			let campaign = initialCampaignId
				? state.campaigns.find((candidate) => candidate.id === initialCampaignId)
				: undefined;
			if (!campaign) {
				await this.store.update((draft) => {
					const stored = draft.missions.find((candidate) => candidate.id === missionId);
					if (!stored || stored.desiredState !== "running") {
						return;
					}
					if (stored.phase !== "calibrating") {
						stored.phase = "calibrating";
						stored.updatedAt = now();
						appendMissionDiagnostic(stored, {
							phase: "calibrating",
							code: "calibration_started",
							message: "Establishing the clean baseline and frozen evaluator contract.",
							retryable: true,
						});
						appendMaterialUpdate(draft, {
							missionId: stored.id,
							kind: "mission",
							summary: "Baseline calibration started",
							refs: [stored.id],
						});
					}
				});
				this.changed();
				campaign = await this.queueCalibration(
					{
						...structuredClone(mission.input),
					},
					mission.id,
				);
			}

			state = await this.store.read();
			mission = state.missions.find((candidate) => candidate.id === missionId);
			campaign = mission?.campaignId
				? state.campaigns.find((candidate) => candidate.id === mission.campaignId)
				: campaign;
			if (!mission || !campaign || mission.desiredState !== "running") {
				return;
			}
			if (["completed", "stopped", "failed"].includes(campaign.status)) {
				if (!mission.completionReport) {
					await this.store.update((draft) => {
						const storedCampaign = draft.campaigns.find((candidate) => candidate.id === campaign?.id);
						if (storedCampaign) {
							const outcome =
								storedCampaign.status === "stopped"
									? "stopped"
									: storedCampaign.status === "failed"
										? "failed"
										: "completed";
							finishMissionForCampaign(
								draft,
								storedCampaign,
								outcome,
								storedCampaign.stopReason ?? `Campaign ${outcome}`,
							);
						}
					});
				}
				return;
			}
			await this.store.update((draft) => {
				const storedMission = draft.missions.find((candidate) => candidate.id === missionId);
				const storedCampaign = draft.campaigns.find((candidate) => candidate.id === campaign?.id);
				if (!storedMission || !storedCampaign || storedMission.desiredState !== "running") {
					return;
				}
				storedMission.phase = "starting";
				storedMission.updatedAt = now();
				storedCampaign.runIntent = "running";
				storedCampaign.updatedAt = now();
			});
			let research = await this.startResearch();
			while (research.runId === "external" && !this.shutdownPromise) {
				await delay(1_000);
				const current = await this.store.read();
				const currentMission = current.missions.find((candidate) => candidate.id === missionId);
				if (currentMission?.desiredState !== "running") {
					return;
				}
				research = await this.resumePersistedResearch();
			}
			await this.store.update((draft) => {
				const storedMission = draft.missions.find((candidate) => candidate.id === missionId);
				const storedCampaign = draft.campaigns.find((candidate) => candidate.id === campaign?.id);
				if (
					!storedMission ||
					!storedCampaign ||
					storedMission.desiredState !== "running" ||
					["completed", "stopped", "failed"].includes(storedCampaign.status)
				) {
					return;
				}
				storedMission.phase = "researching";
				storedMission.startedAt ??= now();
				storedMission.updatedAt = now();
				appendMissionDiagnostic(storedMission, {
					phase: "researching",
					code: "research_started",
					message: "Autonomous research is running in the durable local kernel.",
					retryable: true,
				});
				appendMaterialUpdate(draft, {
					missionId: storedMission.id,
					campaignId: storedCampaign.id,
					kind: "mission",
					summary: "Autonomous research started",
					refs: [storedMission.id, storedCampaign.id],
				});
			});
			this.changed();
		} catch (error) {
			const message = errorMessage(error);
			const interrupted =
				error instanceof Error &&
				error.name === "AbortError" &&
				(this.shutdownPromise !== undefined || this.calibrationController?.signal.aborted === true);
			await this.store.update((state) => {
				const mission = state.missions.find((candidate) => candidate.id === missionId);
				if (!mission || mission.desiredState !== "running") {
					return;
				}
				mission.phase = interrupted ? "accepted" : "failed";
				mission.completedAt = interrupted ? undefined : now();
				mission.updatedAt = now();
				appendMissionDiagnostic(mission, {
					phase: mission.phase,
					code: interrupted ? "calibration_interrupted" : "mission_failed",
					message,
					retryable: interrupted,
				});
				appendMaterialUpdate(state, {
					missionId: mission.id,
					campaignId: mission.campaignId,
					kind: interrupted ? "recovery" : "failure",
					summary: interrupted ? "Calibration interrupted; the next kernel will retry it" : message,
					refs: [mission.id, ...(mission.campaignId ? [mission.campaignId] : [])],
				});
			});
			this.changed();
			if (!interrupted) {
				throw error;
			}
		}
	}

	async calibrateCampaign(input: CampaignCalibrationInput): Promise<Campaign> {
		return this.queueCalibration(input);
	}

	private async queueCalibration(input: CampaignCalibrationInput, missionId?: string): Promise<Campaign> {
		if (this.calibrationPromise) {
			throw new Error("ISO campaign calibration is already in progress.");
		}
		if (this.shutdownPromise) {
			throw new Error("ISO runtime is shutting down.");
		}
		const controller = new AbortController();
		const abort = (): void => controller.abort();
		if (input.signal?.aborted) {
			controller.abort();
		} else {
			input.signal?.addEventListener("abort", abort, { once: true });
		}
		const operation = this.performCalibration({ ...input, signal: controller.signal }, missionId);
		this.calibrationController = controller;
		this.calibrationPromise = operation;
		void operation.then(
			() => {
				if (this.calibrationPromise === operation) {
					this.calibrationPromise = undefined;
					this.calibrationController = undefined;
				}
				input.signal?.removeEventListener("abort", abort);
			},
			() => {
				if (this.calibrationPromise === operation) {
					this.calibrationPromise = undefined;
					this.calibrationController = undefined;
				}
				input.signal?.removeEventListener("abort", abort);
			},
		);
		return operation;
	}

	private async performCalibration(input: CampaignCalibrationInput, missionId?: string): Promise<Campaign> {
		validateCalibration(input);
		const existing = getActiveCampaign(await this.store.read());
		if (existing) {
			throw new Error(`ISO already has active campaign ${existing.id}. Stop or complete it first.`);
		}
		await removeIsoWorktrees(this.repoRoot);
		const source = sourceBundleFromInput(input) ?? (await captureSourceBundle(this.repoRoot, input.goal));
		await verifySourceBundle(this.repoRoot, source);
		const protectedPaths = input.config.evaluator.protectedPaths.map((protectedPath) =>
			normalizeRepositoryRelativePath(protectedPath, "Protected evaluator path"),
		);
		if (new Set(protectedPaths).size !== protectedPaths.length) {
			throw new Error("Protected evaluator paths must be unique after normalization.");
		}
		const readOnlyPaths = await frozenEvaluatorReadPaths(this.repoRoot, protectedPaths);
		const sourceCommit = source.sourceCommit;
		const controlCwd = resolve(this.repoRoot, input.config.evaluator.controlCwd);
		const controlRelative = relative(this.repoRoot, controlCwd);
		if (controlRelative === ".." || controlRelative.startsWith(`..${sep}`) || isAbsolute(controlRelative)) {
			throw new Error("Evaluator controlCwd must stay inside the repository.");
		}
		const calibrationNonce = makeId("calibration");
		const baselineSamples: EvaluationAggregate[] = [];
		const baselineControlWorktree = await createEvaluatorControlWorktree({
			repoRoot: this.repoRoot,
			worktreeId: `evaluation-control-${createHash("sha256")
				.update(`${sourceCommit}\0${calibrationNonce}\0baseline-control`)
				.digest("hex")
				.slice(0, 24)}`,
			commit: sourceCommit,
		});
		let digest: string;
		try {
			const sourceControlCwd = resolve(baselineControlWorktree, controlRelative);
			digest = await evaluatorDigest({
				repoRoot: this.repoRoot,
				sourceRoot: baselineControlWorktree,
				controlCwd: sourceControlCwd,
				command: input.config.evaluator.command,
				protectedPaths,
			});
			for (let sampleIndex = 0; sampleIndex < input.config.evaluator.samples; sampleIndex += 1) {
				const baselineMaterializationId = `evaluation-${createHash("sha256")
					.update(`${digest}\0${sourceCommit}\0${calibrationNonce}\0baseline-materialization\0${sampleIndex}`)
					.digest("hex")
					.slice(0, 24)}`;
				const baselineTrialId = createHash("sha256")
					.update(`${digest}\0${sourceCommit}\0${calibrationNonce}\0baseline-trial\0${sampleIndex}`)
					.digest("hex");
				const baselineWorktree = await createDetachedWorktree({
					repoRoot: this.repoRoot,
					worktreeId: baselineMaterializationId,
					commit: sourceCommit,
				});
				try {
					baselineSamples.push(
						domainEvaluation(
							await runEvaluator(input.config.evaluator.command, {
								repoRoot: this.repoRoot,
								controlCwd: sourceControlCwd,
								experimentDir: baselineWorktree,
								warmups: input.config.evaluator.warmups,
								samples: 1,
								sampleIndexOffset: sampleIndex,
								timeoutMs: input.config.evaluator.timeoutMs,
								trialId: baselineTrialId,
								signal: input.signal,
								readOnlyPaths,
							}),
						),
					);
				} finally {
					await removeWorktree(this.repoRoot, baselineWorktree);
				}
			}
			await assertEvaluatorDigest(digest, {
				repoRoot: this.repoRoot,
				sourceRoot: baselineControlWorktree,
				controlCwd: sourceControlCwd,
				command: input.config.evaluator.command,
				protectedPaths,
			});
		} finally {
			await removeWorktree(this.repoRoot, baselineControlWorktree);
		}
		const baselineEvaluation = combineIndependentEvaluations(baselineSamples);
		assertEvaluationWithinScoreBounds(input.config.evaluator.scoreBounds, baselineEvaluation);
		if (!baselineEvaluation.valid) {
			throw new Error(
				`Baseline evaluator failed constraints: ${baselineEvaluation.failedConstraints.join(", ") || "valid=false"}`,
			);
		}
		if (input.signal?.aborted) {
			throw cancellationError("Campaign calibration was cancelled.");
		}
		const campaign = await this.store.initialize(
			{
				goal: input.goal,
				metric: input.metric,
				config: {
					...input.config,
					evaluator: { ...input.config.evaluator, controlCwd, protectedPaths },
				},
				sourceCommit,
				sourceHeadCommit: source.sourceHeadCommit,
				sourceSnapshotRef: source.sourceSnapshotRef,
				sourceHadLocalChanges: source.sourceHadLocalChanges,
				sourceSnapshotPaths: source.sourceSnapshotPaths,
				dependencyDigest: source.dependencyDigest,
				evaluatorDigest: digest,
				runtimeProvenance: currentRuntimeProvenance(),
				baseline: {
					commit: sourceCommit,
					evaluatorDigest: digest,
					resultSchemaDigest: resultSchemaDigest(baselineEvaluation),
					evaluation: baselineEvaluation,
				},
			},
			missionId,
			input.expectedAdmissionEpoch,
		);
		this.changed();
		return campaign;
	}

	startResearch(): Promise<ResearchReceipt> {
		return this.queueResearchStart(true);
	}

	resumePersistedResearch(): Promise<ResearchReceipt> {
		return this.queueResearchStart(false);
	}

	private queueResearchStart(explicit: boolean): Promise<ResearchReceipt> {
		if (this.startPromise) {
			if (!explicit) {
				return this.startPromise.then((receipt) => ({ ...receipt, started: false }));
			}
			const previous = this.startPromise;
			const queued = previous.then(
				() => this.prepareResearchStart(true),
				() => this.prepareResearchStart(true),
			);
			this.trackResearchStart(queued);
			return queued;
		}
		const operation = this.prepareResearchStart(explicit);
		this.trackResearchStart(operation);
		return operation;
	}

	private queueCommittedResearchStart(campaignId: string): Promise<ResearchReceipt> {
		if (this.startPromise) {
			const previous = this.startPromise;
			const queued = previous.then(
				() => this.prepareCommittedResearchStart(campaignId),
				() => this.prepareCommittedResearchStart(campaignId),
			);
			this.trackResearchStart(queued);
			return queued;
		}
		const operation = this.prepareCommittedResearchStart(campaignId);
		this.trackResearchStart(operation);
		return operation;
	}

	private trackResearchStart(operation: Promise<ResearchReceipt>): void {
		this.startPromise = operation;
		void operation.then(
			() => {
				if (this.startPromise === operation) {
					this.startPromise = undefined;
				}
			},
			() => {
				if (this.startPromise === operation) {
					this.startPromise = undefined;
				}
			},
		);
	}

	private async prepareResearchStart(explicit: boolean): Promise<ResearchReceipt> {
		if (this.shutdownPromise) {
			return { runId: "none", started: false };
		}
		const campaignId = await this.store.update((state) => {
			const campaign = getActiveCampaign(state);
			if (!campaign || (!explicit && campaign.runIntent !== "running")) {
				return undefined;
			}
			if (explicit) {
				campaign.runIntent = "running";
				if (campaign.status === "paused" || campaign.status === "pausing") {
					campaign.status = this.loopPromise ? "running" : "ready";
					campaign.stopReason = undefined;
				}
				campaign.updatedAt = now();
			}
			return campaign.id;
		});
		if (!campaignId) {
			return { runId: "none", started: false };
		}
		return this.beginResearchLoop(campaignId);
	}

	private async prepareCommittedResearchStart(campaignId: string): Promise<ResearchReceipt> {
		if (this.shutdownPromise) {
			return { runId: "none", started: false };
		}
		const state = await this.store.read();
		const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
		if (
			!campaign ||
			campaign.runIntent !== "running" ||
			["completed", "stopped", "failed"].includes(campaign.status)
		) {
			return { runId: "none", started: false };
		}
		return this.beginResearchLoop(campaignId);
	}

	private beginResearchLoop(campaignId: string): ResearchReceipt {
		if (this.loopPromise) {
			return { runId: this.activeRunId ?? "active", started: false };
		}
		if (!this.store.tryAcquireLease(ORCHESTRATOR_LEASE, this.ownerId, LEASE_TTL_MS)) {
			return { runId: "external", started: false };
		}
		const runId = makeId("run");
		this.activeRunId = runId;
		this.runController = new AbortController();
		this.loopError = undefined;
		this.loopPromise = this.runResearchLoop(runId, campaignId)
			.catch(async (error: unknown) => {
				this.loopError = error;
				await this.failCampaign(error, campaignId);
			})
			.finally(() => {
				this.stopLease();
				this.loopPromise = undefined;
				this.activeRunId = undefined;
				this.changed();
			});
		return { runId, started: true };
	}

	async runToCompletion(): Promise<void> {
		const receipt = await this.startResearch();
		if (!receipt.started && !this.loopPromise) {
			throw new Error(
				receipt.runId === "external"
					? "Another ISO kernel owns the active research run."
					: "No active ISO campaign is available to run.",
			);
		}
		await this.loopPromise;
		if (this.loopError !== undefined) {
			throw this.loopError;
		}
	}

	async resumeMission(): Promise<MissionReceipt | undefined> {
		const resumed = await this.store.update((state) => {
			const mission = getActiveMission(state);
			if (!mission) {
				return undefined;
			}
			mission.desiredState = "running";
			mission.phase = mission.campaignId ? "starting" : "accepted";
			mission.completedAt = undefined;
			mission.updatedAt = now();
			const campaign = mission.campaignId
				? state.campaigns.find((candidate) => candidate.id === mission.campaignId)
				: undefined;
			if (campaign && !["completed", "stopped", "failed"].includes(campaign.status)) {
				campaign.runIntent = "running";
				if (campaign.status === "paused" || campaign.status === "pausing") {
					campaign.status = "ready";
					campaign.stopReason = undefined;
				}
				campaign.updatedAt = now();
			}
			appendMaterialUpdate(state, {
				missionId: mission.id,
				campaignId: campaign?.id,
				kind: "operator",
				summary: "Mission resume requested",
				refs: [mission.id, ...(campaign ? [campaign.id] : [])],
			});
			return {
				missionId: mission.id,
				preflightId: mission.preflightId,
				launchOperationId: mission.launchOperationId,
				phase: mission.phase,
				accepted: false,
				campaignId: mission.campaignId,
			} satisfies MissionReceipt;
		});
		if (resumed) {
			this.changed();
			void this.resumePersistedMission().catch(() => undefined);
		}
		return resumed;
	}

	async pause(): Promise<void> {
		const activeCalibration = this.calibrationPromise;
		await this.store.update((state) => {
			const campaign = getActiveCampaign(state);
			const mission = getActiveMission(state);
			if (!campaign && !mission) {
				throw new Error("No active ISO campaign or mission is available to pause.");
			}
			if (mission) {
				mission.desiredState = "paused";
				if (!campaign || mission.phase === "accepted" || mission.phase === "calibrating") {
					mission.phase = "paused";
					mission.completedAt = undefined;
				}
				mission.updatedAt = now();
				appendMissionDiagnostic(mission, {
					phase: mission.phase,
					code: "pause_requested",
					message: "Operator requested a pause at the next durable boundary.",
					retryable: true,
				});
				appendMaterialUpdate(state, {
					missionId: mission.id,
					campaignId: campaign?.id,
					kind: "operator",
					summary: "Mission pause requested",
					refs: [mission.id, ...(campaign ? [campaign.id] : [])],
				});
			}
			if (!campaign) {
				return;
			}
			campaign.runIntent = "paused";
			if (!["planning", "running"].includes(campaign.status)) {
				campaign.status = "paused";
			} else {
				campaign.status = "pausing";
			}
			campaign.updatedAt = now();
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					generationId: campaign.activeGenerationId,
					type: "campaign.pause-requested",
					summary: "Research will pause at the next durable boundary",
					actor: "human",
					refs: [campaign.id],
				}),
			);
		});
		if (
			!(await this.store.read()).campaigns.some(
				(campaign) => !["completed", "stopped", "failed"].includes(campaign.status),
			)
		) {
			this.calibrationController?.abort();
			await activeCalibration?.catch(() => undefined);
			await this.missionPromise?.catch(() => undefined);
		}
		this.changed();
	}

	async stop(reason = "Stopped by operator"): Promise<void> {
		const activeCalibration = this.calibrationPromise;
		await this.store.update((state) => {
			const campaign = getActiveCampaign(state);
			const mission = getActiveMission(state);
			if (!campaign && !mission) {
				return;
			}
			if (mission) {
				mission.desiredState = "stopped";
				mission.phase = "stopped";
				mission.completedAt = now();
				mission.updatedAt = now();
				appendMissionDiagnostic(mission, {
					phase: "stopped",
					code: "operator_stopped",
					message: reason,
					retryable: false,
				});
				if (!campaign) {
					appendMaterialUpdate(state, {
						missionId: mission.id,
						kind: "completion",
						summary: reason,
						refs: [mission.id],
					});
				}
			}
			if (!campaign) {
				return;
			}
			const activeGenerationId = campaign.activeGenerationId;
			campaign.status = "stopped";
			campaign.runIntent = "stopped";
			campaign.stopReason = reason;
			campaign.activeGenerationId = undefined;
			campaign.updatedAt = now();
			if (activeGenerationId) {
				const generation = state.generations.find((candidate) => candidate.id === activeGenerationId);
				if (generation && !["completed", "cancelled", "failed"].includes(generation.status)) {
					generation.status = "cancelled";
					generation.finishedAt = now();
					generation.updatedAt = now();
				}
				for (const experiment of state.experiments.filter(
					(candidate) => candidate.generationId === activeGenerationId && !isTerminalExperiment(candidate),
				)) {
					transitionExperimentToTerminal(state, experiment, {
						status: "cancelled",
						failure: failure("selection", "cancelled", reason, false),
						ideaStatus: "rejected",
						countFailure: false,
					});
				}
			}
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					generationId: activeGenerationId,
					type: "campaign.stopped",
					summary: reason,
					actor: "human",
					refs: [campaign.id],
				}),
			);
			finishMissionForCampaign(state, campaign, "stopped", reason);
		});
		this.changed();
		this.calibrationController?.abort();
		this.requestQuiescence();
		await activeCalibration?.catch(() => undefined);
		await this.missionPromise?.catch(() => undefined);
		await this.startPromise?.catch(() => undefined);
		this.requestQuiescence();
		const activeLoop = this.loopPromise;
		await activeLoop;
	}

	async steer(workerId: string, message: string): Promise<void> {
		const active = this.activeExperiments.get(workerId);
		if (!active?.control) {
			throw new Error(`Worker ${workerId} is not currently steerable.`);
		}
		await active.control.steer(message);
		active.snapshot.activity = `Steered: ${message}`;
		await this.store.update((state) => {
			const experiment = state.experiments.find((candidate) => candidate.id === active.snapshot.experimentId);
			if (experiment) {
				state.events.push(
					createEvent({
						campaignId: experiment.campaignId,
						generationId: experiment.generationId,
						experimentId: experiment.id,
						type: "worker.steered",
						summary: message,
						actor: "human",
						refs: [workerId, experiment.id],
					}),
				);
			}
		});
		this.changed();
	}

	async abort(workerId: string): Promise<void> {
		const active = this.activeExperiments.get(workerId);
		if (!active) {
			throw new Error(`Worker ${workerId} is not active.`);
		}
		active.snapshot.activity = "Cancellation requested";
		active.controller.abort();
		await active.control?.abort();
		this.changed();
	}

	async reconcileAfterRestart(): Promise<number> {
		let reconciled = 0;
		let reconciledAgentCalls = 0;
		let recoveredCampaigns = 0;
		await this.store.update((state) => {
			const resumableGenerationIds = new Set<string>();
			for (const attempt of state.agentCallAttempts) {
				if (attempt.status !== "running") {
					continue;
				}
				attempt.status = "interrupted";
				attempt.missingTokenAccounting = attempt.inputTokens === undefined || attempt.outputTokens === undefined;
				attempt.missingCostAccounting = attempt.costUsd === undefined;
				attempt.error = "ISO kernel stopped before this research agent call reached a durable terminal state.";
				attempt.finishedAt = now();
				reconciledAgentCalls += 1;
			}
			for (const experiment of state.experiments) {
				const generation = state.generations.find((candidate) => candidate.id === experiment.generationId);
				const generationCanResume =
					generation !== undefined && !["completed", "cancelled", "failed"].includes(generation.status);
				const hasFrozenCandidate = experiment.candidateCommit !== undefined;
				const hasDurablePostFreezeWork =
					hasFrozenCandidate &&
					generationCanResume &&
					["candidate-frozen", "evaluating", "measured"].includes(experiment.status);
				if (hasDurablePostFreezeWork) {
					if (experiment.status === "evaluating") {
						experiment.status = "candidate-frozen";
						reconciled += 1;
					}
					if (experiment.status === "measured") {
						experiment.screeningPassed ??= experiment.credibleImprovement === true;
						if (!experiment.confirmationHistory?.some((evidence) => evidence.confirmed)) {
							experiment.credibleImprovement = false;
						}
					}
					experiment.workerId = undefined;
					experiment.failure = undefined;
					experiment.finishedAt = experiment.status === "measured" ? experiment.finishedAt : undefined;
					experiment.updatedAt = now();
					resumableGenerationIds.add(experiment.generationId);
					continue;
				}
				if (isTerminalExperiment(experiment)) {
					continue;
				}
				const interruptedStatus = experiment.status;
				const requeueClaim =
					experiment.startedAt === undefined && claimedRetryForExperiment(state, experiment) !== undefined;
				const result = transitionExperimentToTerminal(state, experiment, {
					status: "interrupted",
					failure: failure(
						interruptedStatus === "evaluating" ? "evaluator" : "agent",
						"infrastructure",
						"ISO kernel stopped before this experiment reached a durable terminal state.",
						true,
					),
					ideaStatus: "failed",
					countFailure: false,
					enqueueRetry: !requeueClaim,
					requeueClaimIfUnstarted: requeueClaim,
				});
				if (result.transitioned) {
					reconciled += 1;
				}
			}
			for (const generation of state.generations) {
				if (["completed", "cancelled", "failed"].includes(generation.status)) {
					continue;
				}
				const campaign = state.campaigns.find((candidate) => candidate.id === generation.campaignId);
				const confirmed = state.experiments
					.filter((experiment) => experiment.generationId === generation.id)
					.map((experiment) => ({
						experiment,
						evidence: [...(experiment.confirmationHistory ?? [])]
							.reverse()
							.find((evidence) => evidence.confirmed),
					}))
					.find(
						(entry): entry is { experiment: Experiment; evidence: ConfirmationEvidence } =>
							entry.evidence !== undefined,
					);
				if (campaign && confirmed) {
					promoteConfirmedExperiment(state, campaign, generation, confirmed.experiment, confirmed.evidence);
					resumableGenerationIds.add(generation.id);
				}
				if (resumableGenerationIds.has(generation.id) || generation.status === "reflecting") {
					if (generation.status !== "reflecting") {
						generation.status = "verifying";
					}
					generation.finishedAt = undefined;
					generation.updatedAt = now();
					continue;
				}
				generation.status = "failed";
				generation.finishedAt = now();
				generation.updatedAt = now();
			}
			for (const campaign of state.campaigns) {
				if (!["planning", "running", "pausing"].includes(campaign.status)) {
					continue;
				}
				const shouldResume = campaign.runIntent === "running";
				const resumableGeneration = state.generations
					.filter(
						(generation) =>
							generation.campaignId === campaign.id &&
							!["completed", "cancelled", "failed"].includes(generation.status),
					)
					.sort((left, right) => right.index - left.index)[0];
				campaign.status = shouldResume ? "ready" : "paused";
				campaign.runIntent = shouldResume ? "running" : "paused";
				campaign.stopReason = shouldResume
					? resumableGeneration
						? "Recovered frozen experiment state after kernel restart; resuming exactly"
						: "Recovered after kernel restart; resuming automatically"
					: "Recovered the operator's pending pause after kernel restart";
				campaign.activeGenerationId = resumableGeneration?.id;
				campaign.updatedAt = now();
				recoveredCampaigns += 1;
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						type: "kernel.reconciled",
						summary: resumableGeneration
							? `Recovered generation ${resumableGeneration.index} with its frozen candidates and paired plans`
							: `Recovered ${reconciled} interrupted experiments after restart`,
						actor: "system",
						refs: [campaign.id, ...(resumableGeneration ? [resumableGeneration.id] : [])],
					}),
				);
				appendMaterialUpdate(state, {
					missionId: campaign.missionId,
					campaignId: campaign.id,
					kind: "recovery",
					summary: resumableGeneration
						? "Recovered the same frozen experiment and opaque evaluator plans; no candidate was redrawn"
						: `Recovered ${reconciled} interrupted experiments; retryable pre-freeze work was re-queued`,
					refs: [campaign.id, ...(resumableGeneration ? [resumableGeneration.id] : [])],
				});
			}
			for (const mission of state.missions) {
				if (
					mission.desiredState === "running" &&
					!mission.campaignId &&
					["calibrating", "starting", "researching"].includes(mission.phase)
				) {
					mission.phase = "accepted";
					mission.updatedAt = now();
					appendMissionDiagnostic(mission, {
						phase: "accepted",
						code: "kernel_restart",
						message: "Kernel restarted before campaign creation; calibration will resume.",
						retryable: true,
					});
					appendMaterialUpdate(state, {
						missionId: mission.id,
						kind: "recovery",
						summary: "Kernel restarted; mission calibration will resume",
						refs: [mission.id],
					});
					recoveredCampaigns += 1;
				} else if (mission.desiredState === "paused" && !mission.campaignId) {
					mission.phase = "paused";
					mission.updatedAt = now();
				}
			}
		});
		let removedWorktrees = 0;
		try {
			removedWorktrees = await removeIsoWorktrees(this.repoRoot);
		} catch (error) {
			await this.store.update((state) => {
				const campaign = selectedCampaign(state);
				if (campaign) {
					state.events.push(
						createEvent({
							campaignId: campaign.id,
							type: "kernel.cleanup-failed",
							summary: `Orphan worktree cleanup failed: ${errorMessage(error)}`,
							actor: "system",
							refs: [campaign.id],
						}),
					);
				}
			});
		}
		if (reconciled > 0 || reconciledAgentCalls > 0 || recoveredCampaigns > 0 || removedWorktrees > 0) {
			this.changed();
		}
		return Math.max(reconciled, reconciledAgentCalls, recoveredCampaigns);
	}

	shutdown(): Promise<void> {
		this.shutdownPromise ??= this.performShutdown();
		return this.shutdownPromise;
	}

	private async performShutdown(): Promise<void> {
		this.calibrationController?.abort();
		this.requestQuiescence();
		await this.calibrationPromise?.catch(() => undefined);
		await this.missionPromise?.catch(() => undefined);
		await this.startPromise?.catch(() => undefined);
		this.requestQuiescence();
		await this.loopPromise;
		this.store.releaseLease(ORCHESTRATOR_LEASE, this.ownerId);
		this.store.close();
	}

	private changed(): void {
		for (const listener of this.listeners) {
			listener();
		}
	}

	private async runAgentCall<T extends { provenance?: AgentProvenance }>(
		options: {
			campaign: Campaign;
			generationId: string;
			experimentId?: string;
			ideaId?: string;
			role: AgentCallRole;
			attempt: number;
			signal: AbortSignal;
		},
		operation: (onUsage: (provenance: AgentProvenance) => void) => Promise<T>,
	): Promise<T> {
		const id = makeId("agent-call");
		const policy = options.campaign.config.agentModel;
		const startedAt = now();
		await this.store.update((state) => {
			const attempt: AgentCallAttempt = {
				id,
				campaignId: options.campaign.id,
				generationId: options.generationId,
				experimentId: options.experimentId,
				ideaId: options.ideaId,
				role: options.role,
				attempt: options.attempt,
				status: "running",
				provider: policy?.provider,
				model: policy?.model,
				thinkingLevel: policy?.thinkingLevel,
				missingTokenAccounting: true,
				missingCostAccounting: true,
				startedAt,
			};
			state.agentCallAttempts.push(attempt);
		});
		this.changed();

		let observedProvenance: AgentProvenance | undefined;
		const onUsage = (provenance: AgentProvenance): void => {
			observedProvenance = structuredClone(provenance);
		};
		try {
			const result = await operation(onUsage);
			const provenance = result.provenance ?? observedProvenance;
			if (
				policy &&
				(!provenance ||
					provenance.provider !== policy.provider ||
					provenance.model !== policy.model ||
					provenance.thinkingLevel !== policy.thinkingLevel)
			) {
				throw new Error(
					`Research ${options.role} did not use the pinned model policy ${policy.provider}/${policy.model}:${policy.thinkingLevel}.`,
				);
			}
			await this.finishAgentCall(id, "succeeded", provenance);
			return result;
		} catch (error) {
			await this.finishAgentCall(
				id,
				failedAgentCallStatus(error, options.signal),
				observedProvenance,
				errorMessage(error),
			);
			throw error;
		}
	}

	private async finishAgentCall(
		id: string,
		status: Exclude<AgentCallStatus, "running" | "interrupted">,
		provenance?: AgentProvenance,
		error?: string,
	): Promise<void> {
		await this.store.update((state) => {
			const attempt = state.agentCallAttempts.find((candidate) => candidate.id === id);
			if (!attempt || attempt.status !== "running") {
				return;
			}
			attempt.status = status;
			attempt.provider = provenance?.provider ?? attempt.provider;
			attempt.model = provenance?.model ?? attempt.model;
			attempt.thinkingLevel = provenance?.thinkingLevel ?? attempt.thinkingLevel;
			attempt.sessionId = provenance?.sessionId;
			attempt.inputTokens = provenance?.inputTokens;
			attempt.outputTokens = provenance?.outputTokens;
			attempt.costUsd = provenance?.cost;
			attempt.missingTokenAccounting =
				provenance?.inputTokens === undefined || provenance.outputTokens === undefined;
			attempt.missingCostAccounting = provenance?.cost === undefined;
			attempt.error = error?.slice(0, MAX_EVIDENCE_TEXT);
			attempt.finishedAt = now();
		});
		this.changed();
	}

	private releaseActive(workerId: string): void {
		const active = this.activeExperiments.get(workerId);
		active?.detachRunAbort?.();
		this.activeExperiments.delete(workerId);
	}

	private requestQuiescence(): void {
		this.runController?.abort();
		for (const active of this.activeExperiments.values()) {
			active.controller.abort();
			void active.control?.abort();
		}
	}

	private async evaluateFrozenSample(
		campaign: Campaign,
		commit: string,
		worktreeId: string,
		controlWorktree: string,
		signal?: AbortSignal,
		trialId = worktreeId,
		sampleIndex = 0,
	): Promise<EvaluationAggregate> {
		const materializationId = `evaluation-${createHash("sha256")
			.update(`${campaign.id}\0${worktreeId}`)
			.digest("hex")
			.slice(0, 24)}`;
		const worktree = await createDetachedWorktree({
			repoRoot: this.repoRoot,
			worktreeId: materializationId,
			commit,
		});
		try {
			const controlRelative = relative(this.repoRoot, campaign.config.evaluator.controlCwd);
			if (controlRelative === ".." || controlRelative.startsWith(`..${sep}`) || isAbsolute(controlRelative)) {
				throw new Error("Frozen evaluator controlCwd escaped the repository.");
			}
			return domainEvaluation(
				await runEvaluator(campaign.config.evaluator.command, {
					repoRoot: this.repoRoot,
					controlCwd: resolve(controlWorktree, controlRelative),
					experimentDir: worktree,
					warmups: campaign.config.evaluator.warmups,
					samples: 1,
					sampleIndexOffset: sampleIndex,
					timeoutMs: campaign.config.evaluator.timeoutMs,
					trialId,
					signal,
					readOnlyPaths: await frozenEvaluatorReadPaths(this.repoRoot, campaign.config.evaluator.protectedPaths),
				}),
			);
		} finally {
			await removeWorktree(this.repoRoot, worktree);
		}
	}

	private async ensurePairedEvaluationPlan(
		experimentId: string,
		kind: PairedEvaluationPlan["kind"],
		sampleCount: number,
		opportunityIndex?: number,
	): Promise<PairedEvaluationPlan> {
		assertPositiveInteger(sampleCount, "paired evaluation sampleCount");
		return this.store.update((state) => {
			const experiment = state.experiments.find((candidate) => candidate.id === experimentId);
			if (!experiment?.candidateCommit) {
				throw new Error(
					`Experiment ${experimentId} must freeze its candidate before evaluator trials are planned.`,
				);
			}
			const key = kind === "screen" ? "screeningPlan" : "confirmationPlan";
			const existing = experiment[key];
			if (existing) {
				if (
					existing.kind !== kind ||
					existing.trialIds.length !== sampleCount ||
					(opportunityIndex !== undefined && existing.opportunityIndex !== opportunityIndex)
				) {
					throw new Error(`Frozen ${kind} evaluation plan for ${experimentId} conflicts with this request.`);
				}
				return structuredClone(existing);
			}
			const resolvedOpportunityIndex =
				kind === "confirmation"
					? (opportunityIndex ??
						state.experiments.filter(
							(candidate) =>
								candidate.campaignId === experiment.campaignId && candidate.confirmationPlan !== undefined,
						).length + 1)
					: undefined;
			const entropy = randomBytes(32).toString("hex");
			const plan: PairedEvaluationPlan = {
				id: `pair_${entropy}`,
				kind,
				trialIds: Array.from(
					{ length: sampleCount },
					(_, index) => `trial_${randomBytes(32).toString("hex")}_${index}`,
				),
				startsWithCandidate: (randomBytes(1)[0] & 1) === 1,
				...(resolvedOpportunityIndex === undefined ? {} : { opportunityIndex: resolvedOpportunityIndex }),
				createdAt: now(),
			};
			experiment[key] = plan;
			experiment.updatedAt = plan.createdAt;
			state.events.push(
				createEvent({
					campaignId: experiment.campaignId,
					generationId: experiment.generationId,
					experimentId: experiment.id,
					type: `evaluator.${kind}-plan-frozen`,
					summary: `Frozen ${kind} paired trial plan before evaluator execution`,
					actor: "evaluator",
					refs: [experiment.id, plan.id],
					data: {
						sampleCount,
						...(resolvedOpportunityIndex === undefined ? {} : { opportunityIndex: resolvedOpportunityIndex }),
					},
				}),
			);
			return structuredClone(plan);
		});
	}

	private async evaluateFrozenPair(
		campaign: Campaign,
		incumbentCommit: string,
		candidateCommit: string,
		plan: PairedEvaluationPlan,
		signal?: AbortSignal,
	): Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }> {
		if (plan.trialIds.length !== campaign.config.evaluator.samples) {
			throw new Error("Frozen paired evaluation plan does not match the campaign sample count.");
		}
		const incumbentSamples: EvaluationAggregate[] = [];
		const candidateSamples: EvaluationAggregate[] = [];
		const startsWithCandidate = plan.startsWithCandidate;
		let evaluationError: unknown;
		let controlWorktree: string | undefined;
		try {
			controlWorktree = await createEvaluatorControlWorktree({
				repoRoot: this.repoRoot,
				worktreeId: `evaluation-control-${createHash("sha256")
					.update(`${campaign.id}\0${plan.id}\0control`)
					.digest("hex")
					.slice(0, 24)}`,
				commit: campaign.sourceCommit,
			});
			const controlRelative = relative(this.repoRoot, campaign.config.evaluator.controlCwd);
			if (controlRelative === ".." || controlRelative.startsWith(`..${sep}`) || isAbsolute(controlRelative)) {
				throw new Error("Frozen evaluator controlCwd escaped the repository.");
			}
			const integrityOptions = {
				repoRoot: this.repoRoot,
				sourceRoot: controlWorktree,
				controlCwd: resolve(controlWorktree, controlRelative),
				command: campaign.config.evaluator.command,
				protectedPaths: campaign.config.evaluator.protectedPaths,
			};
			await assertEvaluatorDigest(campaign.evaluatorDigest, integrityOptions);
			for (let sampleIndex = 0; sampleIndex < campaign.config.evaluator.samples; sampleIndex += 1) {
				if (signal?.aborted) {
					throw cancellationError("Evaluator pair was cancelled.");
				}
				const opaqueTrialId = plan.trialIds[sampleIndex];
				if (!opaqueTrialId) {
					throw new Error(`Frozen paired evaluation plan is missing trial ${sampleIndex}.`);
				}
				const candidateFirst = (sampleIndex % 2 === 0) === startsWithCandidate;
				const arms = candidateFirst
					? ([
							["candidate", candidateCommit, candidateSamples],
							["incumbent", incumbentCommit, incumbentSamples],
						] as const)
					: ([
							["incumbent", incumbentCommit, incumbentSamples],
							["candidate", candidateCommit, candidateSamples],
						] as const);
				for (const [arm, commit, destination] of arms) {
					try {
						destination.push(
							await this.evaluateFrozenSample(
								campaign,
								commit,
								`${plan.id}-${sampleIndex}-${arm}`,
								controlWorktree,
								signal,
								opaqueTrialId,
								sampleIndex,
							),
						);
					} catch (error) {
						if (arm === "incumbent" && error instanceof EvaluatorContractError) {
							throw new IncumbentInvalidError(
								`Incumbent evaluator output violated the frozen contract: ${error.message}`,
							);
						}
						throw error;
					}
				}
			}
			await assertEvaluatorDigest(campaign.evaluatorDigest, integrityOptions);
		} catch (error) {
			evaluationError = error;
		}
		if (controlWorktree !== undefined) {
			try {
				await removeWorktree(this.repoRoot, controlWorktree);
			} catch (error) {
				evaluationError ??= error;
			}
		}
		if (evaluationError !== undefined) {
			throw evaluationError;
		}
		const incumbent = combineIndependentEvaluations(incumbentSamples);
		const candidate = combineIndependentEvaluations(candidateSamples);
		try {
			assertFrozenResultContract(campaign, incumbent);
		} catch (error) {
			if (error instanceof EvaluatorContractError) {
				throw new IncumbentInvalidError(
					`Incumbent evaluator output violated the frozen contract: ${error.message}`,
				);
			}
			throw error;
		}
		assertFrozenResultContract(campaign, candidate);
		return { incumbent, candidate };
	}

	private async evaluateFrozenPairReliably(
		campaign: Campaign,
		experiment: Experiment,
		incumbentCommit: string,
		plan: PairedEvaluationPlan,
		signal?: AbortSignal,
	): Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }> {
		if (!experiment.candidateCommit) {
			throw new Error(`Experiment ${experiment.id} has no frozen candidate commit.`);
		}
		for (let localAttempt = 1; localAttempt <= MAX_POST_FREEZE_ATTEMPTS_PER_RUN; localAttempt += 1) {
			await this.store.update((state) => {
				const stored = state.experiments.find((candidate) => candidate.id === experiment.id);
				if (!stored || stored.candidateCommit !== experiment.candidateCommit) {
					throw new Error(`Frozen candidate identity changed for experiment ${experiment.id}.`);
				}
				const storedPlan = plan.kind === "screen" ? stored.screeningPlan : stored.confirmationPlan;
				if (!storedPlan || !isDeepStrictEqual(storedPlan, plan)) {
					throw new Error(`Frozen ${plan.kind} plan changed for experiment ${experiment.id}.`);
				}
				if (plan.kind === "screen") {
					stored.screeningAttempts = (stored.screeningAttempts ?? 0) + 1;
				} else {
					stored.confirmationAttempts = (stored.confirmationAttempts ?? 0) + 1;
				}
				stored.updatedAt = now();
			});
			try {
				return await this.evaluateFrozenPair(campaign, incumbentCommit, experiment.candidateCommit, plan, signal);
			} catch (error) {
				if (
					error instanceof EvaluatorContractError ||
					error instanceof EvaluatorIntegrityError ||
					error instanceof IncumbentInvalidError ||
					(error instanceof Error && error.name === "AbortError") ||
					signal?.aborted
				) {
					throw error;
				}
				if (localAttempt === MAX_POST_FREEZE_ATTEMPTS_PER_RUN) {
					throw new PostFreezeEvaluationError(
						`${plan.kind === "screen" ? "Screening" : "Confirmation"} evaluator infrastructure failed ${MAX_POST_FREEZE_ATTEMPTS_PER_RUN} times for frozen experiment ${experiment.id}; refusing to create a replacement candidate or trial plan: ${errorMessage(error)}`,
						{ cause: error },
					);
				}
				await this.store.update((state) => {
					const stored = state.experiments.find((candidate) => candidate.id === experiment.id);
					if (!stored || stored.status === "cancelled") {
						return;
					}
					state.events.push(
						createEvent({
							campaignId: stored.campaignId,
							generationId: stored.generationId,
							experimentId: stored.id,
							type: `evaluator.${plan.kind}-retrying`,
							summary: `Retrying the same frozen ${plan.kind} plan after infrastructure failure: ${errorMessage(error)}`,
							actor: "system",
							refs: [stored.id, plan.id, stored.candidateCommit ?? ""].filter(Boolean),
							data: { localAttempt },
						}),
					);
				});
				await delay(250 * localAttempt);
			}
		}
		throw new Error("Frozen evaluator retry policy exhausted unexpectedly.");
	}

	private async confirmCandidate(
		campaign: Campaign,
		generation: Generation,
		experiment: Experiment,
		round: number,
		signal?: AbortSignal,
	): Promise<boolean> {
		if (!experiment.candidateCommit) {
			return false;
		}
		const plan = await this.ensurePairedEvaluationPlan(
			experiment.id,
			"confirmation",
			campaign.config.evaluator.samples,
		);
		const durableDecision = await this.store.update((state) => {
			const storedCampaign = state.campaigns.find((entry) => entry.id === campaign.id);
			const storedGeneration = state.generations.find((entry) => entry.id === generation.id);
			const storedExperiment = state.experiments.find((entry) => entry.id === experiment.id);
			if (
				!storedCampaign ||
				storedCampaign.status === "stopped" ||
				!storedGeneration ||
				storedGeneration.status === "cancelled" ||
				!storedExperiment
			) {
				return { available: false, confirmed: false };
			}
			const existing = confirmationForPlan(storedExperiment, plan, round);
			if (!existing) {
				return { available: true, confirmed: undefined };
			}
			if (existing.confirmed) {
				promoteConfirmedExperiment(state, storedCampaign, storedGeneration, storedExperiment, existing);
			}
			return { available: true, confirmed: existing.confirmed };
		});
		if (!durableDecision.available) {
			return false;
		}
		if (durableDecision.confirmed !== undefined) {
			return durableDecision.confirmed;
		}
		await this.store.update((state) => {
			const storedCampaign = state.campaigns.find((entry) => entry.id === campaign.id);
			const storedGeneration = state.generations.find((entry) => entry.id === generation.id);
			const storedExperiment = state.experiments.find((entry) => entry.id === experiment.id);
			if (
				!storedCampaign ||
				storedCampaign.status === "stopped" ||
				!storedGeneration ||
				storedGeneration.status === "cancelled" ||
				!storedExperiment ||
				confirmationForPlan(storedExperiment, plan, round)
			) {
				return;
			}
			if (
				!state.events.some(
					(event) =>
						event.experimentId === experiment.id &&
						event.type === "champion.confirmation-started" &&
						event.refs.includes(plan.id),
				)
			) {
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: generation.id,
						experimentId: experiment.id,
						type: "champion.confirmation-started",
						summary: `Confirmation ${round} started for ${experiment.id}`,
						actor: "evaluator",
						refs: [experiment.id, experiment.candidateCommit ?? "", plan.id].filter(Boolean),
						data: { round },
					}),
				);
			}
		});
		this.changed();
		try {
			const { incumbent, candidate } = await this.evaluateFrozenPairReliably(
				campaign,
				experiment,
				generation.baseCommit,
				plan,
				signal,
			);
			if (!incumbent.valid) {
				throw new IncumbentInvalidError(
					`Incumbent failed evaluator constraints during confirmation ${round}: ${
						incumbent.failedConstraints.join(", ") || "valid=false"
					}`,
				);
			}
			const opportunityIndex = plan.opportunityIndex;
			if (opportunityIndex === undefined) {
				throw new Error("Frozen confirmation plan is missing its post-selection opportunity index.");
			}
			const selection = decidePostSelection({
				direction: campaign.metric.direction,
				familyWiseAlpha: 0.05,
				maxOpportunities: campaign.config.budget.maxGenerations,
				opportunityIndex,
				threshold: campaign.metric.minimumImprovement,
				incumbent: postSelectionTrials(incumbent),
				candidate: postSelectionTrials(candidate),
				scoreBounds: campaign.config.evaluator.scoreBounds,
			});
			const improvement = selection.improvement;
			const uncertainty = selection.uncertainty;
			const lowerBound = selection.lowerBound;
			const interval: ConfirmationIntervalEvidence = {
				method: selection.method,
				alpha: selection.adjustedAlpha,
				uncertainty,
				lowerBound,
			};
			const confirmed = candidate.valid && selection.promoted;
			return this.store.update((state) => {
				const stored = state.experiments.find((entry) => entry.id === experiment.id);
				const storedCampaign = state.campaigns.find((entry) => entry.id === campaign.id);
				const storedGeneration = state.generations.find((entry) => entry.id === generation.id);
				if (!stored || !storedCampaign || !storedGeneration) {
					throw new Error(`Experiment ${experiment.id} disappeared during confirmation.`);
				}
				if (
					storedCampaign.status === "stopped" ||
					storedGeneration.status === "cancelled" ||
					stored.status === "cancelled"
				) {
					return false;
				}
				const existing = confirmationForPlan(stored, plan, round);
				if (existing) {
					if (existing.confirmed) {
						promoteConfirmedExperiment(state, storedCampaign, storedGeneration, stored, existing);
					}
					return existing.confirmed;
				}
				const measuredAt = now();
				const evidence: ConfirmationEvidence = {
					round,
					planId: plan.id,
					trialId: candidate.samples[0]?.trialId,
					candidateMean: candidate.score.mean,
					incumbentMean: incumbent.score.mean,
					improvement,
					uncertainty,
					lowerBound,
					confirmed,
					measuredAt,
					candidateEvaluation: structuredClone(candidate),
					incumbentEvaluation: structuredClone(incumbent),
					interval: structuredClone(interval),
					sampleIdentities: {
						candidate: candidate.samples.map(sampleIdentity),
						incumbent: incumbent.samples.map(sampleIdentity),
					},
					selection,
				};
				stored.confirmationEvaluation = structuredClone(candidate);
				stored.confirmationIncumbentEvaluation = structuredClone(incumbent);
				stored.confirmationImprovement = improvement;
				stored.confirmationUncertainty = uncertainty;
				stored.confirmationRoundsPassed = confirmed ? round : Math.max(0, round - 1);
				stored.confirmationHistory ??= [];
				stored.confirmationHistory.push(evidence);
				stored.credibleImprovement = confirmed;
				stored.rejectionReason = confirmed
					? undefined
					: `Fresh post-selection replication lower bound ${lowerBound} did not clear ${campaign.metric.minimumImprovement} under ${selection.claimClass}`;
				stored.updatedAt = now();
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: generation.id,
						experimentId: experiment.id,
						type: confirmed ? "champion.confirmed" : "champion.confirmation-rejected",
						summary: confirmed
							? `Confirmation ${round} accepted ${experiment.id}: Δ ${improvement} ± ${uncertainty}`
							: `Confirmation ${round} rejected ${experiment.id}: Δ ${improvement} ± ${uncertainty}`,
						actor: "evaluator",
						refs: [experiment.id, experiment.candidateCommit ?? ""].filter(Boolean),
						data: {
							confirmed,
							round,
							improvement,
							uncertainty,
							lowerBound,
							method: interval.method,
							alpha: interval.alpha,
							claimClass: selection.claimClass,
							opportunityIndex: selection.opportunityIndex,
							maxOpportunities: selection.maxOpportunities,
						},
					}),
				);
				if (confirmed) {
					promoteConfirmedExperiment(state, storedCampaign, storedGeneration, stored, evidence);
				}
				return confirmed;
			});
		} catch (error) {
			if (
				error instanceof EvaluatorIntegrityError ||
				error instanceof IncumbentInvalidError ||
				error instanceof PostFreezeEvaluationError ||
				(error instanceof Error && error.name === "AbortError")
			) {
				throw error;
			}
			const message = errorMessage(error);
			if (!(error instanceof EvaluatorContractError)) {
				throw new PostFreezeEvaluationError(
					`Confirmation processing failed for frozen experiment ${experiment.id}; refusing a replacement candidate or plan: ${message}`,
					{ cause: error },
				);
			}
			await this.store.update((state) => {
				const stored = state.experiments.find((entry) => entry.id === experiment.id);
				const storedCampaign = state.campaigns.find((entry) => entry.id === campaign.id);
				if (storedCampaign?.status === "stopped" || stored?.status === "cancelled") {
					return;
				}
				if (stored) {
					stored.status = "invalid";
					stored.confirmationRoundsPassed = Math.max(0, round - 1);
					stored.credibleImprovement = false;
					stored.rejectionReason = `Confirmation ${round} produced invalid evaluator output: ${message}`;
					stored.failure = failure("evaluator", "invalid-result", message, false);
					stored.finishedAt = now();
					stored.updatedAt = now();
				}
				if (storedCampaign) {
					storedCampaign.failures += 1;
					storedCampaign.updatedAt = now();
				}
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: generation.id,
						experimentId: experiment.id,
						type: "champion.confirmation-invalid",
						summary: `Confirmation ${round} rejected invalid evaluator output: ${message}`,
						actor: "system",
						refs: [experiment.id, plan.id],
						data: { round },
					}),
				);
			});
			return false;
		}
	}

	private async runResearchLoop(runId: string, campaignId: string): Promise<void> {
		const initialState = await this.store.read();
		const campaignAtStart = initialState.campaigns.find((campaign) => campaign.id === campaignId);
		if (
			!campaignAtStart ||
			campaignAtStart.runIntent !== "running" ||
			["completed", "stopped", "failed"].includes(campaignAtStart.status)
		) {
			return;
		}
		const provenance = campaignAtStart.runtimeProvenance;
		if (provenance && !sameRuntimeProvenance(provenance, currentRuntimeProvenance())) {
			throw new EvaluatorIntegrityError(
				"ISO runtime, Node, sandbox, agent harness, evaluator contract, or selection method changed after calibration.",
			);
		}
		if (this.runController?.signal.aborted) {
			await this.settleQuiescedCampaign(campaignAtStart.id);
			return;
		}
		this.leaseTimer = setInterval(() => {
			if (!this.store.renewLease(ORCHESTRATOR_LEASE, this.ownerId, LEASE_TTL_MS)) {
				this.requestQuiescence();
			}
		}, LEASE_TTL_MS / 3);
		this.leaseTimer.unref();
		const shouldRun = await this.store.update((state) => {
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignAtStart.id);
			if (
				!campaign ||
				campaign.runIntent !== "running" ||
				["completed", "stopped", "failed"].includes(campaign.status)
			) {
				return false;
			}
			campaign.status = "running";
			campaign.startedAt ??= now();
			campaign.stopReason = undefined;
			campaign.updatedAt = now();
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					type: "research.started",
					summary: `Research run ${runId} started`,
					actor: "conductor",
					refs: [campaign.id, runId],
				}),
			);
			return true;
		});
		if (!shouldRun) {
			return;
		}
		this.changed();

		while (true) {
			const state = await this.store.read();
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
			if (!campaign) {
				return;
			}
			if (["completed", "stopped", "failed"].includes(campaign.status)) {
				return;
			}
			if (this.runController?.signal.aborted) {
				await this.settleQuiescedCampaign(campaign.id);
				return;
			}
			if (campaign.status === "pausing" || campaign.status === "paused") {
				await this.markPaused(campaign.id);
				return;
			}
			if (campaign.status === "stopped") {
				return;
			}
			const activeGeneration = campaign.activeGenerationId
				? state.generations.find(
						(generation) =>
							generation.id === campaign.activeGenerationId &&
							!["completed", "cancelled", "failed"].includes(generation.status),
					)
				: undefined;
			if (activeGeneration) {
				await this.resumeGeneration(campaign, activeGeneration);
			} else {
				const stopReason = this.budgetStopReason(state, campaign);
				if (stopReason) {
					await this.completeCampaign(campaign.id, stopReason);
					return;
				}
				await this.runGeneration(campaign);
			}
		}
	}

	private async resumeGeneration(campaign: Campaign, generation: Generation): Promise<void> {
		const runSignal = this.runController?.signal ?? new AbortController().signal;
		let generationWorktree: string | undefined;
		try {
			generationWorktree = await createGenerationWorktree({
				repoRoot: this.repoRoot,
				generationId: generation.id,
				baseCommit: generation.baseCommit,
			});
			if (generation.status !== "reflecting") {
				await this.verifyAndSelect(campaign.id, generation.id);
			}
			await this.reflectGeneration(campaign.id, generation.id, generationWorktree, runSignal);
		} catch (error) {
			const state = await this.store.read();
			const storedCampaign = state.campaigns.find((candidate) => candidate.id === campaign.id);
			if (storedCampaign?.status === "stopped") {
				await this.cancelGeneration(generation.id, "Stopped while resuming frozen generation");
				return;
			}
			if (runSignal.aborted) {
				await this.preserveGenerationForResume(generation.id);
				return;
			}
			throw error;
		} finally {
			if (generationWorktree) {
				await this.cleanupGeneration(generation.id, generationWorktree);
			}
		}
	}

	private async reflectGeneration(
		campaignId: string,
		generationId: string,
		generationWorktree: string,
		runSignal: AbortSignal,
	): Promise<void> {
		const reflectedState = await this.store.read();
		const reflectedCampaign = reflectedState.campaigns.find((candidate) => candidate.id === campaignId);
		const reflectedGeneration = reflectedState.generations.find((candidate) => candidate.id === generationId);
		if (!reflectedCampaign || !reflectedGeneration) {
			throw new Error("Generation state disappeared before reflection.");
		}
		if (reflectedGeneration.status !== "reflecting") {
			return;
		}
		const generationExperiments = reflectedState.experiments.filter(
			(experiment) => experiment.generationId === generationId,
		);
		let reflection: GenerationReflection;
		try {
			reflection = await retryAgentOperation(runSignal, (attempt) =>
				this.runAgentCall(
					{
						campaign: reflectedCampaign,
						generationId: reflectedGeneration.id,
						role: "critic",
						attempt,
						signal: runSignal,
					},
					(onUsage) =>
						this.agents.reflectGeneration({
							cwd: generationWorktree,
							state: reflectedState,
							campaign: reflectedCampaign,
							generation: reflectedGeneration,
							experiments: generationExperiments,
							timeoutMs: reflectedCampaign.config.agentTimeoutMs,
							signal: runSignal,
							onUsage,
						}),
				),
			);
		} catch (error) {
			if (runSignal.aborted || (error instanceof Error && error.name === "AbortError")) {
				throw error;
			}
			reflection = {
				summary: `Reflection agent unavailable: ${errorMessage(error)}`,
				lessons: ["The measured experiment ledger remains authoritative."],
				deadEnds: [],
				nextFocus: ["Retry causal synthesis in the next generation."],
				shouldStop: false,
			};
		}
		await this.persistReflection(reflectedCampaign, reflectedGeneration, reflection);
	}

	private async runGeneration(campaign: Campaign): Promise<void> {
		const initialState = await this.store.read();
		const champion = initialState.experiments.find((experiment) => experiment.id === campaign.championExperimentId);
		const baseCommit = champion?.candidateCommit ?? campaign.sourceCommit;
		const generationId = makeId("generation");
		const generation: Generation = {
			id: generationId,
			campaignId: campaign.id,
			index:
				Math.max(
					0,
					...initialState.generations
						.filter((candidate) => candidate.campaignId === campaign.id)
						.map((candidate) => candidate.index),
				) + 1,
			status: "created",
			baseCommit,
			ideaIds: [],
			experimentIds: [],
			createdAt: now(),
			updatedAt: now(),
		};
		await this.store.update((state) => {
			const storedCampaign = state.campaigns.find((candidate) => candidate.id === campaign.id);
			if (!storedCampaign) {
				throw new Error(`Campaign ${campaign.id} disappeared.`);
			}
			storedCampaign.status = "planning";
			storedCampaign.activeGenerationId = generation.id;
			storedCampaign.updatedAt = now();
			generation.status = "planning";
			generation.startedAt = now();
			state.generations.push(generation);
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					generationId,
					type: "generation.created",
					summary: `Generation ${generation.index} pinned to ${baseCommit.slice(0, 12)}`,
					actor: "planner",
					refs: [generationId, baseCommit],
				}),
			);
		});
		this.changed();

		const runSignal = this.runController?.signal ?? new AbortController().signal;
		let baseWorktree: string | undefined;
		try {
			const generationWorktree = await createGenerationWorktree({
				repoRoot: this.repoRoot,
				generationId,
				baseCommit,
			});
			baseWorktree = generationWorktree;
			if (runSignal.aborted) {
				throw cancellationError("Research stopped before generation planning.");
			}
			const state = await this.store.read();
			const remaining =
				campaign.config.budget.maxExperiments -
				state.experiments.filter((experiment) => experiment.campaignId === campaign.id).length;
			const count = Math.max(1, Math.min(campaign.config.workers, remaining));
			const queuedNotes = state.operatorNotes.filter(
				(note) =>
					note.status === "queued" &&
					(note.campaignId === campaign.id || (campaign.missionId && note.missionId === campaign.missionId)),
			);
			const queuedRetries = state.retryQueue.filter(
				(retry) =>
					retry.campaignId === campaign.id &&
					retry.status === "queued" &&
					retry.attempt <= MAX_EXPERIMENT_ATTEMPTS,
			);
			const seeded: PlannedProposal[] = [];
			for (const note of queuedNotes) {
				if (!note.hypothesis || seeded.length >= count) {
					continue;
				}
				seeded.push({
					proposal: structuredClone(note.hypothesis),
					source: "human",
					attempt: 1,
					operatorNoteId: note.id,
				});
			}
			for (const retry of queuedRetries) {
				if (seeded.length >= count) {
					break;
				}
				seeded.push({
					proposal: structuredClone(retry.proposal),
					source: "worker",
					attempt: retry.attempt,
					retryOfExperimentId: retry.sourceExperimentId,
					retryId: retry.id,
				});
			}
			const plannerCount = count - seeded.length;
			const planningState = structuredClone(state);
			const guidanceNotes = queuedNotes.filter(
				(note) => !note.hypothesis && !seeded.some((proposal) => proposal.operatorNoteId === note.id),
			);
			if (plannerCount > 0 && guidanceNotes.length > 0) {
				planningState.reflections.push({
					id: `operator-guidance-${generation.id}`,
					campaignId: campaign.id,
					generationId: generation.id,
					summary: "The operator queued durable guidance for this generation.",
					lessons: guidanceNotes.slice(0, 20).map((note) => note.message.slice(0, 2_000)),
					deadEnds: [],
					nextFocus: guidanceNotes.slice(0, 20).map((note) => note.message.slice(0, 2_000)),
					createdAt: now(),
				});
			}
			const plan: Awaited<ReturnType<ResearchAgents["planGeneration"]>> =
				plannerCount > 0
					? await retryAgentOperation(runSignal, (attempt) =>
							this.runAgentCall(
								{
									campaign,
									generationId: generation.id,
									role: "planner",
									attempt,
									signal: runSignal,
								},
								(onUsage) =>
									this.agents.planGeneration({
										cwd: generationWorktree,
										state: planningState,
										campaign,
										generation,
										count: plannerCount,
										timeoutMs: campaign.config.agentTimeoutMs,
										signal: runSignal,
										onUsage,
									}),
							),
						)
					: { thesis: "Execute the operator and recovery queue.", ideas: [] };
			if (plan.provenance) {
				await this.store.update((draft) => {
					const storedGeneration = draft.generations.find((candidate) => candidate.id === generation.id);
					if (storedGeneration) {
						storedGeneration.planner = plan.provenance;
						storedGeneration.updatedAt = now();
					}
				});
			}
			const existingFingerprints = new Set(
				state.ideas.filter((idea) => idea.campaignId === campaign.id).map((idea) => idea.fingerprint),
			);
			const generationFingerprints = new Set<string>();
			const proposals: PlannedProposal[] = [];
			for (const planned of seeded) {
				const fingerprint = fingerprintIdea(planned.proposal);
				if (generationFingerprints.has(fingerprint)) {
					continue;
				}
				generationFingerprints.add(fingerprint);
				proposals.push(planned);
			}
			for (const proposal of plan.ideas) {
				const fingerprint = fingerprintIdea(proposal);
				if (existingFingerprints.has(fingerprint) || generationFingerprints.has(fingerprint)) {
					continue;
				}
				existingFingerprints.add(fingerprint);
				generationFingerprints.add(fingerprint);
				proposals.push({ proposal, source: "planner", attempt: 1 });
			}
			if (proposals.length === 0) {
				throw new Error("Planner proposed only duplicate experiments; the research frontier is exhausted.");
			}
			const consumedNoteIds = [
				...proposals.flatMap((proposal) => (proposal.operatorNoteId ? [proposal.operatorNoteId] : [])),
				...(plannerCount > 0 ? guidanceNotes.map((note) => note.id) : []),
			];
			const experiments = await this.persistPlan(campaign, generation, proposals, consumedNoteIds);
			const afterPlanning = await this.store.read();
			const currentCampaign = campaignFor(afterPlanning);
			if (currentCampaign.status === "pausing" || currentCampaign.status === "paused") {
				await this.cancelGeneration(generation.id, "Paused before experiment dispatch");
				await this.markPaused(campaign.id);
				return;
			}
			await this.provisionExperiments(
				experiments,
				proposals.map((proposal) => proposal.proposal),
			);
			if (runSignal.aborted) {
				throw cancellationError("Research stopped before experiment dispatch.");
			}
			await Promise.all(
				experiments.map(async (experiment) => {
					try {
						await this.executeExperiment(experiment);
					} catch (error) {
						await this.markInfrastructureFailure(experiment, errorMessage(error));
					}
				}),
			);
			const afterWorkers = await this.store.read();
			const campaignAfterWorkers = afterWorkers.campaigns.find((candidate) => candidate.id === campaign.id);
			if (!campaignAfterWorkers || campaignAfterWorkers.status === "stopped") {
				await this.cancelGeneration(generation.id, "Stopped before experiment verification");
				return;
			}
			await this.verifyAndSelect(campaign.id, generation.id);
			await this.reflectGeneration(campaign.id, generation.id, generationWorktree, runSignal);
		} catch (error) {
			const latest = await this.store.read();
			const latestCampaign = latest.campaigns.find((candidate) => candidate.id === campaign.id);
			if (latestCampaign?.status === "stopped") {
				await this.cancelGeneration(generation.id, "Research stopped during generation execution");
				return;
			}
			if (runSignal.aborted) {
				if (
					latest.experiments.some(
						(experiment) => experiment.generationId === generation.id && experiment.candidateCommit,
					)
				) {
					await this.preserveGenerationForResume(generation.id);
				} else {
					await this.cancelGeneration(generation.id, "Research stopped during generation execution");
				}
				return;
			}
			if (
				error instanceof EvaluatorIntegrityError ||
				error instanceof IncumbentInvalidError ||
				error instanceof PostFreezeEvaluationError
			) {
				throw error;
			}
			await this.store.update((state) => {
				const storedCampaign = state.campaigns.find((candidate) => candidate.id === campaign.id);
				const storedGeneration = state.generations.find((candidate) => candidate.id === generation.id);
				if (!storedCampaign || !storedGeneration) {
					return;
				}
				storedGeneration.status = "failed";
				storedGeneration.finishedAt = now();
				storedGeneration.updatedAt = now();
				if (!["pausing", "paused"].includes(storedCampaign.status)) {
					storedCampaign.status = "running";
				}
				storedCampaign.activeGenerationId = undefined;
				let terminalizedExperiments = 0;
				for (const storedExperiment of state.experiments.filter(
					(candidate) => candidate.generationId === generation.id && !isTerminalExperiment(candidate),
				)) {
					const phase: ExperimentFailure["phase"] =
						storedExperiment.status === "evaluating"
							? "evaluator"
							: storedExperiment.status === "agent-running"
								? "agent"
								: storedExperiment.status === "candidate-frozen"
									? "snapshot"
									: "workspace";
					const result = transitionExperimentToTerminal(state, storedExperiment, {
						status: "failed",
						failure: failure(phase, phase === "agent" ? "agent" : "infrastructure", errorMessage(error), true),
						ideaStatus: "failed",
						eventType: "experiment.failed",
						eventSummary: errorMessage(error),
					});
					if (result.transitioned) {
						terminalizedExperiments += 1;
					}
				}
				if (terminalizedExperiments === 0) {
					storedCampaign.failures += 1;
				}
				storedCampaign.updatedAt = now();
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: generation.id,
						type: "generation.failed",
						summary: errorMessage(error),
						actor: "system",
						refs: [generation.id],
					}),
				);
			});
			this.changed();
		} finally {
			if (baseWorktree) {
				await this.cleanupGeneration(generation.id, baseWorktree);
			}
		}
	}

	private async persistPlan(
		campaign: Campaign,
		generation: Generation,
		proposals: PlannedProposal[],
		consumedNoteIds: string[],
	): Promise<Experiment[]> {
		return this.store.update((state) => {
			const storedCampaign = state.campaigns.find((candidate) => candidate.id === campaign.id);
			const storedGeneration = state.generations.find((candidate) => candidate.id === generation.id);
			if (!storedCampaign || !storedGeneration) {
				throw new Error("Campaign or generation disappeared while persisting the plan.");
			}
			const timestamp = now();
			const experiments: Experiment[] = [];
			for (const planned of proposals) {
				const proposal = planned.proposal;
				const ideaId = makeId("idea");
				const experimentId = makeId("experiment");
				const idea: Idea = {
					id: ideaId,
					campaignId: campaign.id,
					generationId: generation.id,
					title: proposal.title,
					hypothesis: proposal.hypothesis,
					rationale: proposal.rationale,
					implementationPlan: proposal.implementationPlan,
					predictedEffect: proposal.predictedEffect,
					strategy: proposal.strategy,
					status: "queued",
					source: planned.source,
					parentIdeaIds: proposal.parentIdeaIds ?? [],
					fingerprint: fingerprintIdea(proposal),
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				const experiment: Experiment = {
					id: experimentId,
					campaignId: campaign.id,
					generationId: generation.id,
					ideaId,
					attempt: planned.attempt,
					retryOfExperimentId: planned.retryOfExperimentId,
					status: "created",
					baseCommit: generation.baseCommit,
					branch: `pending/${experimentId}`,
					worktree: join(isoWorktreeRoot(this.repoRoot), experimentId),
					changedPaths: [],
					createdAt: timestamp,
					updatedAt: timestamp,
				};
				state.ideas.push(idea);
				state.experiments.push(experiment);
				storedGeneration.ideaIds.push(ideaId);
				storedGeneration.experimentIds.push(experimentId);
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: generation.id,
						experimentId,
						type: "experiment.created",
						summary: `Experiment intent persisted: ${idea.title}`,
						actor: planned.source === "human" ? "human" : "planner",
						refs: [ideaId, experimentId],
					}),
				);
				experiments.push(structuredClone(experiment));
			}
			for (const note of state.operatorNotes) {
				if (consumedNoteIds.includes(note.id) && note.status === "queued") {
					note.status = "consumed";
					note.consumedAt = timestamp;
					note.consumedGenerationId = generation.id;
				}
			}
			for (const planned of proposals) {
				if (!planned.retryId) {
					continue;
				}
				const retry = state.retryQueue.find((candidate) => candidate.id === planned.retryId);
				if (retry && retry.status === "queued") {
					retry.status = "claimed";
					retry.claimedAt = timestamp;
					retry.claimedGenerationId = generation.id;
				}
			}
			storedGeneration.status = "executing";
			storedGeneration.updatedAt = timestamp;
			if (storedCampaign.status === "planning") {
				storedCampaign.status = "running";
			}
			storedCampaign.experimentsStarted += experiments.length;
			storedCampaign.updatedAt = timestamp;
			return experiments;
		});
	}

	private async provisionExperiments(
		experiments: Experiment[],
		proposals: Awaited<ReturnType<ResearchAgents["planGeneration"]>>["ideas"],
	): Promise<void> {
		for (let index = 0; index < experiments.length; index += 1) {
			if (this.runController?.signal.aborted) {
				throw cancellationError("Research stopped during experiment provisioning.");
			}
			const experiment = experiments[index];
			const git = await createExperimentWorktree({
				repoRoot: this.repoRoot,
				title: proposals[index].title,
				experimentId: experiment.id,
				baseCommit: experiment.baseCommit,
			});
			experiment.branch = git.branch;
			experiment.worktree = git.worktree;
			experiment.status = "workspace-ready";
			experiment.updatedAt = now();
			await this.store.update((state) => {
				const stored = state.experiments.find((candidate) => candidate.id === experiment.id);
				if (stored) {
					Object.assign(stored, experiment);
				}
			});
			if (this.runController?.signal.aborted) {
				throw cancellationError("Research stopped during experiment provisioning.");
			}
		}
		this.changed();
	}

	private async executeExperiment(experiment: Experiment): Promise<void> {
		const state = await this.store.read();
		const campaign = state.campaigns.find((candidate) => candidate.id === experiment.campaignId);
		const idea = state.ideas.find((candidate) => candidate.id === experiment.ideaId);
		if (!campaign || !idea) {
			throw new Error(`Missing campaign or idea for ${experiment.id}.`);
		}
		const workerId = makeId("worker");
		const controller = new AbortController();
		const runSignal = this.runController?.signal;
		const abortForRun = (): void => controller.abort();
		const active: ActiveExperiment = {
			controller,
			snapshot: {
				id: workerId,
				ideaId: idea.id,
				experimentId: experiment.id,
				generationId: experiment.generationId,
				label: idea.title,
				status: "agent-running",
				activity: "Reading experiment brief",
				startedAt: now(),
			},
		};
		if (runSignal?.aborted) {
			controller.abort();
		} else if (runSignal) {
			runSignal.addEventListener("abort", abortForRun, { once: true });
			active.detachRunAbort = () => runSignal.removeEventListener("abort", abortForRun);
		}
		this.activeExperiments.set(workerId, active);
		let outcome: WorkerOutcome | undefined;
		let currentPhase: ExperimentFailure["phase"] = "agent";
		try {
			const dispatched = await this.store.update((draft) => {
				const storedCampaign = draft.campaigns.find((candidate) => candidate.id === campaign.id);
				const storedIdea = draft.ideas.find((candidate) => candidate.id === idea.id);
				const stored = draft.experiments.find((candidate) => candidate.id === experiment.id);
				if (!storedCampaign || storedCampaign.status === "stopped" || !stored || isTerminalExperiment(stored)) {
					return false;
				}
				if (storedIdea) {
					storedIdea.status = "running";
					storedIdea.updatedAt = now();
				}
				stored.status = "agent-running";
				stored.workerId = workerId;
				stored.startedAt = now();
				stored.updatedAt = now();
				settleRetryClaim(draft, stored, "exhausted");
				return true;
			});
			if (!dispatched || controller.signal.aborted) {
				throw cancellationError("Experiment cancelled before worker dispatch.");
			}
			this.changed();
			let workerOutcome: WorkerOutcome;
			try {
				workerOutcome = await this.runAgentCall(
					{
						campaign,
						generationId: experiment.generationId,
						experimentId: experiment.id,
						ideaId: idea.id,
						role: "worker",
						attempt: experiment.attempt,
						signal: controller.signal,
					},
					(onUsage) =>
						this.agents.runExperiment({
							cwd: experiment.worktree,
							repoRoot: this.repoRoot,
							state,
							campaign,
							idea,
							timeoutMs: campaign.config.agentTimeoutMs,
							signal: controller.signal,
							callbacks: {
								onActivity: (activity) => {
									active.snapshot.activity = activity;
									this.changed();
								},
								onControl: (control) => {
									active.control = control;
								},
							},
							onUsage,
						}),
				);
			} finally {
				active.control = undefined;
			}
			outcome = workerOutcome;
			if (controller.signal.aborted) {
				throw new Error("Experiment cancelled by operator.");
			}
			currentPhase = "snapshot";
			active.snapshot.activity = "Freezing candidate commit";
			const snapshot = await snapshotExperiment({
				repoRoot: this.repoRoot,
				worktree: experiment.worktree,
				baseCommit: experiment.baseCommit,
				title: idea.title,
				protectedPaths: campaign.config.evaluator.protectedPaths,
			});
			if (controller.signal.aborted) {
				throw cancellationError("Experiment cancelled while freezing its candidate.");
			}
			await this.store.update((draft) => {
				const stored = draft.experiments.find((candidate) => candidate.id === experiment.id);
				if (!stored) {
					throw new Error(`Experiment ${experiment.id} disappeared while freezing candidate.`);
				}
				const storedCampaign = draft.campaigns.find((candidate) => candidate.id === campaign.id);
				if (storedCampaign?.status === "stopped" || stored.status === "cancelled") {
					throw cancellationError("Experiment cancelled before candidate persistence.");
				}
				stored.status = "candidate-frozen";
				stored.candidateCommit = snapshot.commit;
				stored.diffStat = snapshot.diffStat;
				stored.changedPaths = snapshot.changedPaths;
				stored.agent = workerOutcome.provenance;
				stored.assistantSummary = workerOutcome.assistantSummary;
				stored.updatedAt = now();
				draft.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: experiment.generationId,
						experimentId: experiment.id,
						type: "candidate.frozen",
						summary: `${idea.title}: ${snapshot.diffStat}`,
						actor: "worker",
						refs: [idea.id, experiment.id, snapshot.commit],
					}),
				);
			});
			active.snapshot.status = "candidate-frozen";
			active.snapshot.activity = "Waiting for serialized evaluation";
		} catch (error) {
			const cancelled = controller.signal.aborted || (error instanceof Error && error.name === "AbortError");
			const policyRejected = error instanceof CandidatePolicyError;
			const message = errorMessage(error);
			await this.store.update((draft) => {
				const stored = draft.experiments.find((candidate) => candidate.id === experiment.id);
				if (!stored || isTerminalExperiment(stored)) {
					return;
				}
				stored.agent = outcome?.provenance;
				stored.assistantSummary = outcome?.assistantSummary;
				transitionExperimentToTerminal(draft, stored, {
					status: cancelled ? "cancelled" : policyRejected ? "invalid" : "failed",
					failure: failure(
						policyRejected ? "policy" : currentPhase,
						cancelled
							? "cancelled"
							: policyRejected
								? "policy"
								: currentPhase === "agent"
									? "agent"
									: "infrastructure",
						message,
						!cancelled && !policyRejected,
					),
					ideaStatus: cancelled || policyRejected ? "rejected" : "failed",
					requeueClaimIfUnstarted: cancelled,
					eventType: cancelled
						? "experiment.cancelled"
						: policyRejected
							? "experiment.invalid"
							: "experiment.failed",
					eventSummary: `${idea.title}: ${message}`,
					eventRefs: [idea.id, experiment.id],
				});
			});
			this.releaseActive(workerId);
		}
		this.changed();
	}

	private async verifyAndSelect(campaignId: string, generationId: string): Promise<void> {
		let state = await this.store.read();
		const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
		const generation = state.generations.find((candidate) => candidate.id === generationId);
		if (!campaign || !generation) {
			throw new Error("Campaign or generation disappeared before verification.");
		}
		await this.store.update((draft) => {
			const storedGeneration = draft.generations.find((candidate) => candidate.id === generationId);
			if (storedGeneration) {
				storedGeneration.status = "verifying";
				storedGeneration.updatedAt = now();
			}
		});
		const candidates = state.experiments.filter(
			(experiment) => experiment.generationId === generationId && experiment.status === "candidate-frozen",
		);
		for (const experiment of candidates) {
			const active = [...this.activeExperiments.values()].find(
				(candidate) => candidate.snapshot.experimentId === experiment.id,
			);
			const signals = [active?.controller.signal, this.runController?.signal].filter(
				(signal): signal is AbortSignal => signal !== undefined,
			);
			const evaluationSignal =
				signals.length === 0 ? undefined : signals.length === 1 ? signals[0] : AbortSignal.any(signals);
			if (evaluationSignal?.aborted) {
				await this.markEvaluationFailure(experiment, "Experiment cancelled before evaluation.", true);
				continue;
			}
			if (active) {
				active.snapshot.status = "evaluating";
				active.snapshot.activity = "Running trusted evaluator";
			}
			await this.store.update((draft) => {
				const stored = draft.experiments.find((candidate) => candidate.id === experiment.id);
				if (stored) {
					stored.status = "evaluating";
					stored.updatedAt = now();
				}
			});
			try {
				if (!experiment.candidateCommit) {
					throw new Error("Candidate reached verification without a frozen commit.");
				}
				const plan = await this.ensurePairedEvaluationPlan(
					experiment.id,
					"screen",
					campaign.config.evaluator.samples,
				);
				const { incumbent, candidate: evaluation } = await this.evaluateFrozenPairReliably(
					campaign,
					experiment,
					generation.baseCommit,
					plan,
					evaluationSignal,
				);
				if (!incumbent.valid) {
					throw new IncumbentInvalidError(
						`Incumbent failed evaluator constraints: ${incumbent.failedConstraints.join(", ") || "valid=false"}`,
					);
				}
				await this.store.update((draft) => {
					const stored = draft.experiments.find((candidate) => candidate.id === experiment.id);
					if (stored) {
						stored.incumbentEvaluation = incumbent;
						stored.updatedAt = now();
					}
				});
				const improvement = improvementFor(campaign, evaluation.score.mean, incumbent.score.mean);
				const uncertainty = confidenceIntervalFor(evaluation, incumbent).uncertainty;
				const lowerBound = improvement - uncertainty;
				const screeningPassed =
					evaluation.valid &&
					experiment.changedPaths.length > 0 &&
					improvement > 0 &&
					lowerBound >= campaign.metric.minimumImprovement;
				const measurementPersisted = await this.store.update((draft) => {
					const stored = draft.experiments.find((candidate) => candidate.id === experiment.id);
					const idea = draft.ideas.find((candidate) => candidate.id === experiment.ideaId);
					const storedCampaign = draft.campaigns.find((candidate) => candidate.id === campaign.id);
					const storedGeneration = draft.generations.find((candidate) => candidate.id === generation.id);
					if (!stored || !idea || !storedCampaign || !storedGeneration) {
						throw new Error(`Experiment ${experiment.id} disappeared during evaluation.`);
					}
					if (
						storedCampaign.status === "stopped" ||
						storedGeneration.status === "cancelled" ||
						stored.status === "cancelled"
					) {
						return false;
					}
					stored.status = evaluation.valid ? "measured" : "invalid";
					stored.evaluation = evaluation;
					stored.improvement = improvement;
					stored.uncertainty = uncertainty;
					stored.screeningPassed = screeningPassed;
					stored.credibleImprovement = false;
					stored.rejectionReason = screeningPassed
						? undefined
						: !evaluation.valid
							? `Failed constraints: ${evaluation.failedConstraints.join(", ")}`
							: experiment.changedPaths.length === 0
								? "No code change"
								: `Lower confidence bound ${lowerBound} did not clear minimum improvement ${campaign.metric.minimumImprovement}`;
					stored.finishedAt = now();
					stored.updatedAt = now();
					idea.status = evaluation.valid ? "measured" : "rejected";
					idea.updatedAt = now();
					draft.events.push(
						createEvent({
							campaignId,
							generationId,
							experimentId: experiment.id,
							type: evaluation.valid ? "experiment.screened" : "experiment.invalid",
							summary: `${idea.title}: exploratory mean ${evaluation.score.mean}, Δ ${improvement}`,
							actor: "evaluator",
							refs: [idea.id, experiment.id],
							data: { screeningPassed, uncertainty, lowerBound },
						}),
					);
					return true;
				});
				if (!measurementPersisted) {
					break;
				}
			} catch (error) {
				if (error instanceof EvaluatorIntegrityError || error instanceof IncumbentInvalidError) {
					throw error;
				}
				if (error instanceof PostFreezeEvaluationError) {
					throw error;
				}
				const cancelled =
					evaluationSignal?.aborted === true || (error instanceof Error && error.name === "AbortError");
				await this.markEvaluationFailure(
					experiment,
					errorMessage(error),
					cancelled,
					error instanceof EvaluatorContractError,
				);
			} finally {
				if (active) {
					this.releaseActive(active.snapshot.id);
				}
				this.changed();
			}
		}

		state = await this.store.read();
		const campaignAfterEvaluation = state.campaigns.find((candidate) => candidate.id === campaignId);
		if (!campaignAfterEvaluation || campaignAfterEvaluation.status === "stopped") {
			await this.cancelGeneration(generationId, "Stopped during experiment verification");
			return;
		}
		const measured = state.experiments
			.filter(
				(experiment) =>
					experiment.generationId === generationId &&
					experiment.status === "measured" &&
					experiment.screeningPassed === true,
			)
			.sort((left, right) => {
				const leftLowerBound =
					(left.improvement ?? Number.NEGATIVE_INFINITY) - (left.uncertainty ?? Number.POSITIVE_INFINITY);
				const rightLowerBound =
					(right.improvement ?? Number.NEGATIVE_INFINITY) - (right.uncertainty ?? Number.POSITIVE_INFINITY);
				return rightLowerBound - leftLowerBound || left.id.localeCompare(right.id);
			});
		let selected: Experiment | undefined;
		const provisional = measured[0];
		if (
			provisional &&
			(await this.confirmCandidate(campaign, generation, provisional, 1, this.runController?.signal))
		) {
			selected = provisional;
		}
		await this.store.update((draft) => {
			const storedCampaign = draft.campaigns.find((candidate) => candidate.id === campaignId);
			const storedGeneration = draft.generations.find((candidate) => candidate.id === generationId);
			if (!storedCampaign || !storedGeneration) {
				throw new Error("Campaign or generation disappeared during selection.");
			}
			if (storedCampaign.status === "stopped" || storedGeneration.status === "cancelled") {
				storedGeneration.status = "cancelled";
				storedGeneration.finishedAt = now();
				storedGeneration.updatedAt = now();
				return;
			}
			if (selected) {
				const storedSelected = draft.experiments.find((candidate) => candidate.id === selected.id);
				const evidence = storedSelected?.confirmationHistory?.find((entry) => entry.confirmed);
				if (!storedSelected || !evidence) {
					throw new Error(`Confirmed experiment ${selected.id} lost its promotion evidence.`);
				}
				promoteConfirmedExperiment(draft, storedCampaign, storedGeneration, storedSelected, evidence);
			} else if (storedGeneration.status !== "reflecting") {
				storedGeneration.status = "reflecting";
				storedGeneration.selectedExperimentId = undefined;
				storedGeneration.updatedAt = now();
				storedCampaign.consecutivePlateaus += 1;
				if (
					!draft.events.some((event) => event.generationId === generationId && event.type === "generation.plateau")
				) {
					draft.events.push(
						createEvent({
							campaignId,
							generationId,
							type: "generation.plateau",
							summary: "No exploratory winner survived fresh post-selection confirmation",
							actor: "selector",
							refs: [generationId],
						}),
					);
				}
			}
			storedCampaign.updatedAt = now();
		});
	}

	private async markEvaluationFailure(
		experiment: Experiment,
		message: string,
		cancelled: boolean,
		contractInvalid = false,
	): Promise<void> {
		await this.store.update((state) => {
			const stored = state.experiments.find((candidate) => candidate.id === experiment.id);
			const campaign = state.campaigns.find((candidate) => candidate.id === experiment.campaignId);
			if (campaign?.status === "stopped" || !stored || isTerminalExperiment(stored)) {
				return;
			}
			if (cancelled && this.runController?.signal.aborted && stored.candidateCommit) {
				stored.status = "candidate-frozen";
				stored.workerId = undefined;
				stored.failure = undefined;
				stored.finishedAt = undefined;
				stored.updatedAt = now();
				state.events.push(
					createEvent({
						campaignId: stored.campaignId,
						generationId: stored.generationId,
						experimentId: stored.id,
						type: "evaluator.interrupted",
						summary: "Preserved the frozen candidate and paired plan for exact resumption",
						actor: "system",
						refs: [stored.id, stored.candidateCommit, stored.screeningPlan?.id ?? ""].filter(Boolean),
					}),
				);
				return;
			}
			transitionExperimentToTerminal(state, stored, {
				status: cancelled ? "cancelled" : contractInvalid ? "invalid" : "failed",
				failure: failure(
					"evaluator",
					cancelled ? "cancelled" : contractInvalid ? "invalid-result" : "infrastructure",
					message,
					false,
				),
				ideaStatus: cancelled || contractInvalid ? "rejected" : "failed",
				enqueueRetry: false,
				requeueClaimIfUnstarted: cancelled,
				eventType: cancelled ? "experiment.cancelled" : contractInvalid ? "experiment.invalid" : "evaluator.failed",
				eventSummary: message,
			});
		});
	}

	private async markInfrastructureFailure(experiment: Experiment, message: string): Promise<void> {
		for (const [workerId, active] of this.activeExperiments) {
			if (active.snapshot.experimentId === experiment.id) {
				this.releaseActive(workerId);
			}
		}
		await this.store.update((state) => {
			const stored = state.experiments.find((candidate) => candidate.id === experiment.id);
			if (!stored || isTerminalExperiment(stored)) {
				return;
			}
			transitionExperimentToTerminal(state, stored, {
				status: "failed",
				failure: failure("workspace", "infrastructure", message, true),
				ideaStatus: "failed",
				eventType: "experiment.failed",
				eventSummary: message,
			});
		});
		this.changed();
	}

	private async persistReflection(
		campaign: Campaign,
		generation: Generation,
		reflection: GenerationReflection,
	): Promise<void> {
		await this.store.update((state) => {
			const storedCampaign = state.campaigns.find((candidate) => candidate.id === campaign.id);
			const storedGeneration = state.generations.find((candidate) => candidate.id === generation.id);
			if (!storedCampaign || !storedGeneration) {
				throw new Error("Campaign or generation disappeared while persisting reflection.");
			}
			if (storedGeneration.status === "completed" && storedGeneration.reflectionId) {
				return;
			}
			if (storedCampaign.status === "stopped" || storedGeneration.status === "cancelled") {
				storedGeneration.status = "cancelled";
				storedGeneration.finishedAt = now();
				storedGeneration.updatedAt = now();
				return;
			}
			const record: Reflection = {
				id: makeId("reflection"),
				campaignId: campaign.id,
				generationId: generation.id,
				summary: reflection.summary,
				lessons: reflection.lessons,
				deadEnds: reflection.deadEnds,
				nextFocus: reflection.nextFocus,
				createdAt: now(),
			};
			state.reflections.push(record);
			storedGeneration.reflectionId = record.id;
			storedGeneration.critic = reflection.provenance;
			storedGeneration.status = "completed";
			storedGeneration.finishedAt = now();
			storedGeneration.updatedAt = now();
			storedCampaign.generationsCompleted += 1;
			storedCampaign.activeGenerationId = undefined;
			const criticStopReason = reflection.shouldStop ? (reflection.stopReason ?? reflection.summary) : undefined;
			if (criticStopReason) {
				storedCampaign.status = "completed";
				storedCampaign.runIntent = "idle";
				storedCampaign.stopReason = criticStopReason;
			} else if (storedCampaign.status === "pausing" || storedCampaign.status === "paused") {
				storedCampaign.status = "paused";
			} else {
				storedCampaign.status = "running";
				storedCampaign.stopReason = undefined;
			}
			storedCampaign.updatedAt = now();
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					generationId: generation.id,
					type: "generation.reflected",
					summary: reflection.summary,
					actor: "planner",
					refs: [generation.id, record.id],
				}),
			);
			if (reflection.shouldStop) {
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: generation.id,
						type: "critic.stop-accepted",
						summary: reflection.stopReason ?? reflection.summary,
						actor: "planner",
						refs: [generation.id, record.id],
					}),
				);
				finishMissionForCampaign(
					state,
					storedCampaign,
					"completed",
					criticStopReason ?? "Critic completed the campaign",
				);
			}
		});
		this.changed();
	}

	private async cleanupGeneration(generationId: string, baseWorktree: string): Promise<void> {
		const state = await this.store.read();
		const worktrees = state.experiments
			.filter((experiment) => experiment.generationId === generationId)
			.map((experiment) => experiment.worktree);
		for (const worktree of [...worktrees, baseWorktree]) {
			try {
				await removeWorktree(this.repoRoot, worktree);
			} catch (error) {
				const campaignId =
					state.generations.find((generation) => generation.id === generationId)?.campaignId ?? "unknown";
				await this.store.update((draft) => {
					draft.events.push(
						createEvent({
							campaignId,
							generationId,
							type: "worktree.cleanup-failed",
							summary: errorMessage(error),
							actor: "system",
							refs: [worktree],
						}),
					);
				});
			}
		}
	}

	private budgetStopReason(state: IsoState, campaign: Campaign): string | undefined {
		if (campaign.generationsCompleted >= campaign.config.budget.maxGenerations) {
			return `Generation budget reached (${campaign.config.budget.maxGenerations})`;
		}
		if (campaign.experimentsStarted >= campaign.config.budget.maxExperiments) {
			return `Experiment budget reached (${campaign.config.budget.maxExperiments})`;
		}
		if (campaign.failures >= campaign.config.budget.maxFailures) {
			return `Failure budget reached (${campaign.config.budget.maxFailures})`;
		}
		if (campaign.consecutivePlateaus >= campaign.config.budget.maxConsecutivePlateaus) {
			return `Research plateaued for ${campaign.consecutivePlateaus} generations`;
		}
		if (
			campaign.startedAt &&
			Date.now() - new Date(campaign.startedAt).getTime() >= campaign.config.budget.maxWallClockMs
		) {
			return "Wall-clock budget reached";
		}
		const usage = agentUsageFor(state, campaign.id);
		if (
			(campaign.config.budget.maxInputTokens !== undefined ||
				campaign.config.budget.maxOutputTokens !== undefined) &&
			usage.callsMissingTokenAccounting > 0
		) {
			return "Token budget accounting became unavailable; stopped at the generation boundary";
		}
		if (campaign.config.budget.maxCostUsd !== undefined && usage.callsMissingCostAccounting > 0) {
			return "Cost budget accounting became unavailable; stopped at the generation boundary";
		}
		if (
			campaign.config.budget.maxInputTokens !== undefined &&
			usage.inputTokens >= campaign.config.budget.maxInputTokens
		) {
			return `Input-token budget reached (${campaign.config.budget.maxInputTokens})`;
		}
		if (
			campaign.config.budget.maxOutputTokens !== undefined &&
			usage.outputTokens >= campaign.config.budget.maxOutputTokens
		) {
			return `Output-token budget reached (${campaign.config.budget.maxOutputTokens})`;
		}
		if (campaign.config.budget.maxCostUsd !== undefined && usage.costUsd >= campaign.config.budget.maxCostUsd) {
			return `Agent-cost budget reached ($${campaign.config.budget.maxCostUsd})`;
		}
		return undefined;
	}

	private async completeCampaign(campaignId: string, reason: string): Promise<void> {
		await this.store.update((state) => {
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
			if (!campaign || campaign.status === "stopped") {
				return;
			}
			campaign.status = "completed";
			campaign.runIntent = "idle";
			campaign.stopReason = reason;
			campaign.activeGenerationId = undefined;
			campaign.updatedAt = now();
			state.events.push(
				createEvent({
					campaignId,
					type: "campaign.completed",
					summary: reason,
					actor: "system",
					refs: [campaignId],
				}),
			);
			finishMissionForCampaign(state, campaign, "completed", reason);
		});
		this.changed();
	}

	private async preserveGenerationForResume(generationId: string): Promise<void> {
		await this.store.update((state) => {
			const generation = state.generations.find((candidate) => candidate.id === generationId);
			if (!generation || ["completed", "cancelled", "failed"].includes(generation.status)) {
				return;
			}
			const campaign = state.campaigns.find((candidate) => candidate.id === generation.campaignId);
			if (!campaign || campaign.status === "stopped") {
				return;
			}
			const frozen = state.experiments.filter(
				(experiment) => experiment.generationId === generationId && experiment.candidateCommit,
			);
			if (frozen.length === 0) {
				return;
			}
			for (const experiment of frozen) {
				if (experiment.status === "evaluating") {
					experiment.status = "candidate-frozen";
				}
				experiment.workerId = undefined;
				if (!isTerminalExperiment(experiment)) {
					experiment.failure = undefined;
					experiment.finishedAt = undefined;
				}
				experiment.updatedAt = now();
			}
			if (generation.status !== "reflecting") {
				generation.status = "verifying";
			}
			generation.finishedAt = undefined;
			generation.updatedAt = now();
			campaign.activeGenerationId = generation.id;
			campaign.status = campaign.runIntent === "paused" ? "pausing" : "ready";
			campaign.updatedAt = now();
			if (
				!state.events.some(
					(event) => event.generationId === generation.id && event.type === "generation.resume-preserved",
				)
			) {
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						generationId: generation.id,
						type: "generation.resume-preserved",
						summary: "Preserved frozen candidates and paired plans for exact resumption",
						actor: "system",
						refs: [generation.id, ...frozen.map((experiment) => experiment.id)],
					}),
				);
			}
		});
	}

	private async cancelGeneration(generationId: string, reason: string): Promise<void> {
		await this.store.update((state) => {
			const generation = state.generations.find((candidate) => candidate.id === generationId);
			if (generation) {
				generation.status = "cancelled";
				generation.finishedAt = now();
				generation.updatedAt = now();
				state.events.push(
					createEvent({
						campaignId: generation.campaignId,
						generationId,
						type: "generation.cancelled",
						summary: reason,
						actor: "system",
						refs: [generationId],
					}),
				);
				for (const experiment of state.experiments.filter(
					(candidate) => candidate.generationId === generationId && !isTerminalExperiment(candidate),
				)) {
					transitionExperimentToTerminal(state, experiment, {
						status: "cancelled",
						failure: failure("selection", "cancelled", reason, false),
						ideaStatus: "rejected",
						countFailure: false,
						requeueClaimIfUnstarted: true,
					});
				}
			}
		});
	}

	private async markPaused(campaignId: string): Promise<void> {
		await this.store.update((state) => {
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
			if (campaign && campaign.status !== "stopped" && campaign.runIntent === "paused") {
				campaign.status = "paused";
				const activeGeneration = campaign.activeGenerationId
					? state.generations.find((generation) => generation.id === campaign.activeGenerationId)
					: undefined;
				if (!activeGeneration || ["completed", "cancelled", "failed"].includes(activeGeneration.status)) {
					campaign.activeGenerationId = undefined;
				}
				campaign.updatedAt = now();
				const mission = campaign.missionId
					? state.missions.find((candidate) => candidate.id === campaign.missionId)
					: undefined;
				if (mission) {
					mission.desiredState = "paused";
					mission.phase = "paused";
					mission.updatedAt = now();
				}
			}
		});
	}

	private async markReadyForRestart(campaignId: string): Promise<void> {
		await this.store.update((state) => {
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
			if (
				!campaign ||
				campaign.runIntent !== "running" ||
				["completed", "stopped", "failed"].includes(campaign.status)
			) {
				return;
			}
			campaign.status = "ready";
			const activeGeneration = campaign.activeGenerationId
				? state.generations.find((generation) => generation.id === campaign.activeGenerationId)
				: undefined;
			if (!activeGeneration || ["completed", "cancelled", "failed"].includes(activeGeneration.status)) {
				campaign.activeGenerationId = undefined;
			}
			campaign.stopReason = "Kernel quiesced; research will resume automatically";
			campaign.updatedAt = now();
			state.events.push(
				createEvent({
					campaignId,
					type: "research.quiesced",
					summary: campaign.stopReason,
					actor: "system",
					refs: [campaignId],
				}),
			);
		});
	}

	private async settleQuiescedCampaign(campaignId: string): Promise<void> {
		const campaign = (await this.store.read()).campaigns.find((candidate) => candidate.id === campaignId);
		if (campaign?.runIntent === "running") {
			await this.markReadyForRestart(campaignId);
		} else if (campaign?.runIntent === "paused") {
			await this.markPaused(campaignId);
		}
	}

	private async failCampaign(error: unknown, campaignId: string): Promise<void> {
		const message = errorMessage(error);
		await this.store.update((state) => {
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
			if (!campaign || campaign.status === "stopped") {
				return;
			}
			campaign.status = "failed";
			campaign.runIntent = "idle";
			campaign.stopReason = message;
			const activeGenerationId = campaign.activeGenerationId;
			campaign.activeGenerationId = undefined;
			campaign.updatedAt = now();
			if (activeGenerationId) {
				const generation = state.generations.find((candidate) => candidate.id === activeGenerationId);
				if (generation && !["completed", "cancelled", "failed"].includes(generation.status)) {
					generation.status = "failed";
					generation.finishedAt = now();
					generation.updatedAt = now();
				}
				for (const experiment of state.experiments.filter(
					(candidate) => candidate.generationId === activeGenerationId && !isTerminalExperiment(candidate),
				)) {
					const interruptedStatus = experiment.status;
					transitionExperimentToTerminal(state, experiment, {
						status: "interrupted",
						failure: failure(
							interruptedStatus === "evaluating" ? "evaluator" : "agent",
							"infrastructure",
							message,
							true,
						),
						ideaStatus: "failed",
						countFailure: false,
						enqueueRetry: false,
					});
				}
			}
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					type: "campaign.failed",
					summary: message,
					actor: "system",
					refs: [campaign.id],
				}),
			);
			finishMissionForCampaign(state, campaign, "failed", message);
		});
		this.changed();
	}

	private stopLease(): void {
		if (this.leaseTimer) {
			clearInterval(this.leaseTimer);
			this.leaseTimer = undefined;
		}
		this.store.releaseLease(ORCHESTRATOR_LEASE, this.ownerId);
		this.runController = undefined;
	}
}
