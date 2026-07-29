import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import {
	ControlConflictError,
	type ControlTarget,
	controlTargetForEntities,
	isTerminalMission,
	type ResearchControlAction,
	type ResearchControlRequest,
} from "./control.ts";
import { buildIdeaGraph } from "./graph.ts";
import type { IsoRuntime } from "./runtime.ts";
import type { PostSelectionEvidence } from "./selection.ts";
import { IdempotencyConflictError } from "./store.ts";
import type {
	AgentProvenance,
	Campaign,
	CampaignCompletionReport,
	ChampionHandoff,
	ConfirmationEvidence,
	DashboardSnapshot,
	EvaluationAggregate,
	Experiment,
	Generation,
	Idea,
	IsoEvent,
	IsoState,
	MaterialUpdate,
	OperatorNote,
	PairedEvaluationPlan,
	ProposedIdea,
	Reflection,
	ResearchMission,
	RuntimeProvenance,
	StatisticSummary,
	WorkerSnapshot,
} from "./types.ts";

const MAX_DASHBOARD_EXPERIMENTS = 120;
const MAX_DASHBOARD_GENERATIONS = 40;
const MAX_DASHBOARD_IDEAS = 160;
const MAX_DASHBOARD_ID_REFS = 200;
const MAX_DASHBOARD_EVENTS = 300;
const MAX_DASHBOARD_REFLECTIONS = 40;
const MAX_DASHBOARD_WORKERS = 64;
const MAX_EVALUATION_SAMPLES = 0;
const MAX_CONSTRAINTS = 20;
const MAX_CONFIRMATION_HISTORY = 20;
const MAX_SELECTION_ASSUMPTIONS = 12;
const MAX_MISSION_DIAGNOSTICS = 20;
const MAX_OPERATOR_NOTES = 40;
const MAX_MATERIAL_UPDATES = 60;
const MAX_EVENT_CLIENTS = 8;
const MAX_ACTION_RECEIPTS = 1_000;

export const ISO_RELAY_READ_HEADER = "x-iso-relay-read-token";
export const ISO_RELAY_CONTROL_HEADER = "x-iso-relay-control-token";

export interface TrustedRelayOptions {
	/**
	 * Secrets injected by an authenticated same-origin relay. They are never
	 * serialized into the dashboard HTML or returned by this server.
	 */
	readToken: string;
	controlToken: string;
	/** Exact public hostnames the authenticated relay is allowed to use. */
	allowedHosts: string[];
}

export interface ServeOptions {
	host: string;
	port: number;
	startResearch?: boolean;
	trustedRelay?: TrustedRelayOptions;
	/**
	 * Production kernels use this to serialize the complete durable receipt,
	 * target precondition, and runtime mutation in their single mutation queue.
	 */
	mutationExecutor?: <T>(operation: () => Promise<T>) => Promise<T>;
}

export interface DashboardServer {
	url: string;
	host: string;
	port: number;
	/** Present only for the loopback-local control bootstrap. */
	token?: string;
	close(): Promise<void>;
}

interface DashboardEvaluation extends EvaluationAggregate {
	sampleCount: number;
	metricCount: number;
}

interface DashboardEvaluationPlan extends PairedEvaluationPlan {
	trialIds: [];
	trialCount: number;
}

interface DashboardGeneration extends Generation {
	ideaCount: number;
	experimentCount: number;
}

interface DashboardCounts {
	generations: number;
	ideas: number;
	experiments: number;
	reflections: number;
	events: number;
	workers: number;
	graphNodes: number;
	graphEdges: number;
	missions: number;
	operatorNotes: number;
	retryQueue: number;
	materialUpdates: number;
}

interface DashboardProjection {
	state: IsoState;
	graph: DashboardSnapshot["graph"];
	workers: WorkerSnapshot[];
	activeCampaign?: Campaign;
	activeMission?: ResearchMission;
	control?: ControlTarget;
	kernel: DashboardSnapshot["kernel"];
	window: {
		totals: DashboardCounts;
		shown: DashboardCounts;
		limits: {
			generations: number;
			ideas: number;
			experiments: number;
			reflections: number;
			events: number;
			workers: number;
			evaluationSamples: number;
		};
	};
}

interface MutationEnvelope {
	targetKind: ControlTarget["kind"];
	targetId: string;
	expectedControlFingerprint: string;
	actionId: string;
}

interface ActionResult {
	status: number;
	value: Record<string, unknown>;
}

interface ActionReceipt {
	targetKind: ControlTarget["kind"];
	targetId: string;
	path: string;
	actionFingerprint: string;
	result: ActionResult;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
		"x-content-type-options": "nosniff",
	});
	response.end(`${JSON.stringify(value)}\n`);
}

function boundedText(value: string, limit: number): string {
	return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ").slice(0, limit);
}

function safeOperationalText(value: string, limit: number): string {
	const scrubbed = value
		.replace(/\bsk[-_][a-zA-Z0-9_-]{12,}\b/gu, "[credential]")
		.replace(/\b(?:ghp|gho|github_pat)_[a-zA-Z0-9_-]{12,}\b/gu, "[credential]")
		.replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, "[credential]")
		.replace(/\bAIza[a-zA-Z0-9_-]{20,}\b/gu, "[credential]")
		.replace(/\bxox[baprs]-[a-zA-Z0-9-]{12,}\b/gu, "[credential]")
		.replace(/\bnpm_[a-zA-Z0-9]{20,}\b/gu, "[credential]")
		.replace(/\bBearer\s+[a-zA-Z0-9._~+/-]{12,}=*/giu, "Bearer [credential]")
		.replace(
			/\b[a-zA-Z0-9_]*(?:api[_-]?key|access[_-]?token|auth[_-]?token|secret|password)\s*[:=]\s*["']?[^\s"',;]{8,}/giu,
			"[credential assignment]",
		)
		.replace(/https?:\/\/[^/\s:@]+:[^/\s@]+@/giu, "https://[credential]@")
		.replace(/(?:\/(?:Users|home|private|tmp|var)\/[^\s"'`]+)/gu, "[local path]")
		.replace(/[a-zA-Z]:\\[^\s"'`]+/gu, "[local path]");
	return boundedText(scrubbed, limit);
}

function compactStatistics(summary: StatisticSummary): StatisticSummary {
	return {
		mean: summary.mean,
		median: summary.median,
		stddev: summary.stddev,
		min: summary.min,
		max: summary.max,
	};
}

function compactEvaluation(evaluation: EvaluationAggregate | undefined): DashboardEvaluation | undefined {
	if (!evaluation) {
		return undefined;
	}
	return {
		score: compactStatistics(evaluation.score),
		metrics: {},
		samples: [],
		valid: evaluation.valid,
		failedConstraints: evaluation.failedConstraints
			.slice(0, MAX_CONSTRAINTS)
			.map((value) => safeOperationalText(value, 500)),
		measuredAt: evaluation.measuredAt,
		sampleCount: evaluation.samples.length,
		metricCount: Object.keys(evaluation.metrics).length,
	};
}

function compactExperiment(experiment: Experiment): Experiment {
	return {
		id: experiment.id,
		campaignId: experiment.campaignId,
		generationId: experiment.generationId,
		ideaId: experiment.ideaId,
		attempt: experiment.attempt,
		retryOfExperimentId: experiment.retryOfExperimentId,
		status: experiment.status,
		baseCommit: experiment.baseCommit,
		branch: boundedText(experiment.branch, 500),
		worktree: "",
		workerId: experiment.workerId,
		candidateCommit: experiment.candidateCommit,
		diffStat: undefined,
		changedPaths: [],
		evaluation: compactEvaluation(experiment.evaluation),
		incumbentEvaluation: compactEvaluation(experiment.incumbentEvaluation),
		improvement: experiment.improvement,
		uncertainty: experiment.uncertainty,
		confirmationEvaluation: compactEvaluation(experiment.confirmationEvaluation),
		confirmationIncumbentEvaluation: compactEvaluation(experiment.confirmationIncumbentEvaluation),
		confirmationImprovement: experiment.confirmationImprovement,
		confirmationUncertainty: experiment.confirmationUncertainty,
		confirmationRoundsPassed: experiment.confirmationRoundsPassed,
		confirmationHistory: experiment.confirmationHistory
			?.slice(-MAX_CONFIRMATION_HISTORY)
			.map(compactConfirmationEvidence),
		screeningPlan: compactEvaluationPlan(experiment.screeningPlan),
		confirmationPlan: compactEvaluationPlan(experiment.confirmationPlan),
		screeningPassed: experiment.screeningPassed,
		credibleImprovement: experiment.credibleImprovement,
		rejectionReason: experiment.rejectionReason ? safeOperationalText(experiment.rejectionReason, 2_000) : undefined,
		failure: experiment.failure
			? {
					phase: experiment.failure.phase,
					kind: experiment.failure.kind,
					message: safeOperationalText(experiment.failure.message, 2_000),
					retryable: experiment.failure.retryable,
				}
			: undefined,
		agent: compactAgentProvenance(experiment.agent),
		assistantSummary: experiment.assistantSummary
			? safeOperationalText(experiment.assistantSummary, 2_000)
			: undefined,
		startedAt: experiment.startedAt,
		finishedAt: experiment.finishedAt,
		createdAt: experiment.createdAt,
		updatedAt: experiment.updatedAt,
	};
}

function compactEvaluationPlan(plan: PairedEvaluationPlan | undefined): DashboardEvaluationPlan | undefined {
	if (!plan) {
		return undefined;
	}
	return {
		id: safeOperationalText(plan.id, 500),
		kind: plan.kind,
		trialIds: [],
		trialCount: plan.trialIds.length,
		startsWithCandidate: plan.startsWithCandidate,
		opportunityIndex: plan.opportunityIndex,
		createdAt: plan.createdAt,
	};
}

function compactPostSelectionEvidence(evidence: Readonly<PostSelectionEvidence>): Readonly<PostSelectionEvidence> {
	return {
		method: evidence.method,
		claimClass: evidence.claimClass,
		familyWiseAlpha: evidence.familyWiseAlpha,
		adjustedAlpha: evidence.adjustedAlpha,
		maxOpportunities: evidence.maxOpportunities,
		opportunityIndex: evidence.opportunityIndex,
		sampleCount: evidence.sampleCount,
		uncertainty: evidence.uncertainty,
		lowerBound: evidence.lowerBound,
		improvement: evidence.improvement,
		threshold: evidence.threshold,
		promoted: evidence.promoted,
		assumptions: evidence.assumptions
			.slice(0, MAX_SELECTION_ASSUMPTIONS)
			.map((assumption) => safeOperationalText(assumption, 1_000)),
	};
}

function compactConfirmationEvidence(evidence: ConfirmationEvidence): ConfirmationEvidence {
	return {
		round: evidence.round,
		candidateMean: evidence.candidateMean,
		incumbentMean: evidence.incumbentMean,
		improvement: evidence.improvement,
		uncertainty: evidence.uncertainty,
		lowerBound: evidence.lowerBound,
		confirmed: evidence.confirmed,
		measuredAt: evidence.measuredAt,
		interval: evidence.interval
			? {
					method: evidence.interval.method,
					df: evidence.interval.df,
					alpha: evidence.interval.alpha,
					criticalValue: evidence.interval.criticalValue,
					uncertainty: evidence.interval.uncertainty,
					lowerBound: evidence.interval.lowerBound,
				}
			: undefined,
		selection: evidence.selection ? compactPostSelectionEvidence(evidence.selection) : undefined,
	};
}

function compactAgentProvenance(provenance: AgentProvenance | undefined): AgentProvenance | undefined {
	if (!provenance) {
		return undefined;
	}
	return {
		provider: provenance.provider ? boundedText(provenance.provider, 200) : undefined,
		model: provenance.model ? boundedText(provenance.model, 300) : undefined,
		thinkingLevel: provenance.thinkingLevel ? boundedText(provenance.thinkingLevel, 100) : undefined,
		inputTokens: provenance.inputTokens,
		outputTokens: provenance.outputTokens,
		cost: provenance.cost,
	};
}

function compactRuntimeProvenance(provenance: RuntimeProvenance | undefined): RuntimeProvenance | undefined {
	if (!provenance) {
		return undefined;
	}
	return {
		isoVersion: boundedText(provenance.isoVersion, 100),
		nodeVersion: boundedText(provenance.nodeVersion, 100),
		platform: boundedText(provenance.platform, 100),
		architecture: boundedText(provenance.architecture, 100),
		sandboxRuntimeVersion: boundedText(provenance.sandboxRuntimeVersion, 100),
		piCodingAgentVersion: boundedText(provenance.piCodingAgentVersion, 100),
		artifactDigest: provenance.artifactDigest,
		evaluatorContract: provenance.evaluatorContract,
		selectionMethod: provenance.selectionMethod,
	};
}

function compactChampionHandoff(handoff: ChampionHandoff | undefined): ChampionHandoff | undefined {
	if (!handoff) {
		return undefined;
	}
	return {
		campaignId: handoff.campaignId,
		experimentId: handoff.experimentId,
		ideaId: handoff.ideaId,
		sourceCommit: handoff.sourceCommit,
		candidateCommit: handoff.candidateCommit,
		diffStat: handoff.diffStat ? safeOperationalText(handoff.diffStat, 4_000) : undefined,
		changedPaths: handoff.changedPaths.slice(0, 100).map((path) => safeOperationalText(path, 1_024)),
		baselineScore: handoff.baselineScore,
		championScore: handoff.championScore,
		cumulativeImprovement: handoff.cumulativeImprovement,
		cumulativeUncertainty: handoff.cumulativeUncertainty,
		stepImprovement: handoff.stepImprovement,
		stepUncertainty: handoff.stepUncertainty,
		improvement: handoff.improvement,
		uncertainty: handoff.uncertainty,
		confirmationRoundsPassed: handoff.confirmationRoundsPassed,
		applyPrecondition: {
			expectedHead: handoff.applyPrecondition.expectedHead,
			requiresCleanWorktree: true,
			requiresDirtySourceReconciliation: handoff.applyPrecondition.requiresDirtySourceReconciliation,
			sourceSnapshotPaths: handoff.applyPrecondition.sourceSnapshotPaths
				.slice(0, 100)
				.map((path) => safeOperationalText(path, 1_024)),
		},
	};
}

function compactCompletionReport(report: CampaignCompletionReport | undefined): CampaignCompletionReport | undefined {
	if (!report) {
		return undefined;
	}
	return {
		campaignId: report.campaignId,
		missionId: report.missionId,
		outcome: report.outcome,
		reason: safeOperationalText(report.reason, 4_000),
		goal: safeOperationalText(report.goal, 4_000),
		metric: {
			name: safeOperationalText(report.metric.name, 300),
			direction: report.metric.direction,
			minimumImprovement: report.metric.minimumImprovement,
		},
		baselineScore: report.baselineScore,
		champion: compactChampionHandoff(report.champion),
		generationsCompleted: report.generationsCompleted,
		experimentsStarted: report.experimentsStarted,
		measuredExperiments: report.measuredExperiments,
		failures: report.failures,
		agentUsage: { ...report.agentUsage },
		keyFindings: report.keyFindings.slice(0, 20).map((finding) => safeOperationalText(finding, 2_000)),
		generatedAt: report.generatedAt,
	};
}

function compactProposedIdea(idea: ProposedIdea | undefined): ProposedIdea | undefined {
	if (!idea) {
		return undefined;
	}
	return {
		title: safeOperationalText(idea.title, 500),
		hypothesis: safeOperationalText(idea.hypothesis, 2_000),
		rationale: safeOperationalText(idea.rationale, 2_000),
		implementationPlan: safeOperationalText(idea.implementationPlan, 2_000),
		predictedEffect: safeOperationalText(idea.predictedEffect, 1_000),
		strategy: idea.strategy,
		parentIdeaIds: idea.parentIdeaIds?.slice(0, MAX_DASHBOARD_ID_REFS),
	};
}

function compactOperatorNote(note: OperatorNote): OperatorNote {
	return {
		id: note.id,
		missionId: note.missionId,
		campaignId: note.campaignId,
		message: safeOperationalText(note.message, 4_000),
		hypothesis: compactProposedIdea(note.hypothesis),
		status: note.status,
		createdAt: note.createdAt,
		consumedAt: note.consumedAt,
		consumedGenerationId: note.consumedGenerationId,
	};
}

function compactMaterialUpdate(update: MaterialUpdate): MaterialUpdate {
	return {
		sequence: update.sequence,
		missionId: update.missionId,
		campaignId: update.campaignId,
		kind: update.kind,
		summary: safeOperationalText(update.summary, 2_000),
		at: update.at,
		refs: update.refs.slice(0, 20).map((reference) => boundedText(reference, 500)),
	};
}

function compactMission(mission: ResearchMission): ResearchMission {
	return {
		id: mission.id,
		input: {
			goal: safeOperationalText(mission.input.goal, 4_000),
			metric: {
				name: safeOperationalText(mission.input.metric.name, 300),
				direction: mission.input.metric.direction,
				minimumImprovement: mission.input.metric.minimumImprovement,
			},
			config: {
				workers: mission.input.config.workers,
				agentTimeoutMs: mission.input.config.agentTimeoutMs,
				evaluator: {
					command: "[configured locally]",
					controlCwd: "[local control directory]",
					samples: mission.input.config.evaluator.samples,
					warmups: mission.input.config.evaluator.warmups,
					timeoutMs: mission.input.config.evaluator.timeoutMs,
					protectedPaths: [],
					scoreBounds: mission.input.config.evaluator.scoreBounds
						? { ...mission.input.config.evaluator.scoreBounds }
						: undefined,
				},
				budget: { ...mission.input.config.budget },
			},
			sourceCommit: mission.input.sourceCommit,
			sourceHeadCommit: mission.input.sourceHeadCommit,
			sourceSnapshotRef: mission.input.sourceSnapshotRef,
			sourceHadLocalChanges: mission.input.sourceHadLocalChanges,
			sourceSnapshotPaths: [],
			dependencyDigest: mission.input.dependencyDigest,
		},
		desiredState: mission.desiredState,
		phase: mission.phase,
		campaignId: mission.campaignId,
		diagnostics: mission.diagnostics.slice(-MAX_MISSION_DIAGNOSTICS).map((diagnostic) => ({
			...diagnostic,
			code: boundedText(diagnostic.code, 300),
			message: safeOperationalText(diagnostic.message, 2_000),
		})),
		completionReport: compactCompletionReport(mission.completionReport),
		notificationCursor: mission.notificationCursor,
		createdAt: mission.createdAt,
		updatedAt: mission.updatedAt,
		startedAt: mission.startedAt,
		completedAt: mission.completedAt,
	};
}

function compactCampaign(campaign: Campaign): Campaign {
	const baselineEvaluation = compactEvaluation(campaign.baseline.evaluation);
	if (!baselineEvaluation) {
		throw new Error("Campaign baseline evaluation is unavailable.");
	}
	return {
		id: campaign.id,
		missionId: campaign.missionId,
		goal: safeOperationalText(campaign.goal, 4_000),
		metric: {
			name: safeOperationalText(campaign.metric.name, 300),
			direction: campaign.metric.direction,
			minimumImprovement: campaign.metric.minimumImprovement,
		},
		config: {
			workers: campaign.config.workers,
			agentTimeoutMs: campaign.config.agentTimeoutMs,
			evaluator: {
				command: "[configured locally]",
				controlCwd: "[local control directory]",
				samples: campaign.config.evaluator.samples,
				warmups: campaign.config.evaluator.warmups,
				timeoutMs: campaign.config.evaluator.timeoutMs,
				protectedPaths: [],
				scoreBounds: campaign.config.evaluator.scoreBounds
					? { ...campaign.config.evaluator.scoreBounds }
					: undefined,
			},
			budget: {
				maxGenerations: campaign.config.budget.maxGenerations,
				maxExperiments: campaign.config.budget.maxExperiments,
				maxWallClockMs: campaign.config.budget.maxWallClockMs,
				maxConsecutivePlateaus: campaign.config.budget.maxConsecutivePlateaus,
				maxFailures: campaign.config.budget.maxFailures,
				maxInputTokens: campaign.config.budget.maxInputTokens,
				maxOutputTokens: campaign.config.budget.maxOutputTokens,
				maxCostUsd: campaign.config.budget.maxCostUsd,
			},
		},
		status: campaign.status,
		runIntent: campaign.runIntent,
		sourceCommit: campaign.sourceCommit,
		sourceHeadCommit: campaign.sourceHeadCommit,
		sourceSnapshotRef: campaign.sourceSnapshotRef,
		sourceHadLocalChanges: campaign.sourceHadLocalChanges,
		sourceSnapshotPaths: [],
		dependencyDigest: campaign.dependencyDigest,
		evaluatorDigest: campaign.evaluatorDigest,
		runtimeProvenance: compactRuntimeProvenance(campaign.runtimeProvenance),
		baseline: {
			commit: campaign.baseline.commit,
			evaluatorDigest: campaign.baseline.evaluatorDigest,
			resultSchemaDigest: campaign.baseline.resultSchemaDigest,
			evaluation: baselineEvaluation,
		},
		championExperimentId: campaign.championExperimentId,
		activeGenerationId: campaign.activeGenerationId,
		generationsCompleted: campaign.generationsCompleted,
		experimentsStarted: campaign.experimentsStarted,
		failures: campaign.failures,
		consecutivePlateaus: campaign.consecutivePlateaus,
		startedAt: campaign.startedAt,
		stopReason: campaign.stopReason ? safeOperationalText(campaign.stopReason, 2_000) : undefined,
		completionReport: compactCompletionReport(campaign.completionReport),
		createdAt: campaign.createdAt,
		updatedAt: campaign.updatedAt,
	};
}

function compactGeneration(generation: Generation): DashboardGeneration {
	return {
		id: generation.id,
		campaignId: generation.campaignId,
		index: generation.index,
		status: generation.status,
		baseCommit: generation.baseCommit,
		ideaIds: generation.ideaIds.slice(-MAX_DASHBOARD_ID_REFS),
		experimentIds: generation.experimentIds.slice(-MAX_DASHBOARD_ID_REFS),
		selectedExperimentId: generation.selectedExperimentId,
		reflectionId: generation.reflectionId,
		planner: compactAgentProvenance(generation.planner),
		critic: compactAgentProvenance(generation.critic),
		startedAt: generation.startedAt,
		finishedAt: generation.finishedAt,
		createdAt: generation.createdAt,
		updatedAt: generation.updatedAt,
		ideaCount: generation.ideaIds.length,
		experimentCount: generation.experimentIds.length,
	};
}

function compactIdea(idea: Idea): Idea {
	return {
		id: idea.id,
		campaignId: idea.campaignId,
		generationId: idea.generationId,
		title: safeOperationalText(idea.title, 500),
		hypothesis: safeOperationalText(idea.hypothesis, 2_000),
		rationale: safeOperationalText(idea.rationale, 2_000),
		implementationPlan: safeOperationalText(idea.implementationPlan, 2_000),
		predictedEffect: safeOperationalText(idea.predictedEffect, 1_000),
		strategy: idea.strategy,
		status: idea.status,
		source: idea.source,
		parentIdeaIds: idea.parentIdeaIds.slice(0, MAX_DASHBOARD_ID_REFS),
		fingerprint: idea.fingerprint,
		createdAt: idea.createdAt,
		updatedAt: idea.updatedAt,
	};
}

function compactReflection(reflection: Reflection): Reflection {
	return {
		id: reflection.id,
		campaignId: reflection.campaignId,
		generationId: reflection.generationId,
		summary: safeOperationalText(reflection.summary, 2_000),
		lessons: reflection.lessons.slice(0, 50).map((value) => safeOperationalText(value, 1_000)),
		deadEnds: reflection.deadEnds.slice(0, 50).map((value) => safeOperationalText(value, 1_000)),
		nextFocus: reflection.nextFocus.slice(0, 50).map((value) => safeOperationalText(value, 1_000)),
		createdAt: reflection.createdAt,
	};
}

function compactEvent(event: IsoEvent): IsoEvent {
	return {
		id: event.id,
		sequence: event.sequence,
		campaignId: event.campaignId,
		generationId: event.generationId,
		experimentId: event.experimentId,
		type: boundedText(event.type, 300),
		summary: safeOperationalText(event.summary, 2_000),
		actor: event.actor,
		at: event.at,
		refs: event.refs.slice(0, 50).map((value) => safeOperationalText(value, 500)),
	};
}

function compactWorker(worker: WorkerSnapshot): WorkerSnapshot {
	return {
		id: worker.id,
		ideaId: worker.ideaId,
		experimentId: worker.experimentId,
		generationId: worker.generationId,
		label: safeOperationalText(worker.label, 500),
		status: worker.status,
		activity: safeOperationalText(worker.activity, 1_000),
		startedAt: worker.startedAt,
	};
}

function selectRecentWithPins<T>(values: T[], maximum: number, pinnedIds: string[], idFor: (value: T) => string): T[] {
	const byId = new Map(values.map((value) => [idFor(value), value]));
	const selectedIds = new Set<string>();
	for (const id of pinnedIds) {
		if (selectedIds.size >= maximum) {
			break;
		}
		if (byId.has(id)) {
			selectedIds.add(id);
		}
	}
	for (let index = values.length - 1; index >= 0 && selectedIds.size < maximum; index -= 1) {
		selectedIds.add(idFor(values[index]));
	}
	return values.filter((value) => selectedIds.has(idFor(value)));
}

function emptyCounts(): DashboardCounts {
	return {
		generations: 0,
		ideas: 0,
		experiments: 0,
		reflections: 0,
		events: 0,
		workers: 0,
		graphNodes: 0,
		graphEdges: 0,
		missions: 0,
		operatorNotes: 0,
		retryQueue: 0,
		materialUpdates: 0,
	};
}

function selectedDashboardMission(snapshot: DashboardSnapshot): ResearchMission | undefined {
	const active = snapshot.state.missions.filter((mission) => !isTerminalMission(mission)).at(-1);
	if (active) {
		return active;
	}
	const campaignMissionId = snapshot.activeCampaign?.missionId;
	if (snapshot.activeCampaign && !campaignMissionId) {
		return undefined;
	}
	return campaignMissionId
		? snapshot.state.missions.find((mission) => mission.id === campaignMissionId)
		: snapshot.state.missions.at(-1);
}

function selectedDashboardCampaign(
	snapshot: DashboardSnapshot,
	mission: ResearchMission | undefined,
): Campaign | undefined {
	if (mission?.campaignId) {
		return snapshot.state.campaigns.find((campaign) => campaign.id === mission.campaignId);
	}
	if (mission && !isTerminalMission(mission)) {
		return undefined;
	}
	return snapshot.activeCampaign;
}

function relatedOperatorNotes(
	state: IsoState,
	mission: ResearchMission | undefined,
	campaign: Campaign | undefined,
): OperatorNote[] {
	return state.operatorNotes.filter(
		(note) =>
			(mission !== undefined && note.missionId === mission.id) ||
			(campaign !== undefined && note.campaignId === campaign.id),
	);
}

function relatedMaterialUpdates(
	state: IsoState,
	mission: ResearchMission | undefined,
	campaign: Campaign | undefined,
): MaterialUpdate[] {
	return state.materialUpdates.filter(
		(update) =>
			(mission !== undefined && update.missionId === mission.id) ||
			(campaign !== undefined && update.campaignId === campaign.id),
	);
}

function dashboardProjection(snapshot: DashboardSnapshot): DashboardProjection {
	const mission = selectedDashboardMission(snapshot);
	const campaign = selectedDashboardCampaign(snapshot, mission);
	const control = controlTargetForEntities(mission, campaign);
	const missionNotes = relatedOperatorNotes(snapshot.state, mission, campaign);
	const missionUpdates = relatedMaterialUpdates(snapshot.state, mission, campaign);
	if (!campaign) {
		const compactedMission = mission ? compactMission(mission) : undefined;
		const notes = missionNotes.slice(-MAX_OPERATOR_NOTES).map(compactOperatorNote);
		const updates = missionUpdates.slice(-MAX_MATERIAL_UPDATES).map(compactMaterialUpdate);
		const totals = emptyCounts();
		totals.missions = mission ? 1 : 0;
		totals.operatorNotes = missionNotes.length;
		totals.materialUpdates = missionUpdates.length;
		const shown = emptyCounts();
		shown.missions = compactedMission ? 1 : 0;
		shown.operatorNotes = notes.length;
		shown.materialUpdates = updates.length;
		return {
			state: {
				schemaVersion: 2,
				revision: snapshot.state.revision,
				admissionEpoch: snapshot.state.admissionEpoch,
				campaigns: [],
				ideas: [],
				generations: [],
				experiments: [],
				reflections: [],
				events: [],
				missions: compactedMission ? [compactedMission] : [],
				operatorNotes: notes,
				retryQueue: [],
				agentCallAttempts: [],
				materialUpdates: updates,
				nextMaterialUpdateSequence: snapshot.state.nextMaterialUpdateSequence,
			},
			graph: { nodes: [], edges: [] },
			workers: [],
			activeMission: compactedMission,
			control,
			kernel: {
				pid: snapshot.kernel.pid,
				startedAt: snapshot.kernel.startedAt,
			},
			window: {
				totals,
				shown,
				limits: {
					generations: MAX_DASHBOARD_GENERATIONS,
					ideas: MAX_DASHBOARD_IDEAS,
					experiments: MAX_DASHBOARD_EXPERIMENTS,
					reflections: MAX_DASHBOARD_REFLECTIONS,
					events: MAX_DASHBOARD_EVENTS,
					workers: MAX_DASHBOARD_WORKERS,
					evaluationSamples: MAX_EVALUATION_SAMPLES,
				},
			},
		};
	}
	const generations = snapshot.state.generations
		.filter((generation) => generation.campaignId === campaign.id)
		.sort((left, right) => left.index - right.index);
	const campaignExperiments = snapshot.state.experiments
		.filter((experiment) => experiment.campaignId === campaign.id)
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	const campaignExperimentIds = new Set(campaignExperiments.map((experiment) => experiment.id));
	const campaignWorkers = snapshot.workers.filter((worker) => campaignExperimentIds.has(worker.experimentId));
	const championExperiment = campaignExperiments.find((experiment) => experiment.id === campaign.championExperimentId);
	const allCampaignIdeas = snapshot.state.ideas
		.filter((idea) => idea.campaignId === campaign.id)
		.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
	const ideaById = new Map(allCampaignIdeas.map((idea) => [idea.id, idea]));
	const championIdea = championExperiment ? ideaById.get(championExperiment.ideaId) : undefined;
	const ancestorIdeaIds = new Set<string>();
	const ancestorStack = [...(championIdea?.parentIdeaIds ?? [])];
	while (ancestorStack.length > 0 && ancestorIdeaIds.size < MAX_DASHBOARD_IDEAS) {
		const ancestorId = ancestorStack.pop();
		if (!ancestorId || ancestorIdeaIds.has(ancestorId)) {
			continue;
		}
		const ancestor = ideaById.get(ancestorId);
		if (!ancestor) {
			continue;
		}
		ancestorIdeaIds.add(ancestorId);
		ancestorStack.push(...ancestor.parentIdeaIds);
	}
	const ancestorGenerationIds = [...ancestorIdeaIds]
		.map((ideaId) => ideaById.get(ideaId)?.generationId)
		.filter((generationId): generationId is string => Boolean(generationId));
	const pinnedGenerationIds = [
		campaign.activeGenerationId,
		championExperiment?.generationId,
		...ancestorGenerationIds,
	].filter((value): value is string => Boolean(value));
	const selectedGenerations = selectRecentWithPins(
		generations,
		MAX_DASHBOARD_GENERATIONS,
		pinnedGenerationIds,
		(generation) => generation.id,
	);
	const generationIds = new Set(selectedGenerations.map((generation) => generation.id));
	const generationPinnedExperiments = selectedGenerations
		.flatMap((generation) => [generation.selectedExperimentId])
		.filter((value): value is string => Boolean(value));
	const workerPinnedExperiments = campaignWorkers.map((worker) => worker.experimentId);
	const selectedExperiments = selectRecentWithPins(
		campaignExperiments.filter((experiment) => generationIds.has(experiment.generationId)),
		MAX_DASHBOARD_EXPERIMENTS,
		[campaign.championExperimentId, ...generationPinnedExperiments, ...workerPinnedExperiments].filter(
			(value): value is string => Boolean(value),
		),
		(experiment) => experiment.id,
	);
	const experiments = selectedExperiments.map(compactExperiment);
	const campaignIdeas = allCampaignIdeas.filter((idea) => generationIds.has(idea.generationId));
	const activeGeneration = selectedGenerations.find((generation) => generation.id === campaign.activeGenerationId);
	const selectedIdeas = selectRecentWithPins(
		campaignIdeas,
		MAX_DASHBOARD_IDEAS,
		[
			...selectedExperiments.map((experiment) => experiment.ideaId),
			...ancestorIdeaIds,
			...(activeGeneration?.ideaIds ?? []),
			...campaignWorkers.map((worker) => worker.ideaId),
		],
		(idea) => idea.id,
	);
	const ideas = selectedIdeas.map(compactIdea);
	const reflections = snapshot.state.reflections
		.filter((reflection) => reflection.campaignId === campaign.id && generationIds.has(reflection.generationId))
		.slice(-MAX_DASHBOARD_REFLECTIONS)
		.map(compactReflection);
	const events = snapshot.state.events
		.filter((event) => event.campaignId === campaign.id)
		.slice(-MAX_DASHBOARD_EVENTS)
		.map(compactEvent);
	const workers = campaignWorkers.slice(0, MAX_DASHBOARD_WORKERS).map(compactWorker);
	const compactedCampaign = compactCampaign(campaign);
	const compactedMission = mission ? compactMission(mission) : undefined;
	const notes = missionNotes.slice(-MAX_OPERATOR_NOTES).map(compactOperatorNote);
	const updates = missionUpdates.slice(-MAX_MATERIAL_UPDATES).map(compactMaterialUpdate);
	const state: IsoState = {
		schemaVersion: 2,
		revision: snapshot.state.revision,
		admissionEpoch: snapshot.state.admissionEpoch,
		campaigns: [compactedCampaign],
		ideas,
		generations: selectedGenerations.map(compactGeneration),
		experiments,
		reflections,
		events,
		missions: compactedMission ? [compactedMission] : [],
		operatorNotes: notes,
		retryQueue: [],
		agentCallAttempts: [],
		materialUpdates: updates,
		nextMaterialUpdateSequence: snapshot.state.nextMaterialUpdateSequence,
	};
	const graph = buildIdeaGraph(state, campaign.id);
	const totalGraph = buildIdeaGraph(snapshot.state, campaign.id);
	const totalReflections = snapshot.state.reflections.filter(
		(reflection) => reflection.campaignId === campaign.id,
	).length;
	const totalEvents = snapshot.state.events.filter((event) => event.campaignId === campaign.id).length;
	const totals: DashboardCounts = {
		generations: generations.length,
		ideas: snapshot.state.ideas.filter((idea) => idea.campaignId === campaign.id).length,
		experiments: campaignExperiments.length,
		reflections: totalReflections,
		events: totalEvents,
		workers: campaignWorkers.length,
		graphNodes: totalGraph.nodes.length,
		graphEdges: totalGraph.edges.length,
		missions: mission ? 1 : 0,
		operatorNotes: missionNotes.length,
		retryQueue: snapshot.state.retryQueue.filter((retry) => retry.campaignId === campaign.id).length,
		materialUpdates: missionUpdates.length,
	};
	const shown: DashboardCounts = {
		generations: state.generations.length,
		ideas: state.ideas.length,
		experiments: state.experiments.length,
		reflections: state.reflections.length,
		events: state.events.length,
		workers: workers.length,
		graphNodes: graph.nodes.length,
		graphEdges: graph.edges.length,
		missions: compactedMission ? 1 : 0,
		operatorNotes: notes.length,
		retryQueue: 0,
		materialUpdates: updates.length,
	};
	return {
		state,
		graph,
		workers,
		activeCampaign: compactedCampaign,
		activeMission: compactedMission,
		control,
		kernel: {
			pid: snapshot.kernel.pid,
			startedAt: snapshot.kernel.startedAt,
		},
		window: {
			totals,
			shown,
			limits: {
				generations: MAX_DASHBOARD_GENERATIONS,
				ideas: MAX_DASHBOARD_IDEAS,
				experiments: MAX_DASHBOARD_EXPERIMENTS,
				reflections: MAX_DASHBOARD_REFLECTIONS,
				events: MAX_DASHBOARD_EVENTS,
				workers: MAX_DASHBOARD_WORKERS,
				evaluationSamples: MAX_EVALUATION_SAMPLES,
			},
		},
	};
}

function readBody(request: NodeJS.ReadableStream): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		let settled = false;
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			if (settled) {
				return;
			}
			body += chunk;
			if (body.length > 1_000_000) {
				settled = true;
				reject(new Error("Request body is too large."));
			}
		});
		request.on("end", () => {
			if (settled) {
				return;
			}
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch {
				reject(new Error("Request body must be JSON."));
			}
		});
		request.on("error", reject);
	});
}

function contentType(path: string): string {
	switch (extname(path)) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".html":
			return "text/html; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}

function isLoopback(host: string): boolean {
	return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function normalizedHostname(value: string): string | undefined {
	const trimmed = value.trim().toLowerCase().replace(/\.$/u, "");
	if (
		!trimmed ||
		trimmed.includes("/") ||
		trimmed.includes("?") ||
		trimmed.includes("#") ||
		trimmed.includes("@") ||
		trimmed.includes("[") ||
		trimmed.includes("]") ||
		(trimmed !== "::1" && trimmed.includes(":"))
	) {
		return undefined;
	}
	return trimmed;
}

function requestHostname(hostHeader: string | undefined): string | undefined {
	if (!hostHeader) {
		return undefined;
	}
	try {
		return new URL(`http://${hostHeader}`).hostname
			.toLowerCase()
			.replace(/^\[|\]$/gu, "")
			.replace(/\.$/u, "");
	} catch {
		return undefined;
	}
}

function originIsAllowed(origin: string | undefined, allowedHostnames: ReadonlySet<string>): boolean {
	if (!origin) {
		return true;
	}
	try {
		const parsed = new URL(origin);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			allowedHostnames.has(
				parsed.hostname
					.toLowerCase()
					.replace(/^\[|\]$/gu, "")
					.replace(/\.$/u, ""),
			)
		);
	} catch {
		return false;
	}
}

function constantTimeSecretMatch(actual: string | string[] | undefined, expected: string): boolean {
	if (typeof actual !== "string") {
		return false;
	}
	const actualBuffer = Buffer.from(actual);
	const expectedBuffer = Buffer.from(expected);
	return actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer);
}

function mutationEnvelope(body: unknown): MutationEnvelope | undefined {
	if (
		!isRecord(body) ||
		(body.targetKind !== "mission" && body.targetKind !== "campaign") ||
		typeof body.targetId !== "string" ||
		body.targetId.length === 0 ||
		body.targetId.length > 500 ||
		typeof body.expectedControlFingerprint !== "string" ||
		!/^[a-zA-Z0-9_-]{43}$/u.test(body.expectedControlFingerprint) ||
		typeof body.actionId !== "string" ||
		!/^[-.:_a-zA-Z0-9]{8,200}$/u.test(body.actionId)
	) {
		return undefined;
	}
	return {
		targetKind: body.targetKind,
		targetId: body.targetId,
		expectedControlFingerprint: body.expectedControlFingerprint,
		actionId: body.actionId,
	};
}

function mutationActionFingerprint(path: string, envelope: MutationEnvelope, body: unknown): string {
	let payload: Record<string, unknown> = {};
	if (path === "/api/note" || /^\/api\/workers\/[^/]+\/steer$/u.test(path)) {
		payload = {
			message: isRecord(body) && typeof body.message === "string" ? body.message.trim().slice(0, 4_000) : body,
		};
	} else if (path === "/api/research/stop") {
		payload = {
			reason: isRecord(body) && typeof body.reason === "string" ? body.reason.trim().slice(0, 500) : body,
		};
	}
	return createHash("sha256")
		.update(
			JSON.stringify({
				targetKind: envelope.targetKind,
				targetId: envelope.targetId,
				path,
				payload,
			}),
		)
		.digest("base64url");
}

function controlActionCanRebase(path: string): boolean {
	return (
		path === "/api/note" || path === "/api/research/stop" || /^\/api\/workers\/[^/]+\/(?:steer|abort)$/u.test(path)
	);
}

async function listen(server: Server, port: number, host: string): Promise<void> {
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			server.off("listening", onListening);
			reject(error);
		};
		const onListening = () => {
			server.off("error", onError);
			resolve();
		};
		server.once("error", onError);
		server.once("listening", onListening);
		server.listen(port, host);
	});
}

export async function startDashboard(runtime: IsoRuntime, options: ServeOptions): Promise<DashboardServer> {
	const loopback = isLoopback(options.host);
	if (!loopback && !options.trustedRelay) {
		throw new Error("ISO refuses a non-loopback dashboard bind without explicit trusted relay authentication.");
	}
	if (
		options.trustedRelay &&
		(options.trustedRelay.readToken.length < 24 ||
			options.trustedRelay.controlToken.length < 24 ||
			options.trustedRelay.readToken === options.trustedRelay.controlToken)
	) {
		throw new Error("Trusted relay read and control tokens must be distinct secrets of at least 24 characters.");
	}
	const configuredAllowedHosts = options.trustedRelay?.allowedHosts ?? [options.host];
	const normalizedAllowedHosts = configuredAllowedHosts.map(normalizedHostname);
	if (normalizedAllowedHosts.length === 0 || normalizedAllowedHosts.some((hostname) => hostname === undefined)) {
		throw new Error("Dashboard allowed hosts must be non-empty hostnames without a scheme, port, or path.");
	}
	const allowedHostnames = new Set(
		normalizedAllowedHosts.filter((hostname): hostname is string => hostname !== undefined),
	);
	const token = options.trustedRelay ? undefined : randomBytes(24).toString("base64url");
	const scriptNonce = randomBytes(18).toString("base64url");
	const assetRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "public");
	const eventClients = new Set<ServerResponse>();
	const actionReceipts = new Map<string, ActionReceipt>();
	let changeVersion = 0;
	let closePromise: Promise<void> | undefined;
	let mutationTail = Promise.resolve();

	const writeEvent = (client: ServerResponse, payload: string): void => {
		if (client.write(payload)) {
			return;
		}
		eventClients.delete(client);
		client.end();
	};

	const unsubscribe = runtime.onChange(() => {
		changeVersion += 1;
		for (const client of eventClients) {
			writeEvent(client, `event: change\ndata: ${changeVersion}\n\n`);
		}
	});

	const performMutation = async (path: string, body: unknown): Promise<ActionResult> => {
		const envelope = mutationEnvelope(body);
		if (!envelope) {
			return {
				status: 400,
				value: {
					error: "Every control action requires targetKind, targetId, expectedControlFingerprint, and a valid actionId.",
				},
			};
		}
		const actionFingerprint = mutationActionFingerprint(path, envelope, body);
		const prior = actionReceipts.get(envelope.actionId);
		if (prior) {
			if (
				prior.targetKind !== envelope.targetKind ||
				prior.targetId !== envelope.targetId ||
				prior.path !== path ||
				prior.actionFingerprint !== actionFingerprint
			) {
				return {
					status: 409,
					value: { error: "This actionId was already used for a different control action." },
				};
			}
			return prior.result;
		}
		const cacheReceipt = (receipt: ActionReceipt): void => {
			actionReceipts.set(envelope.actionId, receipt);
			if (actionReceipts.size > MAX_ACTION_RECEIPTS) {
				const oldestActionId = actionReceipts.keys().next().value;
				if (typeof oldestActionId === "string") {
					actionReceipts.delete(oldestActionId);
				}
			}
		};

		const conflictResult = (error: ControlConflictError): ActionResult => ({
			status: 409,
			value: {
				error: error.message,
				code: error.code,
				...(error.code === "control_precondition_changed" ? { rebaseEligible: error.rebaseEligible } : {}),
				...(error.activeControl ? { activeControl: error.activeControl } : {}),
				revision: error.revision,
			},
		});

		let controlAction: ResearchControlAction | undefined;
		if (path === "/api/research/start") {
			controlAction = { kind: "start" };
		} else if (path === "/api/research/resume") {
			controlAction = { kind: "resume" };
		} else if (path === "/api/research/pause") {
			controlAction = { kind: "pause" };
		} else if (path === "/api/note") {
			const message = isRecord(body) && typeof body.message === "string" ? body.message.trim().slice(0, 4_000) : "";
			if (!message) {
				return { status: 400, value: { error: "A guidance note is required." } };
			}
			controlAction = { kind: "note", message };
		} else if (path === "/api/research/stop") {
			if (isRecord(body) && body.reason !== undefined && typeof body.reason !== "string") {
				return { status: 400, value: { error: "Stop reason must be text." } };
			}
			const reason =
				isRecord(body) && typeof body.reason === "string"
					? body.reason.trim().slice(0, 500)
					: "Stopped from the ISO dashboard";
			controlAction = { kind: "stop", reason: reason || "Stopped from the ISO dashboard" };
		}

		if (controlAction) {
			const request: ResearchControlRequest = {
				actionId: envelope.actionId,
				actionFingerprint,
				targetKind: envelope.targetKind,
				targetId: envelope.targetId,
				expectedControlFingerprint: envelope.expectedControlFingerprint,
				action: controlAction,
			};
			try {
				const operation = () => runtime.applyControl(request);
				const receipt = options.mutationExecutor ? await options.mutationExecutor(operation) : await operation();
				if (
					receipt.actionId !== envelope.actionId ||
					receipt.actionFingerprint !== actionFingerprint ||
					receipt.targetKind !== envelope.targetKind ||
					receipt.targetId !== envelope.targetId
				) {
					return {
						status: 409,
						value: { error: "This actionId was already used for a different control action." },
					};
				}
				const result: ActionResult = {
					status: receipt.outcome.kind === "start" || receipt.outcome.kind === "resume" ? 202 : 200,
					value: { ok: true, ...receipt },
				};
				cacheReceipt({
					targetKind: envelope.targetKind,
					targetId: envelope.targetId,
					path,
					actionFingerprint,
					result,
				});
				return result;
			} catch (error) {
				if (error instanceof ControlConflictError) {
					return conflictResult(error);
				}
				if (error instanceof IdempotencyConflictError) {
					return {
						status: 409,
						value: { error: "This actionId was already used for a different control action." },
					};
				}
				return {
					status: 500,
					value: {
						error: "The durable control action could not be reconciled.",
						actionId: envelope.actionId,
					},
				};
			}
		}

		const executeFreshWorkerResult = async (): Promise<ActionResult> => {
			const current = await runtime.snapshot();
			const mission = selectedDashboardMission(current);
			const campaign = selectedDashboardCampaign(current, mission);
			const target = controlTargetForEntities(mission, campaign);
			if (!target) {
				throw new ControlConflictError({
					code: "no_control_target",
					message: "There is no active mission or campaign to control.",
					revision: current.state.revision,
				});
			}
			if (target.kind !== envelope.targetKind || target.id !== envelope.targetId) {
				throw new ControlConflictError({
					code: "control_target_changed",
					message: "The active research target changed. Refresh before issuing another control action.",
					activeControl: target,
					revision: current.state.revision,
				});
			}
			if (target.fingerprint !== envelope.expectedControlFingerprint) {
				const rebaseEligible = controlActionCanRebase(path);
				throw new ControlConflictError({
					code: "control_precondition_changed",
					message: rebaseEligible
						? "The research control state changed. ISO can safely rebase this action after refresh."
						: "The research control state changed. Refresh and confirm this action again.",
					activeControl: target,
					revision: current.state.revision,
					rebaseEligible,
				});
			}

			const steerMatch = path.match(/^\/api\/workers\/([^/]+)\/steer$/u);
			const abortMatch = path.match(/^\/api\/workers\/([^/]+)\/abort$/u);
			const encodedWorkerId = steerMatch?.[1] ?? abortMatch?.[1];
			if (!encodedWorkerId) {
				return { status: 404, value: { error: "Unknown API route." } };
			}
			let workerId: string;
			try {
				workerId = decodeURIComponent(encodedWorkerId);
			} catch {
				return { status: 400, value: { error: "Worker identifier is invalid." } };
			}
			const worker = current.workers.find((candidate) => candidate.id === workerId);
			const experiment = worker
				? current.state.experiments.find((candidate) => candidate.id === worker.experimentId)
				: undefined;
			const workerCampaign = experiment
				? current.state.campaigns.find((candidate) => candidate.id === experiment.campaignId)
				: undefined;
			const belongsToTarget =
				target.kind === "campaign"
					? workerCampaign?.id === target.id
					: workerCampaign?.missionId === target.id && mission?.id === target.id;
			if (workerId.length === 0 || workerId.length > 500 || !worker || !experiment || !belongsToTarget) {
				return {
					status: 404,
					value: { error: "The requested worker is not active for this research target." },
				};
			}
			try {
				let outcome: Record<string, unknown>;
				if (steerMatch) {
					const message =
						isRecord(body) && typeof body.message === "string" ? body.message.trim().slice(0, 4_000) : "";
					if (!message) {
						return { status: 400, value: { error: "A steering message is required." } };
					}
					await runtime.steer(workerId, message);
					outcome = { kind: "steer", steered: true, workerId, delivery: "best-effort" };
				} else {
					await runtime.abort(workerId);
					outcome = { kind: "abort", aborted: true, workerId, delivery: "best-effort" };
				}
				const resulting = await runtime.snapshot();
				return {
					status: 200,
					value: {
						ok: true,
						actionId: envelope.actionId,
						actionFingerprint,
						targetKind: envelope.targetKind,
						targetId: envelope.targetId,
						acceptedControlFingerprint: envelope.expectedControlFingerprint,
						revision: resulting.state.revision,
						outcome,
					},
				};
			} catch {
				return {
					status: 500,
					value: {
						error: "The control action failed inside the local research kernel.",
						actionId: envelope.actionId,
					},
				};
			}
		};

		try {
			// Pi worker controls do not expose an idempotency key. Delivery is
			// therefore best-effort, while target validation and the local
			// receipt remain serialized through the kernel mutation executor.
			const operation = () =>
				runtime.store.executeOnce<ActionReceipt>(`dashboard-worker:v1:${envelope.actionId}`, async () => ({
					targetKind: envelope.targetKind,
					targetId: envelope.targetId,
					path,
					actionFingerprint,
					result: await executeFreshWorkerResult(),
				}));
			const receipt = options.mutationExecutor ? await options.mutationExecutor(operation) : await operation();
			if (
				receipt.targetKind !== envelope.targetKind ||
				receipt.targetId !== envelope.targetId ||
				receipt.path !== path ||
				receipt.actionFingerprint !== actionFingerprint
			) {
				return {
					status: 409,
					value: { error: "This actionId was already used for a different control action." },
				};
			}
			cacheReceipt(receipt);
			return receipt.result;
		} catch (error) {
			if (error instanceof ControlConflictError) {
				return conflictResult(error);
			}
			return {
				status: 500,
				value: {
					error: "The durable control receipt could not be recorded.",
					actionId: envelope.actionId,
				},
			};
		}
	};

	const enqueueMutation = (path: string, body: unknown): Promise<ActionResult> => {
		const operation = mutationTail.then(
			() => performMutation(path, body),
			() => performMutation(path, body),
		);
		mutationTail = operation.then(
			() => undefined,
			() => undefined,
		);
		return operation;
	};

	const server = createServer(async (request, response) => {
		try {
			const hostname = requestHostname(request.headers.host);
			if (!hostname || !allowedHostnames.has(hostname)) {
				sendJson(response, 421, { error: "Dashboard Host is not allowed." });
				return;
			}
			const url = new URL(request.url ?? "/", "http://iso.invalid");
			if (
				options.trustedRelay &&
				!constantTimeSecretMatch(request.headers[ISO_RELAY_READ_HEADER], options.trustedRelay.readToken)
			) {
				sendJson(response, 403, { error: "Trusted relay read authentication is required." });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/health") {
				sendJson(response, 200, { ok: true });
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/snapshot") {
				sendJson(response, 200, dashboardProjection(await runtime.snapshot()));
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/events") {
				if (eventClients.size >= MAX_EVENT_CLIENTS) {
					sendJson(response, 429, { error: "Too many dashboard event streams." });
					return;
				}
				response.writeHead(200, {
					"cache-control": "no-cache, no-transform",
					connection: "keep-alive",
					"content-type": "text/event-stream",
					"x-accel-buffering": "no",
					"x-content-type-options": "nosniff",
				});
				response.write(`event: ready\ndata: ${changeVersion}\n\n`);
				eventClients.add(response);
				request.once("close", () => eventClients.delete(response));
				return;
			}
			if (request.method === "POST" && url.pathname.startsWith("/api/")) {
				const fetchSite = request.headers["sec-fetch-site"];
				if (
					(typeof fetchSite === "string" && !["same-origin", "none"].includes(fetchSite)) ||
					!originIsAllowed(
						typeof request.headers.origin === "string" ? request.headers.origin : undefined,
						allowedHostnames,
					)
				) {
					sendJson(response, 403, { error: "Cross-origin dashboard controls are forbidden." });
					return;
				}
				const controlAuthorized = options.trustedRelay
					? constantTimeSecretMatch(request.headers[ISO_RELAY_CONTROL_HEADER], options.trustedRelay.controlToken)
					: constantTimeSecretMatch(request.headers["x-iso-control-token"], token ?? "");
				if (!controlAuthorized) {
					sendJson(response, 403, { error: "Invalid control token." });
					return;
				}
				let body: unknown;
				try {
					body = await readBody(request);
				} catch (error) {
					const tooLarge = errorMessage(error) === "Request body is too large.";
					sendJson(response, tooLarge ? 413 : 400, {
						error: tooLarge ? "Request body is too large." : "Request body must be JSON.",
					});
					return;
				}
				const result = await enqueueMutation(url.pathname, body);
				sendJson(response, result.status, result.value);
				return;
			}

			const requestedAsset = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
			const normalizedAsset = normalize(requestedAsset).replace(/^(\.\.(\/|\\|$))+/, "");
			if (!["index.html", "styles.css", "app.js"].includes(normalizedAsset)) {
				sendJson(response, 404, { error: "Asset not found." });
				return;
			}
			const assetPath = join(assetRoot, normalizedAsset);
			let content = await readFile(assetPath);
			if (normalizedAsset === "index.html") {
				const canControl = options.trustedRelay
					? constantTimeSecretMatch(request.headers[ISO_RELAY_CONTROL_HEADER], options.trustedRelay.controlToken)
					: true;
				content = Buffer.from(
					content
						.toString("utf8")
						.replace("__ISO_CONTROL_TOKEN_JSON__", JSON.stringify(token ?? null))
						.replace("__ISO_CAN_CONTROL_JSON__", JSON.stringify(canControl))
						.replace("__ISO_SCRIPT_NONCE__", scriptNonce),
				);
			}
			response.writeHead(200, {
				"cache-control": "no-store",
				"content-security-policy": `default-src 'self'; script-src 'self' 'nonce-${scriptNonce}'; style-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`,
				"content-type": contentType(assetPath),
				"referrer-policy": "no-referrer",
				"x-content-type-options": "nosniff",
				"x-frame-options": "DENY",
			});
			response.end(content);
		} catch (error) {
			if (!response.headersSent) {
				const missing = isRecord(error) && error.code === "ENOENT";
				sendJson(response, missing ? 404 : 500, {
					error: missing ? "Asset not found." : "The dashboard request failed.",
				});
			} else {
				response.end();
			}
		}
	});

	const heartbeat = setInterval(() => {
		for (const client of eventClients) {
			writeEvent(client, ": heartbeat\n\n");
		}
	}, 15_000);
	heartbeat.unref();

	try {
		await listen(server, options.port, options.host);
	} catch (error) {
		clearInterval(heartbeat);
		unsubscribe();
		throw error;
	}
	const address = server.address() as AddressInfo | null;
	if (!address) {
		clearInterval(heartbeat);
		unsubscribe();
		server.close();
		throw new Error("ISO dashboard server did not publish a listening address.");
	}
	const displayHost = options.host.includes(":") ? `[${options.host}]` : options.host;
	const dashboard: DashboardServer = {
		url: `http://${displayHost}:${address.port}`,
		host: options.host,
		port: address.port,
		token,
		close() {
			closePromise ??= (async () => {
				clearInterval(heartbeat);
				unsubscribe();
				for (const client of eventClients) {
					client.end();
				}
				eventClients.clear();
				await new Promise<void>((resolve, reject) => {
					server.close((error) => {
						if (error) {
							reject(error);
						} else {
							resolve();
						}
					});
				});
			})();
			return closePromise;
		},
	};
	if (options.startResearch) {
		try {
			const current = await runtime.snapshot();
			const mission = selectedDashboardMission(current);
			const missionReceipt = mission && !isTerminalMission(mission) ? await runtime.resumeMission() : undefined;
			if (!mission || missionReceipt?.campaignId) {
				await runtime.startResearch();
			}
		} catch (error) {
			await dashboard.close().catch(() => undefined);
			throw error;
		}
	}
	return dashboard;
}

export async function serveDashboard(runtime: IsoRuntime, options: ServeOptions): Promise<void> {
	const dashboard = await startDashboard(runtime, options);
	console.log(`ISO dashboard: ${dashboard.url}`);
	if (!isLoopback(options.host)) {
		console.log("Trusted relay authentication is required for dashboard reads and control actions.");
	}
	await new Promise<void>((resolve) => {
		const onSignal = () => {
			process.off("SIGINT", onSignal);
			process.off("SIGTERM", onSignal);
			resolve();
		};
		process.once("SIGINT", onSignal);
		process.once("SIGTERM", onSignal);
	});
	await dashboard.close();
}
