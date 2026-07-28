export type MetricDirection = "maximize" | "minimize";
export type CampaignStatus = "draft" | "running" | "paused" | "completed" | "failed";
export type IdeaStatus = "queued" | "running" | "evaluated" | "failed";
export type ExperimentStatus = "preparing" | "running" | "evaluating" | "completed" | "failed" | "aborted";

export interface MetricDefinition {
	name: string;
	direction: MetricDirection;
}

export interface CampaignConfig {
	defaultIterations: number;
	defaultWorkers: number;
	evaluator: string;
}

export interface Campaign {
	id: string;
	goal: string;
	metric: MetricDefinition;
	config: CampaignConfig;
	status: CampaignStatus;
	createdAt: string;
	updatedAt: string;
	championExperimentId?: string;
}

export interface Idea {
	id: string;
	campaignId: string;
	title: string;
	hypothesis: string;
	implementationPlan: string;
	status: IdeaStatus;
	source: "human" | "director" | "worker";
	parentIdeaIds: string[];
	createdAt: string;
	updatedAt: string;
}

export interface Evaluation {
	score: number;
	metrics: Record<string, number>;
	summary?: string;
	stdout?: string;
	stderr?: string;
}

export interface Experiment {
	id: string;
	campaignId: string;
	ideaId: string;
	status: ExperimentStatus;
	branch: string;
	worktree: string;
	baseCommit: string;
	startedAt: string;
	updatedAt: string;
	finishedAt?: string;
	commit?: string;
	diffStat?: string;
	evaluation?: Evaluation;
	error?: string;
}

export interface IsoEvent {
	id: string;
	campaignId: string;
	type: string;
	summary: string;
	actor: "human" | "director" | "worker" | "evaluator" | "system";
	at: string;
	refs: string[];
}

export interface IsoState {
	schemaVersion: 1;
	campaigns: Campaign[];
	ideas: Idea[];
	experiments: Experiment[];
	events: IsoEvent[];
}

export interface GraphNode {
	id: string;
	kind: "campaign" | "idea" | "experiment" | "result";
	label: string;
	status: string;
	score?: number;
}

export interface GraphEdge {
	id: string;
	from: string;
	to: string;
	kind: "proposes" | "derived-from" | "tests" | "produces" | "champions";
}

export interface IdeaGraph {
	nodes: GraphNode[];
	edges: GraphEdge[];
}

export interface WorkerSnapshot {
	id: string;
	ideaId: string;
	experimentId: string;
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
}

export interface ProposedIdea {
	title: string;
	hypothesis: string;
	implementationPlan: string;
	parentIdeaIds?: string[];
}
