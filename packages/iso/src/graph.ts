import type { Campaign, GraphEdge, GraphNode, IdeaGraph, IsoState } from "./types.ts";

export function isBetterScore(campaign: Campaign, candidate: number, incumbent: number): boolean {
	return campaign.metric.direction === "maximize" ? candidate > incumbent : candidate < incumbent;
}

export function buildIdeaGraph(state: IsoState, campaignId?: string): IdeaGraph {
	const campaigns = campaignId ? state.campaigns.filter((campaign) => campaign.id === campaignId) : state.campaigns;
	const campaignIds = new Set(campaigns.map((campaign) => campaign.id));
	const ideas = state.ideas.filter((idea) => campaignIds.has(idea.campaignId));
	const ideaIds = new Set(ideas.map((idea) => idea.id));
	const experiments = state.experiments.filter((experiment) => ideaIds.has(experiment.ideaId));
	const nodes: GraphNode[] = campaigns.map((campaign) => ({
		id: campaign.id,
		kind: "campaign",
		label: campaign.goal,
		status: campaign.status,
	}));
	const edges: GraphEdge[] = [];

	for (const idea of ideas) {
		nodes.push({
			id: idea.id,
			kind: "idea",
			label: idea.title,
			status: idea.status,
		});
		edges.push({
			id: `${idea.campaignId}:${idea.id}:proposes`,
			from: idea.campaignId,
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
			const resultId = `result_${experiment.id}`;
			nodes.push({
				id: resultId,
				kind: "result",
				label: `${experiment.evaluation.score}`,
				status: "measured",
				score: experiment.evaluation.score,
			});
			edges.push({
				id: `${experiment.id}:${resultId}:produces`,
				from: experiment.id,
				to: resultId,
				kind: "produces",
			});
		}
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
