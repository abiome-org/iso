import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { proposeIdeas } from "./director.ts";
import { runEvaluator } from "./evaluator.ts";
import { createExperimentWorktree, snapshotExperiment } from "./git.ts";
import { buildIdeaGraph, isBetterScore } from "./graph.ts";
import { createEvent, getActiveCampaign, IsoStore, makeId, now } from "./store.ts";
import type { Campaign, DashboardSnapshot, Experiment, Idea, IsoState, WorkerSnapshot } from "./types.ts";

interface ActiveWorker {
	session: AgentSession;
	snapshot: WorkerSnapshot;
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function campaignFor(state: IsoState): Campaign {
	const campaign = getActiveCampaign(state);
	if (!campaign) {
		throw new Error("No active ISO campaign. Run `iso init` first.");
	}
	return campaign;
}

function workerPrompt(campaign: Campaign, idea: Idea, state: IsoState): string {
	const priorResults = state.experiments
		.filter((experiment) => experiment.campaignId === campaign.id && experiment.evaluation)
		.map((experiment) => {
			const priorIdea = state.ideas.find((candidate) => candidate.id === experiment.ideaId);
			return `- ${priorIdea?.title ?? experiment.ideaId}: ${experiment.evaluation?.score}`;
		})
		.join("\n");
	return `You are an ISO experiment worker operating in an isolated git worktree.

Research goal: ${campaign.goal}
Objective: ${campaign.metric.direction} ${campaign.metric.name}
Hypothesis: ${idea.hypothesis}
Implementation plan: ${idea.implementationPlan}
Evaluator command: ${campaign.config.evaluator}

Prior measured results:
${priorResults || "No prior measurements."}

Inspect the repository, implement this experiment, and test your work. Focus tightly on the stated
hypothesis. Do not modify .iso, do not create additional git worktrees, and do not commit—the ISO
runtime snapshots your branch after you finish. Leave the worktree in the best evaluable state you can.`;
}

function activityFor(event: AgentSessionEvent): string | undefined {
	switch (event.type) {
		case "tool_execution_start":
			return `Using ${event.toolName}`;
		case "compaction_start":
			return "Compacting context";
		case "auto_retry_start":
			return `Retrying after model error (${event.attempt})`;
		case "agent_settled":
			return "Agent settled";
		default:
			return undefined;
	}
}

export class IsoRuntime {
	readonly repoRoot: string;
	readonly store: IsoStore;
	private readonly activeWorkers = new Map<string, ActiveWorker>();
	private readonly abortedWorkers = new Set<string>();
	private loopPromise?: Promise<void>;
	private changeListener?: () => void;

	constructor(repoRoot: string, store = new IsoStore(repoRoot)) {
		this.repoRoot = repoRoot;
		this.store = store;
	}

	onChange(listener: () => void): void {
		this.changeListener = listener;
	}

	private changed(): void {
		this.changeListener?.();
	}

	workers(): WorkerSnapshot[] {
		return [...this.activeWorkers.values()].map((worker) => structuredClone(worker.snapshot));
	}

	async snapshot(): Promise<DashboardSnapshot> {
		const state = await this.store.read();
		const activeCampaign = getActiveCampaign(state);
		return {
			state,
			graph: buildIdeaGraph(state, activeCampaign?.id),
			workers: this.workers(),
			activeCampaign,
		};
	}

	async addIdea(options: { title: string; hypothesis: string; implementationPlan: string }): Promise<Idea> {
		const state = await this.store.read();
		const campaign = campaignFor(state);
		const idea = await this.store.addIdea(campaign.id, options, "human");
		this.changed();
		return idea;
	}

	async startResearch(options: { iterations?: number; workers?: number } = {}): Promise<void> {
		if (this.loopPromise) {
			return this.loopPromise;
		}
		const state = await this.store.read();
		const campaign = campaignFor(state);
		const iterations = Math.max(1, options.iterations ?? campaign.config.defaultIterations);
		const workerCount = Math.max(1, options.workers ?? campaign.config.defaultWorkers);
		this.loopPromise = this.runResearchLoop(campaign.id, iterations, workerCount).finally(() => {
			this.loopPromise = undefined;
			this.changed();
		});
		return this.loopPromise;
	}

	async pause(): Promise<void> {
		await this.store.update((state) => {
			const campaign = campaignFor(state);
			campaign.status = "paused";
			campaign.updatedAt = now();
			state.events.push(
				createEvent(campaign.id, "campaign.paused", "Research paused after active experiments settle", "human", [
					campaign.id,
				]),
			);
		});
		this.changed();
	}

	async steer(workerId: string, message: string): Promise<void> {
		const worker = this.activeWorkers.get(workerId);
		if (!worker) {
			throw new Error(`Worker ${workerId} is not active.`);
		}
		await worker.session.steer(message);
		worker.snapshot.activity = `Steered: ${message}`;
		await this.store.update((state) => {
			const experiment = state.experiments.find((candidate) => candidate.id === worker.snapshot.experimentId);
			if (experiment) {
				state.events.push(
					createEvent(experiment.campaignId, "worker.steered", message, "human", [
						worker.snapshot.id,
						experiment.id,
					]),
				);
			}
		});
		this.changed();
	}

	async abort(workerId: string): Promise<void> {
		const worker = this.activeWorkers.get(workerId);
		if (!worker) {
			throw new Error(`Worker ${workerId} is not active.`);
		}
		this.abortedWorkers.add(workerId);
		worker.snapshot.activity = "Abort requested";
		await worker.session.abort();
		this.changed();
	}

	private async runResearchLoop(campaignId: string, iterations: number, workerCount: number): Promise<void> {
		await this.store.update((state) => {
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
			if (!campaign) {
				throw new Error(`Campaign ${campaignId} not found.`);
			}
			campaign.status = "running";
			campaign.updatedAt = now();
			state.events.push(
				createEvent(campaign.id, "research.started", `${iterations} iterations × ${workerCount} workers`, "human", [
					campaign.id,
				]),
			);
		});
		this.changed();

		for (let iteration = 0; iteration < iterations; iteration += 1) {
			let state = await this.store.read();
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
			if (!campaign || campaign.status === "paused" || campaign.status === "failed") {
				break;
			}
			let queued = state.ideas.filter((idea) => idea.campaignId === campaignId && idea.status === "queued");
			if (queued.length < workerCount) {
				await this.generateIdeas(campaign, state, workerCount - queued.length);
				state = await this.store.read();
				queued = state.ideas.filter((idea) => idea.campaignId === campaignId && idea.status === "queued");
			}
			const batch = queued.slice(0, workerCount);
			if (batch.length === 0) {
				throw new Error("No experiments available after director pass.");
			}
			await Promise.all(batch.map((idea) => this.runIdea(campaign, idea)));
		}

		await this.store.update((state) => {
			const campaign = state.campaigns.find((candidate) => candidate.id === campaignId);
			if (!campaign || campaign.status !== "running") {
				return;
			}
			campaign.status = "paused";
			campaign.updatedAt = now();
			state.events.push(
				createEvent(
					campaign.id,
					"research.budget-reached",
					"Iteration budget reached; campaign is ready to resume",
					"system",
					[campaign.id],
				),
			);
		});
	}

	private async generateIdeas(campaign: Campaign, state: IsoState, count: number): Promise<void> {
		await this.store.update((draft) => {
			draft.events.push(
				createEvent(campaign.id, "director.started", `Director is proposing ${count} experiments`, "director", [
					campaign.id,
				]),
			);
		});
		this.changed();
		const proposals = await proposeIdeas({ repoRoot: this.repoRoot, state, campaign, count });
		for (const proposal of proposals) {
			await this.store.addIdea(campaign.id, proposal, "director");
		}
		this.changed();
	}

	private async runIdea(campaign: Campaign, idea: Idea): Promise<void> {
		const experimentId = makeId("experiment");
		const workerId = makeId("worker");
		let session: AgentSession | undefined;
		try {
			const initialState = await this.store.read();
			const storedCampaign = initialState.campaigns.find((candidate) => candidate.id === campaign.id);
			const champion = initialState.experiments.find(
				(candidate) => candidate.id === storedCampaign?.championExperimentId,
			);
			const git = await createExperimentWorktree({
				repoRoot: this.repoRoot,
				campaignId: campaign.id,
				ideaId: idea.id,
				title: idea.title,
				experimentId,
				baseRef: champion?.commit,
			});
			const timestamp = now();
			const experiment: Experiment = {
				id: experimentId,
				campaignId: campaign.id,
				ideaId: idea.id,
				status: "preparing",
				branch: git.branch,
				worktree: git.worktree,
				baseCommit: git.baseCommit,
				startedAt: timestamp,
				updatedAt: timestamp,
			};
			await this.store.update((state) => {
				const storedIdea = state.ideas.find((candidate) => candidate.id === idea.id);
				if (!storedIdea) {
					throw new Error(`Idea ${idea.id} not found.`);
				}
				storedIdea.status = "running";
				storedIdea.updatedAt = timestamp;
				state.experiments.push(experiment);
				state.events.push(
					createEvent(campaign.id, "experiment.started", `Experiment started: ${idea.title}`, "worker", [
						idea.id,
						experimentId,
					]),
				);
			});

			const created = await createAgentSession({
				cwd: git.worktree,
				sessionManager: SessionManager.create(git.worktree),
			});
			session = created.session;
			const worker: ActiveWorker = {
				session,
				snapshot: {
					id: workerId,
					ideaId: idea.id,
					experimentId,
					label: idea.title,
					status: "running",
					activity: "Reading the experiment brief",
					startedAt: timestamp,
				},
			};
			this.activeWorkers.set(workerId, worker);
			const unsubscribe = session.subscribe((event) => {
				const activity = activityFor(event);
				if (activity) {
					worker.snapshot.activity = activity;
					this.changed();
				}
			});
			await this.store.update((state) => {
				const stored = state.experiments.find((candidate) => candidate.id === experimentId);
				if (stored) {
					stored.status = "running";
					stored.updatedAt = now();
				}
			});
			this.changed();
			await session.prompt(workerPrompt(campaign, idea, await this.store.read()));
			unsubscribe();

			if (this.abortedWorkers.has(workerId)) {
				throw new Error("Experiment aborted by operator.");
			}
			worker.snapshot.status = "evaluating";
			worker.snapshot.activity = "Snapshotting branch";
			await this.store.update((state) => {
				const stored = state.experiments.find((candidate) => candidate.id === experimentId);
				if (stored) {
					stored.status = "evaluating";
					stored.updatedAt = now();
				}
			});
			this.changed();
			const gitSnapshot = await snapshotExperiment(git.worktree, idea.title);
			worker.snapshot.activity = "Running deterministic evaluator";
			const evaluation = await runEvaluator(campaign.config.evaluator, git.worktree);
			await this.store.update((state) => {
				const storedCampaign = state.campaigns.find((candidate) => candidate.id === campaign.id);
				const storedIdea = state.ideas.find((candidate) => candidate.id === idea.id);
				const stored = state.experiments.find((candidate) => candidate.id === experimentId);
				if (!storedCampaign || !storedIdea || !stored) {
					throw new Error("Experiment state disappeared during evaluation.");
				}
				stored.status = "completed";
				stored.updatedAt = now();
				stored.finishedAt = now();
				stored.commit = gitSnapshot.commit;
				stored.diffStat = gitSnapshot.diffStat;
				stored.evaluation = evaluation;
				storedIdea.status = "evaluated";
				storedIdea.updatedAt = now();
				const incumbent = state.experiments.find(
					(candidate) => candidate.id === storedCampaign.championExperimentId,
				);
				if (!incumbent?.evaluation || isBetterScore(storedCampaign, evaluation.score, incumbent.evaluation.score)) {
					storedCampaign.championExperimentId = stored.id;
				}
				storedCampaign.updatedAt = now();
				state.events.push(
					createEvent(
						campaign.id,
						"experiment.measured",
						`${idea.title}: ${evaluation.score} ${campaign.metric.name}`,
						"evaluator",
						[idea.id, experimentId],
					),
				);
			});
		} catch (error) {
			const message = errorMessage(error);
			await this.store.update((state) => {
				const storedIdea = state.ideas.find((candidate) => candidate.id === idea.id);
				const stored = state.experiments.find((candidate) => candidate.id === experimentId);
				if (storedIdea) {
					storedIdea.status = "failed";
					storedIdea.updatedAt = now();
				}
				if (stored) {
					stored.status = this.abortedWorkers.has(workerId) ? "aborted" : "failed";
					stored.error = message;
					stored.finishedAt = now();
					stored.updatedAt = now();
				}
				state.events.push(
					createEvent(campaign.id, "experiment.failed", `${idea.title}: ${message}`, "system", [
						idea.id,
						experimentId,
					]),
				);
			});
		} finally {
			session?.dispose();
			this.activeWorkers.delete(workerId);
			this.abortedWorkers.delete(workerId);
			this.changed();
		}
	}
}
