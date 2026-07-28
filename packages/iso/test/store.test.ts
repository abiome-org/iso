import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildIdeaGraph } from "../src/graph.ts";
import { IsoStore } from "../src/store.ts";

test("persists campaigns and idea lineage", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-"));
	try {
		const store = new IsoStore(root);
		const campaign = await store.initialize({
			goal: "Improve the score",
			metric: { name: "score", direction: "maximize" },
			config: { evaluator: "true", defaultIterations: 2, defaultWorkers: 3 },
		});
		const parent = await store.addIdea(
			campaign.id,
			{
				title: "Parent",
				hypothesis: "The parent should help",
				implementationPlan: "Change one thing",
			},
			"human",
		);
		const child = await store.addIdea(
			campaign.id,
			{
				title: "Child",
				hypothesis: "The child should help more",
				implementationPlan: "Build on the parent",
				parentIdeaIds: [parent.id],
			},
			"director",
		);
		const state = await store.read();
		const graph = buildIdeaGraph(state, campaign.id);
		assert.equal(state.ideas.length, 2);
		assert.ok(
			graph.edges.some((edge) => edge.from === parent.id && edge.to === child.id && edge.kind === "derived-from"),
		);
	} finally {
		await rm(root, { recursive: true });
	}
});
