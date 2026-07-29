import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KernelClient, KernelRemoteError } from "../src/client.ts";
import { runKernel } from "../src/kernel.ts";
import { IsoRuntime } from "../src/runtime.ts";
import { IsoStore } from "../src/store.ts";
import type { CampaignCreateInput, CampaignRunIntent } from "../src/types.ts";

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

async function waitForKernel(client: KernelClient): Promise<void> {
	const deadline = Date.now() + 5_000;
	let lastError: unknown;
	while (Date.now() < deadline) {
		try {
			await client.request("ping", undefined, { timeoutMs: 250 });
			return;
		} catch (error) {
			lastError = error;
			await delay(20);
		}
	}
	throw new Error("Kernel did not become ready.", { cause: lastError });
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 2_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await delay(10);
	}
}

async function settleKernel(client: KernelClient, kernel: Promise<void>): Promise<void> {
	await client.request("shutdown", {}, { requestId: `cleanup-${Date.now()}`, timeoutMs: 500 }).catch(() => undefined);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	try {
		await Promise.race([
			kernel,
			new Promise<never>((_resolve, reject) => {
				timeout = setTimeout(() => {
					reject(new Error("Kernel did not terminate during test cleanup."));
				}, 2_000);
			}),
		]);
	} finally {
		if (timeout) {
			clearTimeout(timeout);
		}
	}
}

function storedCampaignInput(root: string): CampaignCreateInput {
	const commit = "a".repeat(40);
	const measuredAt = new Date().toISOString();
	return {
		goal: "Resume one durable research conversation",
		metric: { name: "score", direction: "maximize", minimumImprovement: 1 },
		config: {
			workers: 1,
			agentTimeoutMs: 10_000,
			evaluator: {
				command: "exec node evaluator.mjs",
				controlCwd: root,
				samples: 2,
				warmups: 0,
				timeoutMs: 10_000,
				protectedPaths: ["evaluator.mjs"],
			},
			budget: {
				maxGenerations: 1,
				maxExperiments: 1,
				maxWallClockMs: 60_000,
				maxConsecutivePlateaus: 1,
				maxFailures: 2,
			},
		},
		sourceCommit: commit,
		evaluatorDigest: "digest",
		baseline: {
			commit,
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

test("kernel shutdown is idempotent and waits for runtime quiescence", { timeout: 10_000 }, async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-kernel-shutdown-"));
	const client = new KernelClient(root);
	const originalShutdown = IsoRuntime.prototype.shutdown;
	const originalExitCode = process.exitCode;
	let releaseQuiescence = (): void => {};
	const quiescence = new Promise<void>((resolve) => {
		releaseQuiescence = resolve;
	});
	let shutdownCalls = 0;
	let firstSettled = false;
	let secondSettled = false;
	let kernel: Promise<void> | undefined;

	IsoRuntime.prototype.shutdown = async function shutdownAfterQuiescence(): Promise<void> {
		shutdownCalls += 1;
		await quiescence;
		await originalShutdown.call(this);
	};

	try {
		kernel = runKernel(root);
		await waitForKernel(client);
		const first = client
			.request<{ shuttingDown: boolean }>("shutdown", {}, { requestId: "shutdown-one" })
			.then((result) => {
				firstSettled = true;
				return result;
			});
		const second = client
			.request<{ shuttingDown: boolean }>("shutdown", {}, { requestId: "shutdown-two" })
			.then((result) => {
				secondSettled = true;
				return result;
			});

		await waitFor(() => shutdownCalls === 1, "Kernel did not begin runtime shutdown.");
		await delay(30);
		assert.equal(firstSettled, false);
		assert.equal(secondSettled, false);

		releaseQuiescence();
		const results = await Promise.all([first, second]);
		await kernel;

		assert.deepEqual(results, [{ shuttingDown: true }, { shuttingDown: true }]);
		assert.equal(shutdownCalls, 1);
		assert.equal(process.exitCode, originalExitCode);
	} finally {
		releaseQuiescence();
		if (kernel) {
			await settleKernel(client, kernel);
		}
		IsoRuntime.prototype.shutdown = originalShutdown;
		await rm(root, { force: true, recursive: true });
	}
});

test("kernel auto-start is controlled only by durable campaign run intent", async (context) => {
	const originalResume = IsoRuntime.prototype.resumePersistedResearch;
	let startCalls = 0;
	IsoRuntime.prototype.resumePersistedResearch = async function recordAutomaticStart() {
		startCalls += 1;
		return { runId: "recovered-test-run", started: true };
	};

	try {
		const cases: Array<{ intent: CampaignRunIntent; expectedStarts: number }> = [
			{ intent: "running", expectedStarts: 1 },
			{ intent: "paused", expectedStarts: 0 },
		];
		for (const item of cases) {
			await context.test(item.intent, async () => {
				const root = await mkdtemp(join(tmpdir(), `iso-kernel-intent-${item.intent}-`));
				const client = new KernelClient(root);
				const store = new IsoStore(root);
				let kernel: Promise<void> | undefined;
				const startsBefore = startCalls;
				try {
					await store.initialize(storedCampaignInput(root));
					await store.update((state) => {
						state.campaigns[0].runIntent = item.intent;
					});
					store.close();
					kernel = runKernel(root);
					await waitForKernel(client);
					if (item.expectedStarts > 0) {
						await waitFor(
							() => startCalls - startsBefore === item.expectedStarts,
							"Kernel did not honor the persisted running intent.",
						);
					} else {
						await delay(50);
						assert.equal(startCalls - startsBefore, 0);
					}
					const status = await client.request<{
						activeCampaign?: { runIntent?: CampaignRunIntent };
					}>("status");
					assert.equal(status.activeCampaign?.runIntent, item.intent);
					await client.request(
						"shutdown",
						{},
						{
							requestId: `shutdown-intent-${item.intent}`,
						},
					);
					await kernel;
				} finally {
					if (kernel) {
						await settleKernel(client, kernel);
					}
					await rm(root, { force: true, recursive: true });
				}
			});
		}
	} finally {
		IsoRuntime.prototype.resumePersistedResearch = originalResume;
	}
});

test("client preserves structured kernel error codes", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-kernel-error-code-"));
	const client = new KernelClient(root);
	let kernel: Promise<void> | undefined;
	try {
		kernel = runKernel(root);
		await waitForKernel(client);
		await assert.rejects(
			client.request("query", {}),
			(error: unknown) =>
				error instanceof KernelRemoteError &&
				error.code === "invalid_payload" &&
				error.message === "kind must be a non-empty string of at most 20 bytes.",
		);
	} finally {
		if (kernel) {
			await settleKernel(client, kernel);
		}
		await rm(root, { force: true, recursive: true });
	}
});

test("kernel bounds and validates the optional exact research-agent model policy", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-kernel-agent-model-"));
	const client = new KernelClient(root);
	let kernel: Promise<void> | undefined;
	try {
		kernel = runKernel(root);
		await waitForKernel(client);
		const input = storedCampaignInput(root);
		const payload = {
			goal: input.goal,
			metric: input.metric,
			config: {
				...input.config,
				evaluator: { ...input.config.evaluator, controlCwd: "." },
			},
		};
		await assert.rejects(
			client.request(
				"launch",
				{
					...payload,
					config: {
						...payload.config,
						agentModel: {
							provider: "openai-codex",
							model: "gpt-5.4",
							thinkingLevel: "impossibly-deep",
						},
					},
				},
				{ requestId: "invalid-agent-thinking" },
			),
			(error: unknown) =>
				error instanceof KernelRemoteError &&
				error.code === "invalid_payload" &&
				error.message === "agentModel thinkingLevel must be off, minimal, low, medium, high, xhigh, or max.",
		);
		await assert.rejects(
			client.request(
				"launch",
				{
					...payload,
					config: {
						...payload.config,
						agentModel: {
							provider: "p".repeat(201),
							model: "gpt-5.4",
							thinkingLevel: "high",
						},
					},
				},
				{ requestId: "oversized-agent-provider" },
			),
			(error: unknown) =>
				error instanceof KernelRemoteError &&
				error.code === "invalid_payload" &&
				error.message === "provider must be a non-empty string of at most 200 bytes.",
		);
		await assert.rejects(
			client.request(
				"launch",
				{
					...payload,
					preflightId: "preflight_partial",
				},
				{ requestId: "partial-conversational-launch" },
			),
			(error: unknown) =>
				error instanceof KernelRemoteError &&
				error.code === "invalid_payload" &&
				error.message ===
					"Conversational launch identity requires preflightId, attemptId, launchOperationId, and inputDigest together.",
		);
	} finally {
		if (kernel) {
			await settleKernel(client, kernel);
		}
		await rm(root, { force: true, recursive: true });
	}
});

test("kernel control receipts bind canonical payloads behind maximum wire IDs", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-kernel-control-receipt-"));
	const store = new IsoStore(root);
	const client = new KernelClient(root);
	let kernel: Promise<void> | undefined;
	try {
		await store.initialize(storedCampaignInput(root));
		await store.update((state) => {
			state.campaigns[0].status = "paused";
			state.campaigns[0].runIntent = "paused";
		});
		store.close();
		kernel = runKernel(root);
		await waitForKernel(client);
		const maximumWireId = "n".repeat(200);
		const first = await client.request<{
			note: { id: string; message: string; status: string };
		}>("note", { message: "  retain the canonical evidence  " }, { requestId: maximumWireId });
		const replayed = await client.request<{
			note: { id: string; message: string; status: string };
		}>("note", { message: "retain the canonical evidence" }, { requestId: maximumWireId });
		assert.deepEqual(replayed, first);
		assert.equal(first.note.message, "retain the canonical evidence");
		assert.equal(first.note.status, "queued");
		const status = await client.request<Awaited<ReturnType<IsoRuntime["snapshot"]>>>("status");
		assert.equal(status.state.operatorNotes.length, 1);
		assert.equal(status.state.events.filter((event) => event.type === "operator.note-queued").length, 1);
		await assert.rejects(
			client.request("note", { message: "a different instruction" }, { requestId: maximumWireId }),
			(error: unknown) => error instanceof KernelRemoteError && error.code === "idempotency_conflict",
		);

		const stopId = "s".repeat(200);
		const stopped = await client.request<{ stopped: boolean }>(
			"stop",
			{ reason: "terminal receipt" },
			{ requestId: stopId },
		);
		assert.deepEqual(stopped, { stopped: true });
		const terminalStatus = await client.request<Awaited<ReturnType<IsoRuntime["snapshot"]>>>("status");
		const replayedStop = await client.request<{ stopped: boolean }>(
			"stop",
			{ reason: " terminal receipt " },
			{ requestId: stopId },
		);
		assert.deepEqual(replayedStop, stopped);
		assert.equal(
			(await client.request<Awaited<ReturnType<IsoRuntime["snapshot"]>>>("status")).state.revision,
			terminalStatus.state.revision,
		);
	} finally {
		if (kernel) {
			await settleKernel(client, kernel);
		}
		await rm(root, { force: true, recursive: true });
	}
});
