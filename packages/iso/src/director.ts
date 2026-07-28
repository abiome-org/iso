import { createAgentSession, SessionManager } from "@earendil-works/pi-coding-agent";
import type { Campaign, IsoState, ProposedIdea } from "./types.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseIdeas(text: string): ProposedIdea[] {
	const markerIndex = text.lastIndexOf("ISO_IDEAS");
	const candidate = markerIndex >= 0 ? text.slice(markerIndex + "ISO_IDEAS".length) : text;
	const start = candidate.indexOf("[");
	const end = candidate.lastIndexOf("]");
	if (start === -1 || end === -1 || end <= start) {
		throw new Error("Director did not return an ISO_IDEAS JSON array.");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(candidate.slice(start, end + 1));
	} catch {
		throw new Error("Director returned malformed ISO_IDEAS JSON.");
	}
	if (!Array.isArray(parsed)) {
		throw new Error("Director output must be an array.");
	}
	const ideas: ProposedIdea[] = [];
	for (const value of parsed) {
		if (
			!isRecord(value) ||
			typeof value.title !== "string" ||
			typeof value.hypothesis !== "string" ||
			typeof value.implementationPlan !== "string"
		) {
			continue;
		}
		const parentIdeaIds = Array.isArray(value.parentIdeaIds)
			? value.parentIdeaIds.filter((item): item is string => typeof item === "string")
			: undefined;
		ideas.push({
			title: value.title.trim(),
			hypothesis: value.hypothesis.trim(),
			implementationPlan: value.implementationPlan.trim(),
			parentIdeaIds,
		});
	}
	if (ideas.length === 0) {
		throw new Error("Director returned no usable ideas.");
	}
	return ideas;
}

function researchHistory(state: IsoState, campaign: Campaign): string {
	const ideas = state.ideas.filter((idea) => idea.campaignId === campaign.id);
	const experiments = state.experiments.filter((experiment) => experiment.campaignId === campaign.id);
	if (ideas.length === 0) {
		return "No experiments have run yet. Start with meaningfully different approaches.";
	}
	return ideas
		.map((idea) => {
			const results = experiments
				.filter((experiment) => experiment.ideaId === idea.id)
				.map((experiment) =>
					experiment.evaluation
						? `${experiment.status}, score=${experiment.evaluation.score}`
						: `${experiment.status}${experiment.error ? `, error=${experiment.error}` : ""}`,
				)
				.join("; ");
			return `- ${idea.id} — ${idea.title}: ${idea.hypothesis}. Results: ${results || "not run"}`;
		})
		.join("\n");
}

export async function proposeIdeas(options: {
	repoRoot: string;
	state: IsoState;
	campaign: Campaign;
	count: number;
}): Promise<ProposedIdea[]> {
	const { session } = await createAgentSession({
		cwd: options.repoRoot,
		tools: ["read", "grep", "find", "ls"],
		excludeTools: ["bash", "edit", "write"],
		sessionManager: SessionManager.inMemory(options.repoRoot),
	});
	try {
		await session.prompt(`You are ISO's research director. Your only job is to propose the next ${options.count}
high-information coding experiments for the repository in your current directory.

Research goal: ${options.campaign.goal}
Objective: ${options.campaign.metric.direction} ${options.campaign.metric.name}
Evaluator command: ${options.campaign.config.evaluator}

Existing idea and experiment history:
${researchHistory(options.state, options.campaign)}

Inspect the code using read-only tools. Prefer diverse hypotheses, learn from negative results, and make
each proposal independently executable in a git worktree. If a proposal builds on a prior idea,
include that idea's id in parentIdeaIds. Do not edit files or run commands.

End with exactly:
ISO_IDEAS
[
  {
    "title": "short branch-safe title",
    "hypothesis": "falsifiable reason this should improve the metric",
    "implementationPlan": "specific files and changes to try",
    "parentIdeaIds": ["optional prior idea ids"]
  }
]`);
		const text = session.getLastAssistantText();
		if (!text) {
			throw new Error("Director returned no response.");
		}
		return parseIdeas(text).slice(0, options.count);
	} finally {
		session.dispose();
	}
}
