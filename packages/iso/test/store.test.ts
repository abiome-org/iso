import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildIdeaGraph } from "../src/graph.ts";
import { createEvent, IdempotencyConflictError, IsoStore } from "../src/store.ts";
import type { CampaignCreateInput } from "../src/types.ts";

function campaignInput(): CampaignCreateInput {
	const measuredAt = new Date().toISOString();
	return {
		goal: "Improve the score",
		metric: { name: "score", direction: "maximize", minimumImprovement: 1 },
		config: {
			workers: 2,
			agentTimeoutMs: 30_000,
			evaluator: {
				command: "node evaluator.mjs",
				controlCwd: "/trusted/control",
				samples: 3,
				warmups: 0,
				timeoutMs: 10_000,
				protectedPaths: ["evaluator.mjs"],
			},
			budget: {
				maxGenerations: 3,
				maxExperiments: 6,
				maxWallClockMs: 60_000,
				maxConsecutivePlateaus: 2,
				maxFailures: 3,
			},
		},
		sourceCommit: "a".repeat(40),
		evaluatorDigest: "digest",
		baseline: {
			commit: "a".repeat(40),
			evaluatorDigest: "digest",
			evaluation: {
				score: { mean: 10, median: 10, stddev: 0, min: 10, max: 10 },
				metrics: {},
				samples: [
					{
						score: 10,
						metrics: {},
						valid: true,
						constraints: {},
						durationMs: 1,
						stdout: 'ISO_RESULT {"score":10}',
						stderr: "",
					},
				],
				valid: true,
				failedConstraints: [],
				measuredAt,
			},
		},
	};
}

test("persists schema-v2 campaigns, event history, and idea lineage", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-"));
	const store = new IsoStore(root);
	try {
		const campaign = await store.initialize(campaignInput());
		const generationId = "generation_test";
		const parent = await store.addIdea(
			campaign.id,
			generationId,
			{
				title: "Parent",
				hypothesis: "The parent should help",
				rationale: "It removes redundant work",
				implementationPlan: "Change one thing",
				predictedEffect: "Increase score by two",
				strategy: "explore",
			},
			"human",
		);
		const child = await store.addIdea(
			campaign.id,
			generationId,
			{
				title: "Child",
				hypothesis: "The child should help more",
				rationale: "It compounds the parent mechanism",
				implementationPlan: "Build on the parent",
				predictedEffect: "Increase score by four",
				strategy: "exploit",
				parentIdeaIds: [parent.id],
			},
			"planner",
		);

		const state = await store.read();
		const graph = buildIdeaGraph(state, campaign.id);
		assert.equal(state.schemaVersion, 2);
		assert.equal(state.ideas.length, 2);
		assert.equal(state.events.length, 3);
		assert.deepEqual(
			state.events.map((event) => event.sequence),
			[1, 2, 3],
		);
		assert.ok(
			graph.edges.some((edge) => edge.from === parent.id && edge.to === child.id && edge.kind === "derived-from"),
		);
	} finally {
		store.close();
		await rm(root, { recursive: true });
	}
});

test("serializes cross-instance updates without losing state or events", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-concurrent-"));
	const left = new IsoStore(root);
	const right = new IsoStore(root);
	try {
		const campaign = await left.initialize(campaignInput());
		const updates = Array.from({ length: 40 }, (_, index) => {
			const store = index % 2 === 0 ? left : right;
			return store.update((state) => {
				const stored = state.campaigns.find((candidate) => candidate.id === campaign.id);
				assert.ok(stored);
				stored.failures += 1;
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						type: "test.concurrent-update",
						summary: `Update ${index}`,
						actor: "system",
						refs: [String(index)],
					}),
				);
			});
		});
		await Promise.all(updates);

		const state = await left.read();
		assert.equal(state.campaigns[0].failures, 40);
		assert.equal(state.revision, 41);
		assert.equal(state.events.filter((event) => event.type === "test.concurrent-update").length, 40);
		assert.equal(new Set(state.events.map((event) => event.id)).size, state.events.length);
	} finally {
		left.close();
		right.close();
		await rm(root, { recursive: true });
	}
});

test("persists the exact research model policy and agent-attempt ledger across reopen", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-agent-policy-"));
	const first = new IsoStore(root);
	let firstIsOpen = true;
	try {
		const input = campaignInput();
		input.config.agentModel = {
			provider: "openai-codex",
			model: "gpt-5.4",
			thinkingLevel: "high",
		};
		const campaign = await first.initialize(input);
		await first.update((state) => {
			state.agentCallAttempts.push({
				id: "agent-call-persisted",
				campaignId: campaign.id,
				generationId: "generation-persisted",
				role: "planner",
				attempt: 1,
				status: "failed",
				provider: "openai-codex",
				model: "gpt-5.4",
				thinkingLevel: "high",
				inputTokens: 123,
				outputTokens: 7,
				costUsd: 0.25,
				missingTokenAccounting: false,
				missingCostAccounting: false,
				error: "provider request failed",
				startedAt: "2026-01-01T00:00:00.000Z",
				finishedAt: "2026-01-01T00:00:01.000Z",
			});
		});
		first.close();
		firstIsOpen = false;

		const reopened = new IsoStore(root);
		try {
			const state = await reopened.read();
			assert.deepEqual(state.campaigns[0].config.agentModel, input.config.agentModel);
			assert.equal(state.agentCallAttempts.length, 1);
			assert.equal(state.agentCallAttempts[0].status, "failed");
			assert.equal(state.agentCallAttempts[0].inputTokens, 123);
		} finally {
			reopened.close();
		}
	} finally {
		if (firstIsOpen) {
			first.close();
		}
		await rm(root, { recursive: true });
	}
});

test("rejects duplicate active campaigns and enforces a single orchestration lease", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-lease-"));
	const left = new IsoStore(root);
	const right = new IsoStore(root);
	try {
		await left.initialize(campaignInput());
		await assert.rejects(right.initialize(campaignInput()), /already has active campaign/);

		assert.equal(left.tryAcquireLease("orchestrator", "left", 30_000), true);
		assert.equal(right.tryAcquireLease("orchestrator", "right", 30_000), false);
		left.releaseLease("orchestrator", "left");
		assert.equal(right.tryAcquireLease("orchestrator", "right", 30_000), true);
	} finally {
		left.releaseLease("orchestrator", "left");
		right.releaseLease("orchestrator", "right");
		left.close();
		right.close();
		await rm(root, { recursive: true });
	}
});

test("replays completed idempotent commands without repeating their side effect", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-command-"));
	const store = new IsoStore(root);
	let executions = 0;
	try {
		const first = await store.executeOnce("create-campaign", async () => {
			executions += 1;
			return { id: "campaign_once" };
		});
		const second = await store.executeOnce("create-campaign", async () => {
			executions += 1;
			return { id: "campaign_twice" };
		});
		assert.deepEqual(first, { id: "campaign_once" });
		assert.deepEqual(second, first);
		assert.equal(executions, 1);
	} finally {
		store.close();
		await rm(root, { recursive: true });
	}
});

test("coalesces concurrent calls with the same idempotency key", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-command-concurrent-"));
	const store = new IsoStore(root);
	let executions = 0;
	try {
		const execute = async (): Promise<{ execution: number }> => {
			executions += 1;
			const execution = executions;
			await new Promise<void>((resolveExecution) => {
				setTimeout(resolveExecution, 25);
			});
			return { execution };
		};
		const [first, second] = await Promise.all([
			store.executeOnce("concurrent-command", execute),
			store.executeOnce("concurrent-command", execute),
		]);

		assert.equal(executions, 1);
		assert.deepEqual(first, { execution: 1 });
		assert.deepEqual(second, first);
	} finally {
		store.close();
		await rm(root, { recursive: true });
	}
});

test("updateOnce commits state, events, revision, and receipt atomically across restart", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-update-once-"));
	let store = new IsoStore(root);
	let storeOpen = true;
	try {
		const campaign = await store.initialize(campaignInput());
		const before = await store.read();
		await assert.rejects(
			store.updateOnce("atomic-control", "fingerprint-one", ({ state }) => {
				const stored = state.campaigns.find((candidate) => candidate.id === campaign.id);
				assert.ok(stored);
				stored.failures += 1;
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						type: "test.atomic-control",
						summary: "This transaction must roll back",
						actor: "human",
					}),
				);
				throw new Error("simulated crash before commit");
			}),
			/simulated crash before commit/u,
		);
		const rolledBack = await store.read();
		assert.equal(rolledBack.revision, before.revision);
		assert.equal(rolledBack.campaigns[0].failures, 0);
		assert.equal(
			rolledBack.events.some((event) => event.type === "test.atomic-control"),
			false,
		);

		const committed = await store.updateOnce("atomic-control", "fingerprint-one", ({ state, nextRevision }) => {
			const stored = state.campaigns.find((candidate) => candidate.id === campaign.id);
			assert.ok(stored);
			stored.failures += 1;
			state.events.push(
				createEvent({
					campaignId: campaign.id,
					type: "test.atomic-control",
					summary: "Committed exactly once",
					actor: "human",
				}),
			);
			return { campaignId: campaign.id, revision: nextRevision };
		});
		assert.equal(committed.replayed, false);
		assert.equal(committed.value.revision, before.revision + 1);
		store.close();
		storeOpen = false;

		store = new IsoStore(root);
		storeOpen = true;
		let replayMutationRan = false;
		const replayed = await store.updateOnce("atomic-control", "fingerprint-one", () => {
			replayMutationRan = true;
			return { campaignId: "wrong", revision: -1 };
		});
		assert.equal(replayed.replayed, true);
		assert.deepEqual(replayed.value, committed.value);
		assert.equal(replayMutationRan, false);
		const afterReplay = await store.read();
		assert.equal(afterReplay.campaigns[0].failures, 1);
		assert.equal(afterReplay.events.filter((event) => event.type === "test.atomic-control").length, 1);
		assert.equal(afterReplay.revision, before.revision + 1);

		await assert.rejects(
			store.updateOnce("atomic-control", "fingerprint-two", () => ({ conflicting: true })),
			(error: unknown) => error instanceof IdempotencyConflictError && error.idempotencyKey === "atomic-control",
		);
		assert.equal((await store.read()).revision, before.revision + 1);
	} finally {
		if (storeOpen) {
			store.close();
		}
		await rm(root, { recursive: true });
	}
});

test("updateOnce serializes the same command across store instances", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-update-once-concurrent-"));
	const left = new IsoStore(root);
	const right = new IsoStore(root);
	let executions = 0;
	try {
		const campaign = await left.initialize(campaignInput());
		const execute = (store: IsoStore, label: string) =>
			store.updateOnce("shared-atomic-control", "shared-fingerprint", ({ state, nextRevision }) => {
				executions += 1;
				const stored = state.campaigns.find((candidate) => candidate.id === campaign.id);
				assert.ok(stored);
				stored.failures += 1;
				return { winner: label, revision: nextRevision };
			});
		const [first, second] = await Promise.all([execute(left, "left"), execute(right, "right")]);

		assert.equal(executions, 1);
		assert.deepEqual(first.value, second.value);
		assert.equal([first.replayed, second.replayed].filter(Boolean).length, 1);
		const state = await left.read();
		assert.equal(state.campaigns[0].failures, 1);
		assert.equal(state.revision, 2);
	} finally {
		left.close();
		right.close();
		await rm(root, { recursive: true });
	}
});

test("paginates the complete event ledger independently of the snapshot window", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-events-page-"));
	const store = new IsoStore(root);
	try {
		const campaign = await store.initialize(campaignInput());
		await store.update((state) => {
			for (let index = 0; index < 75; index += 1) {
				state.events.push(
					createEvent({
						campaignId: campaign.id,
						type: "test.page",
						summary: `Event ${index}`,
						actor: "system",
						refs: [String(index)],
					}),
				);
			}
		});
		const first = store.queryEvents({ campaignId: campaign.id, limit: 50 });
		assert.equal(first.events.length, 50);
		assert.ok(first.nextSequence);
		const second = store.queryEvents({
			campaignId: campaign.id,
			afterSequence: first.nextSequence,
			limit: 50,
		});
		assert.equal(second.events.length, 26);
		assert.equal(second.nextSequence, undefined);
		assert.equal(new Set([...first.events, ...second.events].map((event) => event.id)).size, 76);
	} finally {
		store.close();
		await rm(root, { recursive: true });
	}
});

test("rejects a symlinked ISO state directory", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-symlink-"));
	const target = await mkdtemp(join(tmpdir(), "iso-store-symlink-target-"));
	try {
		await mkdir(target, { recursive: true });
		await symlink(target, join(root, ".iso"));
		assert.throws(() => new IsoStore(root), /must be a real directory, not a symlink/);
	} finally {
		await rm(root, { recursive: true });
		await rm(target, { recursive: true });
	}
});
