import type { DeclaredScoreBounds, PostSelectionEvidence } from "./selection.ts";

export type MetricDirection = "maximize" | "minimize";
export type CampaignRunIntent = "idle" | "running" | "paused" | "stopped";
export type MissionDesiredState = "running" | "paused" | "stopped";
export type MissionPhase =
	| "accepted"
	| "calibrating"
	| "starting"
	| "researching"
	| "paused"
	| "completed"
	| "stopped"
	| "failed";
export type CampaignStatus =
	| "calibrating"
	| "ready"
	| "planning"
	| "running"
	| "pausing"
	| "paused"
	| "completed"
	| "stopped"
	| "failed";
export type GenerationStatus =
	| "created"
	| "planning"
	| "executing"
	| "verifying"
	| "selecting"
	| "reflecting"
	| "completed"
	| "cancelled"
	| "failed";
export type IdeaStatus = "proposed" | "queued" | "running" | "measured" | "rejected" | "failed";
export type ExperimentStatus =
	| "created"
	| "workspace-ready"
	| "agent-running"
	| "candidate-frozen"
	| "evaluating"
	| "measured"
	| "invalid"
	| "failed"
	| "cancelled"
	| "interrupted";
export type ExperimentPhase = "workspace" | "agent" | "snapshot" | "policy" | "evaluator" | "selection";
export type FailureKind = "infrastructure" | "agent" | "policy" | "invalid-result" | "cancelled" | "unknown";
export type IdeaStrategy = "explore" | "exploit" | "verify";

export interface MetricDefinition {
	name: string;
	direction: MetricDirection;
	minimumImprovement: number;
}

export interface EvaluatorPolicy {
	command: string;
	controlCwd: string;
	samples: number;
	warmups: number;
	timeoutMs: number;
	protectedPaths: string[];
	/** Enables distribution-free bounded post-selection promotion when declared. */
	scoreBounds?: DeclaredScoreBounds;
}

export interface ResearchBudget {
	maxGenerations: number;
	maxExperiments: number;
	maxWallClockMs: number;
	maxConsecutivePlateaus: number;
	maxFailures: number;
	maxInputTokens?: number;
	maxOutputTokens?: number;
	maxCostUsd?: number;
}

export type AgentThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export interface ResearchAgentModelPolicy {
	provider: string;
	model: string;
	thinkingLevel: AgentThinkingLevel;
}

export interface CampaignConfig {
	workers: number;
	agentTimeoutMs: number;
	agentModel?: ResearchAgentModelPolicy;
	evaluator: EvaluatorPolicy;
	budget: ResearchBudget;
}

export interface SourceBundleIdentity {
	sourceCommit: string;
	sourceHeadCommit: string;
	sourceSnapshotRef: string;
	sourceHadLocalChanges: boolean;
	sourceSnapshotPaths: string[];
	dependencyDigest: string;
}

export interface ResearchMissionInput extends SourceBundleIdentity {
	goal: string;
	metric: MetricDefinition;
	config: CampaignConfig;
}

export interface StatisticSummary {
	mean: number;
	median: number;
	stddev: number;
	min: number;
	max: number;
}

export interface EvaluationSample {
	score: number;
	metrics: Record<string, number>;
	summary?: string;
	valid: boolean;
	constraints: Record<string, boolean>;
	trialId?: string;
	phase?: "warmup" | "sample";
	sampleIndex?: number;
	seed?: number;
	durationMs: number;
	stdout: string;
	stderr: string;
}

export interface EvaluationAggregate {
	score: StatisticSummary;
	metrics: Record<string, StatisticSummary>;
	samples: EvaluationSample[];
	valid: boolean;
	failedConstraints: string[];
	measuredAt: string;
}

export interface BaselineMeasurement {
	commit: string;
	evaluatorDigest: string;
	resultSchemaDigest?: string;
	evaluation: EvaluationAggregate;
}

export interface RuntimeProvenance {
	isoVersion: string;
	nodeVersion: string;
	platform: string;
	architecture: string;
	sandboxRuntimeVersion: string;
	piCodingAgentVersion: string;
	artifactDigest?: string;
	evaluatorContract: "iso-result-line-v1";
	selectionMethod: "paired-mean-student-t95-independent-confirmation-v1" | "paired-postselection-bonferroni-v1";
}

export interface Campaign {
	id: string;
	missionId?: string;
	goal: string;
	metric: MetricDefinition;
	config: CampaignConfig;
	status: CampaignStatus;
	runIntent?: CampaignRunIntent;
	sourceCommit: string;
	sourceHeadCommit?: string;
	sourceSnapshotRef?: string;
	sourceHadLocalChanges?: boolean;
	sourceSnapshotPaths?: string[];
	dependencyDigest?: string;
	evaluatorDigest: string;
	runtimeProvenance?: RuntimeProvenance;
	baseline: BaselineMeasurement;
	championExperimentId?: string;
	activeGenerationId?: string;
	generationsCompleted: number;
	experimentsStarted: number;
	failures: number;
	consecutivePlateaus: number;
	startedAt?: string;
	stopReason?: string;
	completionReport?: CampaignCompletionReport;
	createdAt: string;
	updatedAt: string;
}

export interface Idea {
	id: string;
	campaignId: string;
	generationId: string;
	title: string;
	hypothesis: string;
	rationale: string;
	implementationPlan: string;
	predictedEffect: string;
	strategy: IdeaStrategy;
	status: IdeaStatus;
	source: "human" | "planner" | "worker";
	parentIdeaIds: string[];
	fingerprint: string;
	createdAt: string;
	updatedAt: string;
}

export interface ExperimentFailure {
	phase: ExperimentPhase;
	kind: FailureKind;
	message: string;
	retryable: boolean;
}

export interface AgentProvenance {
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	sessionId?: string;
	inputTokens?: number;
	outputTokens?: number;
	cost?: number;
}

export interface AgentUsageSummary {
	inputTokens: number;
	outputTokens: number;
	costUsd: number;
	agentCalls: number;
	callsMissingTokenAccounting: number;
	callsMissingCostAccounting: number;
}

export type AgentCallRole = "planner" | "worker" | "critic";
export type AgentCallStatus = "running" | "succeeded" | "failed" | "aborted" | "timed-out" | "interrupted";

export interface AgentCallAttempt {
	id: string;
	campaignId: string;
	generationId: string;
	experimentId?: string;
	ideaId?: string;
	role: AgentCallRole;
	attempt: number;
	status: AgentCallStatus;
	provider?: string;
	model?: string;
	thinkingLevel?: string;
	sessionId?: string;
	inputTokens?: number;
	outputTokens?: number;
	costUsd?: number;
	missingTokenAccounting: boolean;
	missingCostAccounting: boolean;
	error?: string;
	startedAt: string;
	finishedAt?: string;
}

export interface EvaluationSampleIdentity {
	trialId?: string;
	phase?: EvaluationSample["phase"];
	sampleIndex?: number;
	seed?: number;
}

export interface ConfirmationIntervalEvidence {
	method:
		| "paired-student-t"
		| "welch-student-t"
		| "paired-bounded-hoeffding-bonferroni-v1"
		| "paired-student-t-bonferroni-v1";
	df?: number;
	alpha: number;
	criticalValue?: number;
	uncertainty: number;
	lowerBound: number;
}

export interface ConfirmationEvidence {
	round: number;
	/** Frozen paired plan that produced this evidence. */
	planId?: string;
	trialId?: string;
	candidateMean: number;
	incumbentMean: number;
	improvement: number;
	uncertainty: number;
	lowerBound: number;
	confirmed: boolean;
	measuredAt: string;
	candidateEvaluation?: EvaluationAggregate;
	incumbentEvaluation?: EvaluationAggregate;
	interval?: ConfirmationIntervalEvidence;
	sampleIdentities?: {
		candidate: EvaluationSampleIdentity[];
		incumbent: EvaluationSampleIdentity[];
	};
	/** Exact immutable post-selection gate, including its honest claim class and assumptions. */
	selection?: Readonly<PostSelectionEvidence>;
}

export interface PairedEvaluationPlan {
	id: string;
	kind: "screen" | "confirmation";
	trialIds: string[];
	startsWithCandidate: boolean;
	opportunityIndex?: number;
	createdAt: string;
}

export interface Experiment {
	id: string;
	campaignId: string;
	generationId: string;
	ideaId: string;
	attempt: number;
	retryOfExperimentId?: string;
	status: ExperimentStatus;
	baseCommit: string;
	branch: string;
	worktree: string;
	workerId?: string;
	candidateCommit?: string;
	diffStat?: string;
	changedPaths: string[];
	evaluation?: EvaluationAggregate;
	incumbentEvaluation?: EvaluationAggregate;
	improvement?: number;
	uncertainty?: number;
	confirmationEvaluation?: EvaluationAggregate;
	confirmationIncumbentEvaluation?: EvaluationAggregate;
	confirmationImprovement?: number;
	confirmationUncertainty?: number;
	confirmationRoundsPassed?: number;
	confirmationHistory?: ConfirmationEvidence[];
	screeningPlan?: PairedEvaluationPlan;
	confirmationPlan?: PairedEvaluationPlan;
	screeningAttempts?: number;
	confirmationAttempts?: number;
	/** Exploratory filter only. This is never promotion evidence. */
	screeningPassed?: boolean;
	/** True only after fresh post-selection evidence atomically promotes this experiment. */
	credibleImprovement?: boolean;
	rejectionReason?: string;
	failure?: ExperimentFailure;
	agent?: AgentProvenance;
	assistantSummary?: string;
	startedAt?: string;
	finishedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface Generation {
	id: string;
	campaignId: string;
	index: number;
	status: GenerationStatus;
	baseCommit: string;
	ideaIds: string[];
	experimentIds: string[];
	selectedExperimentId?: string;
	reflectionId?: string;
	planner?: AgentProvenance;
	critic?: AgentProvenance;
	startedAt?: string;
	finishedAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface Reflection {
	id: string;
	campaignId: string;
	generationId: string;
	summary: string;
	lessons: string[];
	deadEnds: string[];
	nextFocus: string[];
	createdAt: string;
}

export interface IsoEvent {
	id: string;
	sequence?: number;
	campaignId: string;
	generationId?: string;
	experimentId?: string;
	type: string;
	summary: string;
	actor: "human" | "conductor" | "planner" | "worker" | "evaluator" | "selector" | "system";
	at: string;
	refs: string[];
	data?: Record<string, unknown>;
}

export interface MissionDiagnostic {
	id: string;
	phase: MissionPhase;
	code: string;
	message: string;
	retryable: boolean;
	at: string;
}

export interface ChampionHandoff {
	campaignId: string;
	experimentId: string;
	ideaId: string;
	sourceCommit: string;
	candidateCommit: string;
	diffStat?: string;
	changedPaths: string[];
	baselineScore: number;
	championScore: number;
	cumulativeImprovement?: number;
	cumulativeUncertainty?: number;
	stepImprovement?: number;
	stepUncertainty?: number;
	improvement?: number;
	uncertainty?: number;
	confirmationRoundsPassed: number;
	applyPrecondition: {
		expectedHead: string;
		requiresCleanWorktree: true;
		requiresDirtySourceReconciliation: boolean;
		sourceSnapshotPaths: string[];
	};
}

export interface CampaignCompletionReport {
	campaignId: string;
	missionId?: string;
	outcome: "completed" | "stopped" | "failed";
	reason: string;
	goal: string;
	metric: MetricDefinition;
	baselineScore: number;
	champion?: ChampionHandoff;
	generationsCompleted: number;
	experimentsStarted: number;
	measuredExperiments: number;
	failures: number;
	agentUsage: AgentUsageSummary;
	keyFindings: string[];
	generatedAt: string;
}

export interface ResearchMission {
	id: string;
	/** Present on every conversationally accepted mission; optional only for legacy state migration. */
	preflightId?: string;
	/** Stable operation identity derived from the preflight and canonical persisted input. */
	launchOperationId?: string;
	/** Canonical SHA-256 digest of input. */
	launchInputDigest?: string;
	input: ResearchMissionInput;
	desiredState: MissionDesiredState;
	phase: MissionPhase;
	campaignId?: string;
	diagnostics: MissionDiagnostic[];
	completionReport?: CampaignCompletionReport;
	notificationCursor: number;
	createdAt: string;
	updatedAt: string;
	startedAt?: string;
	completedAt?: string;
}

export interface MaterialUpdate {
	sequence: number;
	missionId?: string;
	campaignId?: string;
	kind: "mission" | "generation" | "champion" | "operator" | "recovery" | "completion" | "failure";
	summary: string;
	at: string;
	refs: string[];
}

export interface OperatorNote {
	id: string;
	missionId?: string;
	campaignId?: string;
	message: string;
	hypothesis?: ProposedIdea;
	status: "queued" | "consumed" | "dismissed";
	createdAt: string;
	consumedAt?: string;
	consumedGenerationId?: string;
}

export interface ExperimentRetry {
	id: string;
	campaignId: string;
	sourceExperimentId: string;
	sourceIdeaId: string;
	proposal: ProposedIdea;
	attempt: number;
	status: "queued" | "claimed" | "exhausted";
	createdAt: string;
	claimedAt?: string;
	claimedGenerationId?: string;
}

export interface IsoState {
	schemaVersion: 2;
	revision: number;
	/** Monotonic barrier advanced by pause/stop so pre-admission work cannot launch afterward. */
	admissionEpoch: number;
	campaigns: Campaign[];
	ideas: Idea[];
	generations: Generation[];
	experiments: Experiment[];
	reflections: Reflection[];
	events: IsoEvent[];
	missions: ResearchMission[];
	operatorNotes: OperatorNote[];
	retryQueue: ExperimentRetry[];
	agentCallAttempts: AgentCallAttempt[];
	materialUpdates: MaterialUpdate[];
	nextMaterialUpdateSequence: number;
}

export interface GraphNode {
	id: string;
	kind: "campaign" | "generation" | "idea" | "experiment" | "result" | "reflection";
	label: string;
	status: string;
	score?: number;
}

export interface GraphEdge {
	id: string;
	from: string;
	to: string;
	kind: "contains" | "proposes" | "derived-from" | "tests" | "produces" | "champions" | "reflects-on";
}

export interface IdeaGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface WorkerSnapshot {
	id: string;
	ideaId: string;
	experimentId: string;
	generationId: string;
	label: string;
	status: ExperimentStatus;
	activity: string;
	startedAt: string;
}

export interface DashboardSnapshot {
	state: IsoState;
	graph: IdeaGraph;
	workers: WorkerSnapshot[];
	activeCampaign?: Campaign;
	kernel: {
		pid: number;
		startedAt: string;
	};
}

export interface MissionReceipt {
	missionId: string;
	preflightId?: string;
	launchOperationId?: string;
	phase: MissionPhase;
	accepted: boolean;
	campaignId?: string;
}

export interface CampaignSummary {
	revision: number;
	mission?: {
		id: string;
		preflightId?: string;
		launchOperationId?: string;
		desiredState: MissionDesiredState;
		phase: MissionPhase;
		campaignId?: string;
		goal: string;
		metric: MetricDefinition;
		diagnostics: MissionDiagnostic[];
		notificationCursor: number;
		createdAt: string;
		updatedAt: string;
		startedAt?: string;
		completedAt?: string;
	};
	campaign?: {
		id: string;
		missionId?: string;
		goal: string;
		metric: MetricDefinition;
		status: CampaignStatus;
		runIntent?: CampaignRunIntent;
		agentModel?: ResearchAgentModelPolicy;
		sourceCommit: string;
		sourceHeadCommit?: string;
		sourceSnapshotRef?: string;
		sourceHadLocalChanges?: boolean;
		sourceSnapshotPaths: string[];
		dependencyDigest?: string;
		baselineScore: number;
		championExperimentId?: string;
		activeGenerationId?: string;
		generationsCompleted: number;
		experimentsStarted: number;
		failures: number;
		consecutivePlateaus: number;
		startedAt?: string;
		stopReason?: string;
		createdAt: string;
		updatedAt: string;
	};
	counts: {
		generations: number;
		experiments: number;
		measured: number;
		failed: number;
		queuedOperatorNotes: number;
		queuedRetries: number;
	};
	champion?: ChampionHandoff;
	completionReport?: CampaignCompletionReport;
	agentUsage: AgentUsageSummary;
	workers: WorkerSnapshot[];
	materialUpdates: MaterialUpdate[];
	nextNotificationCursor: number;
}

export type EvidenceQueryKind = "events" | "experiments" | "generations" | "reflections" | "updates";

export interface EvidenceQueryInput {
	kind: EvidenceQueryKind;
	campaignId?: string;
	generationId?: string;
	experimentId?: string;
	cursor?: string;
	limit?: number;
}

export interface ExperimentEvidence {
	id: string;
	campaignId: string;
	generationId: string;
	ideaId: string;
	attempt: number;
	retryOfExperimentId?: string;
	status: ExperimentStatus;
	baseCommit: string;
	candidateCommit?: string;
	diffStat?: string;
	changedPaths: string[];
	score?: StatisticSummary;
	incumbentScore?: StatisticSummary;
	improvement?: number;
	uncertainty?: number;
	confirmationRoundsPassed?: number;
	confirmationHistory?: ConfirmationEvidence[];
	screeningPlan?: PairedEvaluationPlan;
	confirmationPlan?: PairedEvaluationPlan;
	screeningAttempts?: number;
	confirmationAttempts?: number;
	screeningPassed?: boolean;
	credibleImprovement?: boolean;
	rejectionReason?: string;
	failure?: ExperimentFailure;
	assistantSummary?: string;
	createdAt: string;
	updatedAt: string;
	finishedAt?: string;
}

export interface EvidencePage {
	kind: EvidenceQueryKind;
	items: Array<IsoEvent | ExperimentEvidence | Generation | Reflection | MaterialUpdate>;
	nextCursor?: string;
}

export interface ProposedIdea {
	title: string;
	hypothesis: string;
	rationale: string;
	implementationPlan: string;
	predictedEffect: string;
	strategy: IdeaStrategy;
	parentIdeaIds?: string[];
}

export interface GenerationPlan {
	thesis: string;
	ideas: ProposedIdea[];
	provenance?: AgentProvenance;
}

export interface GenerationReflection {
	summary: string;
	lessons: string[];
	deadEnds: string[];
	nextFocus: string[];
	shouldStop: boolean;
	stopReason?: string;
	provenance?: AgentProvenance;
}

export interface CampaignCreateInput {
	goal: string;
	metric: MetricDefinition;
	config: CampaignConfig;
	sourceCommit: string;
	sourceHeadCommit?: string;
	sourceSnapshotRef?: string;
	sourceHadLocalChanges?: boolean;
	sourceSnapshotPaths?: string[];
	dependencyDigest?: string;
	evaluatorDigest: string;
	runtimeProvenance?: RuntimeProvenance;
	baseline: BaselineMeasurement;
}
