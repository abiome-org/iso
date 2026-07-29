import type { Campaign, GraphEdge, GraphNode, IdeaGraph, IsoState } from "./types.ts";

export function isBetterScore(campaign: Campaign, candidate: number, incumbent: number): boolean {
	return campaign.metric.direction === "maximize" ? candidate > incumbent : candidate < incumbent;
}

export function buildIdeaGraph(state: IsoState, campaignId?: string): IdeaGraph {
	const campaigns = campaignId ? state.campaigns.filter((campaign) => campaign.id === campaignId) : state.campaigns;
	const campaignIds = new Set(campaigns.map((campaign) => campaign.id));
	const generations = state.generations.filter((generation) => campaignIds.has(generation.campaignId));
	const generationIds = new Set(generations.map((generation) => generation.id));
	const ideas = state.ideas.filter((idea) => campaignIds.has(idea.campaignId));
	const ideaIds = new Set(ideas.map((idea) => idea.id));
	const experiments = state.experiments.filter((experiment) => ideaIds.has(experiment.ideaId));
	const reflections = state.reflections.filter((reflection) => generationIds.has(reflection.generationId));
	const nodes: GraphNode[] = campaigns.map((campaign) => ({
		id: campaign.id,
		kind: "campaign",
		label: campaign.goal,
		status: campaign.status,
	}));
	const edges: GraphEdge[] = [];

	for (const generation of generations) {
		nodes.push({
			id: generation.id,
			kind: "generation",
			label: `Generation ${generation.index}`,
			status: generation.status,
		});
		edges.push({
			id: `${generation.campaignId}:${generation.id}:contains`,
			from: generation.campaignId,
			to: generation.id,
			kind: "contains",
		});
	}

	for (const idea of ideas) {
		nodes.push({
			id: idea.id,
			kind: "idea",
			label: idea.title,
			status: idea.status,
		});
		edges.push({
			id: `${idea.generationId}:${idea.id}:proposes`,
			from: idea.generationId,
			to: idea.id,
			kind: "proposes",
		});
		for (const parentId of idea.parentIdeaIds) {
			if (ideaIds.has(parentId)) {
				edges.push({
					id: `${parentId}:${idea.id}:derived`,
					from: parentId,
					to: idea.id,
					kind: "derived-from",
				});
			}
		}
	}

	for (const experiment of experiments) {
		nodes.push({
			id: experiment.id,
			kind: "experiment",
			label: experiment.branch,
			status: experiment.status,
		});
		edges.push({
			id: `${experiment.ideaId}:${experiment.id}:tests`,
			from: experiment.ideaId,
			to: experiment.id,
			kind: "tests",
		});
		if (experiment.evaluation) {
			const resultId = `result_screen_${experiment.id}`;
			const score = experiment.evaluation.score.mean;
			nodes.push({
				id: resultId,
				kind: "result",
				label: `Exploratory screen: ${score}`,
				status: !experiment.evaluation.valid
					? "screening-invalid"
					: experiment.screeningPassed
						? "screening-passed"
						: "screening-rejected",
				score,
			});
			edges.push({
				id: `${experiment.id}:${resultId}:produces`,
				from: experiment.id,
				to: resultId,
				kind: "produces",
			});
		}
		const confirmation = experiment.confirmationHistory?.at(-1);
		if (confirmation) {
			const resultId = `result_confirmation_${experiment.id}`;
			nodes.push({
				id: resultId,
				kind: "result",
				label: confirmation.confirmed
					? `Confirmed promotion: ${confirmation.candidateMean}`
					: `Confirmation rejected: ${confirmation.candidateMean}`,
				status: confirmation.confirmed ? "confirmed-promotion" : "confirmation-rejection",
				score: confirmation.candidateMean,
			});
			edges.push({
				id: `${experiment.id}:${resultId}:produces`,
				from: experiment.id,
				to: resultId,
				kind: "produces",
			});
		}
	}

	for (const reflection of reflections) {
		nodes.push({
			id: reflection.id,
			kind: "reflection",
			label: reflection.summary,
			status: "recorded",
		});
		edges.push({
			id: `${reflection.id}:${reflection.generationId}:reflects`,
			from: reflection.id,
			to: reflection.generationId,
			kind: "reflects-on",
		});
	}

	for (const campaign of campaigns) {
		if (campaign.championExperimentId) {
			edges.push({
				id: `${campaign.id}:${campaign.championExperimentId}:champions`,
				from: campaign.id,
				to: campaign.championExperimentId,
				kind: "champions",
			});
		}
	}

	return { nodes, edges };
}
