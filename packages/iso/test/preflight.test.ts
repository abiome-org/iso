import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { KernelClient, KernelRemoteError } from "../src/client.ts";
import { runKernel } from "../src/kernel.ts";
import {
	canonicalPayloadDigest,
	DIRECT_PREFLIGHT_ORPHAN_TTL_MS,
	PreflightError,
	preflightIntentKey,
	preflightLaunchIdentity,
	preflightTurnContentDigest,
} from "../src/preflight.ts";
import { IsoRuntime } from "../src/runtime.ts";
import { IdempotencyConflictError, IsoStore } from "../src/store.ts";
import type { EvaluationAggregate, Experiment, ResearchMissionInput } from "../src/types.ts";

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, milliseconds);
	});
}

function missionInput(goal = "Improve the parser"): ResearchMissionInput {
	const sourceCommit = "a".repeat(40);
	return {
		goal,
		metric: { name: "throughput", direction: "maximize", minimumImprovement: 1 },
		config: {
			workers: 2,
			agentTimeoutMs: 60_000,
			evaluator: {
				command: "node evaluator.mjs",
				controlCwd: ".",
				samples: 2,
				warmups: 0,
				timeoutMs: 10_000,
				protectedPaths: [".iso/evaluators/frozen/test.mjs"],
			},
			budget: {
				maxGenerations: 2,
				maxExperiments: 4,
				maxWallClockMs: 60_000,
				maxConsecutivePlateaus: 2,
				maxFailures: 2,
			},
		},
		sourceCommit,
		sourceHeadCommit: sourceCommit,
		sourceSnapshotRef: `refs/iso/source-snapshots/${sourceCommit}`,
		sourceHadLocalChanges: false,
		sourceSnapshotPaths: [],
		dependencyDigest: "b".repeat(64),
	};
}

function evaluation(score: number, valid = true): EvaluationAggregate {
	const measuredAt = new Date().toISOString();
	return {
		score: { mean: score, median: score, stddev: 0, min: score, max: score },
		metrics: {},
		samples: [
			{
				score,
				metrics: {},
				valid,
				constraints: {},
				durationMs: 1,
				stdout: "",
				stderr: "",
			},
		],
		valid,
		failedConstraints: [],
		measuredAt,
	};
}

async function openReceipt(store: IsoStore, seed: string, objective = `objective-${seed}`) {
	return store.openPreflight({
		intentKey: seed.repeat(64),
		objectiveDigest: preflightTurnContentDigest(objective),
	});
}

function launchRequest(preflightId: string, input: ResearchMissionInput) {
	const identity = preflightLaunchIdentity(preflightId, input);
	return {
		idempotencyKey: `kernel:v1:launch:${identity.requestId}`,
		requestFingerprint: identity.requestFingerprint,
		preflightId,
		launchOperationId: identity.launchOperationId,
		inputDigest: identity.inputDigest,
		input,
	};
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

test("turn identity is transport-stable, branch-aware, ordered-image-aware, and image-only safe", () => {
	const firstImage = { mimeType: "image/png", data: Buffer.from("first").toString("base64") };
	const secondImage = { mimeType: "image/png", data: Buffer.from("second").toString("base64") };
	const content = preflightTurnContentDigest("repeat", [firstImage, secondImage]);
	assert.equal(content, preflightTurnContentDigest("repeat", [firstImage, secondImage]));
	assert.notEqual(content, preflightTurnContentDigest("repeat", [secondImage, firstImage]));
	assert.notEqual(content, preflightTurnContentDigest("repeat"));
	assert.match(preflightTurnContentDigest("", [firstImage]), /^[a-f0-9]{64}$/u);

	const transportRetry = preflightIntentKey("session", "leaf-a", content);
	assert.equal(transportRetry, preflightIntentKey("session", "leaf-a", content));
	assert.notEqual(transportRetry, preflightIntentKey("session", "leaf-b", content));
	assert.notEqual(preflightIntentKey("session-a", "leaf", content), preflightIntentKey("session", "a-leaf", content));
});

test("preflight database stores only digests and resumes needs_input on the same receipt", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-preflight-private-"));
	const secret = "sk-super-secret-expanded-prompt-value";
	const store = new IsoStore(root);
	try {
		const objectiveDigest = preflightTurnContentDigest(`Improve throughput using ${secret}`);
		const attemptId = "attempt_private";
		const sessionDigest = "1".repeat(64);
		const opened = (
			await store.beginPreflightOnce(
				"preflight-private-begin",
				canonicalPayloadDigest("test.private-begin.v1", { objectiveDigest, sessionDigest }),
				{
					intentKey: "c".repeat(64),
					objectiveDigest,
					attemptId,
					sessionDigest,
					leaseTtlMs: 60_000,
				},
			)
		).value;
		const questionDigest = canonicalPayloadDigest("iso.preflight.question.v1", `Please paste password=${secret}`);
		const deferred = await store.deferPreflightOnce(
			"preflight-defer-private",
			canonicalPayloadDigest("test.defer.v1", {
				preflightId: opened.preflightId,
				reason: "credentials",
				questionDigest,
			}),
			{ preflightId: opened.preflightId, reason: "credentials", questionDigest, attemptId },
		);
		assert.equal(deferred.value.preflightId, opened.preflightId);
		assert.equal(deferred.value.state, "needs_input");
		assert.equal(deferred.value.questionDigest, questionDigest);

		const answerDigest = preflightTurnContentDigest(`password=${secret}`);
		const resumed = await store.resumePreflightOnce(
			"preflight-resume-private",
			canonicalPayloadDigest("test.resume.v1", { preflightId: opened.preflightId, answerDigest }),
			{
				preflightId: opened.preflightId,
				answerDigest,
				attemptId: "attempt_private_resume",
				sessionDigest,
				leaseTtlMs: 60_000,
			},
		);
		const replay = await store.resumePreflightOnce(
			"preflight-resume-private",
			canonicalPayloadDigest("test.resume.v1", { preflightId: opened.preflightId, answerDigest }),
			{
				preflightId: opened.preflightId,
				answerDigest,
				attemptId: "attempt_private_resume",
				sessionDigest,
				leaseTtlMs: 60_000,
			},
		);
		assert.equal(resumed.value.preflightId, opened.preflightId);
		assert.equal(resumed.value.answerDigest, answerDigest);
		assert.equal(resumed.value.correctionCount, 1);
		assert.equal(replay.replayed, true);
		assert.equal(replay.value.correctionCount, 1);
		assert.equal("objective" in resumed.value, false);

		store.close();
		const legacyDatabase = new DatabaseSync(join(root, ".iso", "iso.db"));
		legacyDatabase
			.prepare("UPDATE preflight_receipts SET objective = ? WHERE preflight_id = ?")
			.run(`legacy raw ${secret}`, opened.preflightId);
		legacyDatabase.close();
		const reopened = new IsoStore(root);
		try {
			assert.equal(reopened.getPreflight({ preflightId: opened.preflightId })?.answerDigest, answerDigest);
		} finally {
			reopened.close();
		}
		const databaseBytes = await readFile(join(root, ".iso", "iso.db"));
		assert.equal(databaseBytes.includes(Buffer.from(secret)), false);
	} finally {
		try {
			store.close();
		} catch {
			// The store may already be closed for the raw-database inspection.
		}
		await rm(root, { force: true, recursive: true });
	}
});

test("correction receipts are crash-safe, payload-bound, and never double-increment", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-preflight-correction-"));
	let store = new IsoStore(root);
	try {
		const objectiveDigest = preflightTurnContentDigest("objective-d");
		const attemptId = "attempt_correction";
		const opened = (
			await store.beginPreflightOnce(
				"begin-correction",
				canonicalPayloadDigest("test.begin-correction.v1", { objectiveDigest }),
				{
					intentKey: "d".repeat(64),
					objectiveDigest,
					attemptId,
					sessionDigest: "c".repeat(64),
					leaseTtlMs: 60_000,
				},
			)
		).value;
		const input = { preflightId: opened.preflightId, attemptId };
		const fingerprint = canonicalPayloadDigest("test.correct.v1", input);
		const first = await store.correctPreflightOnce("correct-stable", fingerprint, input);
		const replay = await store.correctPreflightOnce("correct-stable", fingerprint, input);
		assert.equal(first.value.correctionCount, 1);
		assert.equal(replay.replayed, true);
		assert.equal(replay.value.correctionCount, 1);
		await assert.rejects(
			store.correctPreflightOnce("correct-stable", "f".repeat(64), input),
			(error: unknown) => error instanceof IdempotencyConflictError,
		);

		store.close();
		store = new IsoStore(root);
		const reopenedReplay = await store.correctPreflightOnce("correct-stable", fingerprint, input);
		assert.equal(reopenedReplay.replayed, true);
		assert.equal(reopenedReplay.value.correctionCount, 1);
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("principal attempt leases make correction continuation and clarification resume crash-safe", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-preflight-attempt-"));
	const store = new IsoStore(root);
	try {
		const attemptId = "attempt_primary";
		const sessionDigest = "a".repeat(64);
		const objectiveDigest = preflightTurnContentDigest("Make the parser faster");
		const begun = await store.beginPreflightOnce(
			"begin-attempt",
			canonicalPayloadDigest("test.begin-attempt.v1", { objectiveDigest }),
			{
				intentKey: "8".repeat(64),
				objectiveDigest,
				attemptId,
				sessionDigest,
				leaseTtlMs: 60_000,
			},
		);
		await assert.rejects(
			store.correctPreflightOnce(
				"wrong-attempt",
				canonicalPayloadDigest("test.wrong-attempt.v1", begun.value.preflightId),
				{ preflightId: begun.value.preflightId, attemptId: "attempt_stale" },
			),
			(error: unknown) => error instanceof PreflightError && error.code === "preflight_conflict",
		);
		const corrected = await store.correctPreflightOnce(
			"owned-correction",
			canonicalPayloadDigest("test.owned-correction.v1", begun.value.preflightId),
			{ preflightId: begun.value.preflightId, attemptId },
		);
		assert.equal(corrected.value.correctionCount, 1);
		assert.equal(
			store.getPendingPreflightContinuation({ sessionDigest })?.receipt.preflightId,
			begun.value.preflightId,
		);
		await store.claimPreflightOnce(
			"reclaim-continuation",
			canonicalPayloadDigest("test.reclaim-continuation.v1", begun.value.preflightId),
			{
				preflightId: begun.value.preflightId,
				attemptId,
				sessionDigest,
				leaseTtlMs: 60_000,
			},
		);
		assert.equal(store.getPendingPreflightContinuation({ sessionDigest }), undefined);

		const questionDigest = canonicalPayloadDigest("test.question.v1", "Which benchmark?");
		await store.deferPreflightOnce("owned-defer", canonicalPayloadDigest("test.owned-defer.v1", questionDigest), {
			preflightId: begun.value.preflightId,
			reason: "metric_ambiguity",
			questionDigest,
			attemptId,
		});
		const answerDigest = preflightTurnContentDigest("Use requests per second");
		const resumed = await store.resumePreflightOnce(
			"atomic-resume",
			canonicalPayloadDigest("test.atomic-resume.v1", answerDigest),
			{
				preflightId: begun.value.preflightId,
				answerDigest,
				attemptId: "attempt_resumed",
				sessionDigest,
				leaseTtlMs: 60_000,
			},
		);
		assert.equal(resumed.value.state, "pending");
		assert.equal(resumed.value.answerDigest, answerDigest);
		await store.renewPreflightAttempt({
			preflightId: begun.value.preflightId,
			attemptId: "attempt_resumed",
			leaseTtlMs: 60_000,
		});
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("expired principal attempts remain pending and are reclaimable only by their stable session", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-preflight-expiry-"));
	let store = new IsoStore(root);
	try {
		const objectiveDigest = preflightTurnContentDigest("Crash during admission");
		const sessionDigest = "b".repeat(64);
		const beginFingerprint = canonicalPayloadDigest("test.begin-expiring.v1", {
			intentKey: "9".repeat(64),
			objectiveDigest,
			sessionDigest,
			leaseTtlMs: 5_000,
		});
		const begun = await store.beginPreflightOnce("begin-expiring-attempt", beginFingerprint, {
			intentKey: "9".repeat(64),
			objectiveDigest,
			attemptId: "attempt_expiring",
			sessionDigest,
			leaseTtlMs: 5_000,
		});
		await assert.rejects(
			store.beginPreflightOnce("begin-expiring-attempt", beginFingerprint, {
				intentKey: "9".repeat(64),
				objectiveDigest,
				attemptId: "attempt_replacement",
				sessionDigest,
				leaseTtlMs: 5_000,
			}),
			(error: unknown) => error instanceof PreflightError && /another live principal attempt/u.test(error.message),
		);
		const released = await store.expirePreflightAttempts(Date.now() + 5_001);
		assert.equal(released.length, 1);
		assert.equal(released[0].preflightId, begun.value.preflightId);
		assert.equal(released[0].state, "pending");
		assert.equal(released[0].failureCode, undefined);
		assert.equal(
			store.getPendingPreflightContinuation({ sessionDigest })?.receipt.preflightId,
			begun.value.preflightId,
		);

		store.close();
		store = new IsoStore(root);
		await assert.rejects(
			store.claimPreflightOnce(
				"wrong-session-reclaim",
				canonicalPayloadDigest("test.wrong-session-reclaim.v1", begun.value.preflightId),
				{
					preflightId: begun.value.preflightId,
					attemptId: "attempt_intruder",
					sessionDigest: "e".repeat(64),
					leaseTtlMs: 5_000,
				},
			),
			(error: unknown) => error instanceof PreflightError && /another principal session/u.test(error.message),
		);
		const reclaimed = await store.beginPreflightOnce("begin-expiring-attempt", beginFingerprint, {
			intentKey: "9".repeat(64),
			objectiveDigest,
			attemptId: "attempt_replacement",
			sessionDigest,
			leaseTtlMs: 5_000,
		});
		assert.equal(reclaimed.replayed, true);
		assert.equal(reclaimed.value.preflightId, begun.value.preflightId);
		assert.equal(reclaimed.value.state, "pending");
		assert.equal(store.getPendingPreflightContinuation({ sessionDigest }), undefined);
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("stale direct orphan cleanup excludes conversational and fresh pending receipts", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-preflight-direct-orphan-"));
	const store = new IsoStore(root);
	try {
		const staleDirect = await openReceipt(store, "4", "stale direct launch");
		const freshDirect = await openReceipt(store, "5", "fresh direct launch");
		const conversational = (
			await store.beginPreflightOnce(
				"begin-conversational-gc-control",
				canonicalPayloadDigest("test.begin-conversational-gc-control.v1", "6".repeat(64)),
				{
					intentKey: "6".repeat(64),
					objectiveDigest: preflightTurnContentDigest("conversational launch"),
					attemptId: "attempt_gc_control",
					sessionDigest: "7".repeat(64),
					leaseTtlMs: 60_000,
				},
			)
		).value;
		const timestamp = Date.now();
		const agedAt = new Date(timestamp - DIRECT_PREFLIGHT_ORPHAN_TTL_MS - 1).toISOString();
		const database = new DatabaseSync(join(root, ".iso", "iso.db"));
		database
			.prepare("UPDATE preflight_receipts SET updated_at = ? WHERE preflight_id IN (?, ?)")
			.run(agedAt, staleDirect.preflightId, conversational.preflightId);
		database.close();

		const failed = await store.failStaleDirectPreflights(timestamp);
		assert.deepEqual(
			failed.map((receipt) => receipt.preflightId),
			[staleDirect.preflightId],
		);
		assert.equal(store.getPreflight({ preflightId: staleDirect.preflightId })?.state, "failed");
		assert.equal(store.getPreflight({ preflightId: staleDirect.preflightId })?.failureCode, "kernel_unavailable");
		assert.equal(store.getPreflight({ preflightId: freshDirect.preflightId })?.state, "pending");
		assert.equal(store.getPreflight({ preflightId: conversational.preflightId })?.state, "pending");
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("legacy experiment normalization derives only exploratory screening and never invents promotion evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-store-legacy-selection-"));
	const store = new IsoStore(root);
	try {
		const input = missionInput("Normalize legacy evidence");
		const baseline = evaluation(10);
		const campaign = await store.initialize({
			...input,
			evaluatorDigest: "e".repeat(64),
			baseline: {
				commit: input.sourceCommit,
				evaluatorDigest: "e".repeat(64),
				evaluation: baseline,
			},
		});
		const timestamp = new Date().toISOString();
		const legacyExperiment = (
			id: string,
			options: {
				changedPaths: string[];
				valid?: boolean;
				improvement: number;
				uncertainty: number;
				confirmed: boolean;
			},
		): Experiment => ({
			id,
			campaignId: campaign.id,
			generationId: "generation_legacy",
			ideaId: "idea_legacy",
			attempt: 1,
			status: "measured",
			baseCommit: input.sourceCommit,
			branch: `iso/${id}`,
			worktree: join(root, id),
			candidateCommit: "b".repeat(40),
			changedPaths: options.changedPaths,
			evaluation: evaluation(10 + options.improvement, options.valid ?? true),
			incumbentEvaluation: baseline,
			improvement: options.improvement,
			uncertainty: options.uncertainty,
			credibleImprovement: true,
			confirmationHistory: options.confirmed
				? [
						{
							round: 1,
							candidateMean: 12,
							incumbentMean: 10,
							improvement: 2,
							uncertainty: 0.5,
							lowerBound: 1.5,
							confirmed: true,
							measuredAt: timestamp,
						},
					]
				: [],
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		await store.update((state) => {
			state.experiments.push(
				legacyExperiment("experiment_screened", {
					changedPaths: ["parser.ts"],
					improvement: 2,
					uncertainty: 0.5,
					confirmed: false,
				}),
				legacyExperiment("experiment_no_diff", {
					changedPaths: [],
					improvement: 2,
					uncertainty: 0.5,
					confirmed: false,
				}),
				legacyExperiment("experiment_confirmed", {
					changedPaths: ["parser.ts"],
					improvement: 2,
					uncertainty: 0.5,
					confirmed: true,
				}),
			);
		});

		const normalized = await store.read();
		const screened = normalized.experiments.find((experiment) => experiment.id === "experiment_screened");
		const noDiff = normalized.experiments.find((experiment) => experiment.id === "experiment_no_diff");
		const confirmed = normalized.experiments.find((experiment) => experiment.id === "experiment_confirmed");
		assert.equal(screened?.screeningPassed, true);
		assert.equal(screened?.credibleImprovement, false);
		assert.equal(noDiff?.screeningPassed, false);
		assert.equal(noDiff?.credibleImprovement, false);
		assert.equal(confirmed?.screeningPassed, true);
		assert.equal(confirmed?.credibleImprovement, true);
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("a newer pause or stop admission barrier prevents stale preflight launch", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-preflight-admission-barrier-"));
	const store = new IsoStore(root);
	try {
		const opened = await openReceipt(store, "a", "stale admission");
		await store.update((state) => {
			state.admissionEpoch += 1;
		});
		await assert.rejects(
			store.acceptMissionOnce(launchRequest(opened.preflightId, missionInput())),
			(error: unknown) =>
				error instanceof PreflightError &&
				error.code === "preflight_conflict" &&
				/control barrier/u.test(error.message),
		);
		assert.equal((await store.read()).missions.length, 0);
		assert.equal(store.getPreflight({ preflightId: opened.preflightId })?.state, "pending");
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("mission acceptance rolls back state, preflight, and response together", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-launch-rollback-"));
	const store = new IsoStore(root);
	try {
		const opened = await openReceipt(store, "e");
		const request = launchRequest(opened.preflightId, missionInput());
		const sabotage = new DatabaseSync(join(root, ".iso", "iso.db"));
		sabotage.exec(`
			CREATE TRIGGER reject_atomic_launch
			BEFORE INSERT ON commands
			WHEN NEW.idempotency_key = '${request.idempotencyKey}'
			BEGIN
				SELECT RAISE(ABORT, 'injected command receipt failure');
			END;
		`);
		sabotage.close();
		await assert.rejects(store.acceptMissionOnce(request), /injected command receipt failure/u);
		assert.equal((await store.read()).missions.length, 0);
		assert.equal(store.getPreflight({ preflightId: opened.preflightId })?.state, "pending");

		const repair = new DatabaseSync(join(root, ".iso", "iso.db"));
		repair.exec("DROP TRIGGER reject_atomic_launch");
		repair.close();
		const accepted = await store.acceptMissionOnce(request);
		assert.equal(accepted.value.mission.accepted, true);
		assert.equal(accepted.value.preflight.state, "launched");
		assert.equal(accepted.value.preflight.missionId, accepted.value.mission.missionId);
		assert.equal((await store.read()).missions.length, 1);
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("atomic launch reopens, replays after terminal completion, and rejects conflicting payloads", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-launch-replay-"));
	let store = new IsoStore(root);
	try {
		const opened = await openReceipt(store, "f");
		const request = launchRequest(opened.preflightId, missionInput());
		const accepted = await store.acceptMissionOnce(request);
		assert.equal(accepted.replayed, false);
		assert.equal(accepted.value.mission.preflightId, opened.preflightId);
		assert.equal(accepted.value.mission.launchOperationId, request.launchOperationId);

		await store.update((state) => {
			const mission = state.missions.find((candidate) => candidate.id === accepted.value.mission.missionId);
			assert.ok(mission);
			mission.phase = "completed";
			mission.desiredState = "stopped";
			mission.completedAt = new Date().toISOString();
		});
		store.close();
		store = new IsoStore(root);
		const terminalReplay = await store.acceptMissionOnce(request);
		assert.equal(terminalReplay.replayed, true);
		assert.deepEqual(terminalReplay.value, accepted.value);
		assert.equal((await store.read()).missions.length, 1);

		const conflicting = await openReceipt(store, "1", "another objective");
		const conflictingRequest = launchRequest(conflicting.preflightId, missionInput("A different goal"));
		await assert.rejects(
			store.acceptMissionOnce({
				...conflictingRequest,
				idempotencyKey: request.idempotencyKey,
			}),
			(error: unknown) => error instanceof IdempotencyConflictError,
		);
		assert.equal(store.getPreflight({ preflightId: conflicting.preflightId })?.state, "pending");
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("terminal launch retry resolves from its command receipt before touching vanished source artifacts", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-launch-terminal-retry-"));
	const store = new IsoStore(root);
	let runtime: IsoRuntime | undefined;
	try {
		const opened = await openReceipt(store, "7");
		const input = missionInput("Terminal replay");
		const request = launchRequest(opened.preflightId, input);
		const accepted = await store.acceptMissionOnce(request);
		await store.update((state) => {
			const mission = state.missions.find((candidate) => candidate.id === accepted.value.mission.missionId);
			assert.ok(mission);
			mission.phase = "completed";
			mission.desiredState = "stopped";
		});
		const identity = preflightLaunchIdentity(opened.preflightId, input);
		runtime = new IsoRuntime(root, store);
		const replay = await runtime.launchMissionWithPreflight(input, {
			preflightId: opened.preflightId,
			launchOperationId: identity.launchOperationId,
			inputDigest: identity.inputDigest,
			requestId: identity.requestId,
			requestFingerprint: identity.requestFingerprint,
		});
		assert.deepEqual(replay, accepted.value);
	} finally {
		if (runtime) {
			await runtime.shutdown();
		} else {
			store.close();
		}
		await rm(root, { force: true, recursive: true });
	}
});

test("an unrelated active mission is never proof for another preflight", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-launch-race-"));
	const store = new IsoStore(root);
	try {
		const first = await openReceipt(store, "2", "first");
		const second = await openReceipt(store, "3", "second");
		await store.acceptMissionOnce(launchRequest(second.preflightId, missionInput("Second mission")));
		await assert.rejects(
			store.acceptMissionOnce(launchRequest(first.preflightId, missionInput("First mission"))),
			(error: unknown) =>
				error instanceof PreflightError &&
				error.code === "preflight_conflict" &&
				/Unrelated mission/u.test(error.message),
		);
		assert.equal(store.getPreflight({ preflightId: first.preflightId })?.state, "pending");
		assert.equal(store.getPreflight({ preflightId: second.preflightId })?.state, "launched");
		assert.equal((await store.read()).missions.length, 1);
	} finally {
		store.close();
		await rm(root, { force: true, recursive: true });
	}
});

test("kernel preflight commands are durable and reject request-id payload conflicts", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-preflight-kernel-"));
	const client = new KernelClient(root);
	let kernel: Promise<void> | undefined;
	try {
		kernel = runKernel(root);
		await waitForKernel(client);
		const opened = await client.openPreflight(
			{
				intentKey: "4".repeat(64),
				objectiveDigest: preflightTurnContentDigest("Optimize the evaluator loop."),
			},
			{ requestId: "preflight-open-stable" },
		);
		assert.equal(opened.state, "pending");
		await assert.rejects(
			client.openPreflight(
				{
					intentKey: "5".repeat(64),
					objectiveDigest: preflightTurnContentDigest("Different objective"),
				},
				{ requestId: "preflight-open-stable" },
			),
			(error: unknown) => error instanceof KernelRemoteError && error.code === "idempotency_conflict",
		);
		const sessionDigest = "d".repeat(64);
		const leased = await client.beginPreflight(
			{
				intentKey: "7".repeat(64),
				objectiveDigest: preflightTurnContentDigest("Lease this objective."),
				attemptId: "attempt_kernel",
				sessionDigest,
				leaseTtlMs: 60_000,
			},
			{ requestId: "preflight-begin-leased" },
		);
		await client.correctPreflight(
			{ preflightId: leased.preflightId, attemptId: "attempt_kernel" },
			{ requestId: "preflight-correct-leased" },
		);
		assert.equal((await client.getPreflightContinuation({ sessionDigest }))?.receipt.preflightId, leased.preflightId);
		await client.claimPreflight(
			{
				preflightId: leased.preflightId,
				attemptId: "attempt_kernel",
				sessionDigest,
				leaseTtlMs: 60_000,
			},
			{ requestId: "preflight-claim-leased" },
		);
		assert.equal(await client.getPreflightContinuation({ sessionDigest }), undefined);
		const leasedQuestion = canonicalPayloadDigest("iso.preflight.question.v1", "Clarify the budget.");
		await client.deferPreflight(
			{
				preflightId: leased.preflightId,
				reason: "material_cost",
				questionDigest: leasedQuestion,
				attemptId: "attempt_kernel",
			},
			{ requestId: "preflight-defer-leased" },
		);
		const leasedAnswer = preflightTurnContentDigest("Use the default budget.");
		const leasedResumed = await client.resumePreflight(
			{
				preflightId: leased.preflightId,
				answerDigest: leasedAnswer,
				attemptId: "attempt_kernel_resumed",
				sessionDigest,
				leaseTtlMs: 60_000,
			},
			{ requestId: "preflight-resume-leased" },
		);
		assert.equal(leasedResumed.answerDigest, leasedAnswer);

		await assert.rejects(
			client.request("preflight/correct", { preflightId: opened.preflightId }),
			(error: unknown) => error instanceof KernelRemoteError && error.code === "invalid_payload",
		);
		for (const [command, payload] of [
			[
				"preflight/defer",
				{
					preflightId: opened.preflightId,
					reason: "metric_ambiguity",
					questionDigest: canonicalPayloadDigest("test.missing-attempt-question.v1", "metric"),
				},
			],
			[
				"preflight/resolve",
				{
					preflightId: opened.preflightId,
					state: "analysis_only",
				},
			],
			[
				"preflight/fail",
				{
					preflightId: opened.preflightId,
					failureCode: "launch_failed",
				},
			],
		] as const) {
			await assert.rejects(
				client.request(command, payload),
				(error: unknown) => error instanceof KernelRemoteError && error.code === "invalid_payload",
			);
		}
		const mutationAttemptId = "attempt_wire_mutation";
		const mutationPreflight = await client.beginPreflight(
			{
				intentKey: "3".repeat(64),
				objectiveDigest: preflightTurnContentDigest("Verify owned wire mutations."),
				attemptId: mutationAttemptId,
				sessionDigest: "f".repeat(64),
				leaseTtlMs: 60_000,
			},
			{ requestId: "preflight-begin-wire-mutation" },
		);
		const corrected = await client.correctPreflight(
			{ preflightId: mutationPreflight.preflightId, attemptId: mutationAttemptId },
			{ requestId: "preflight-correct-stable" },
		);
		const replayedCorrection = await client.correctPreflight(
			{ preflightId: mutationPreflight.preflightId, attemptId: mutationAttemptId },
			{ requestId: "preflight-correct-stable" },
		);
		assert.equal(corrected.correctionCount, 1);
		assert.deepEqual(replayedCorrection, corrected);

		const questionDigest = canonicalPayloadDigest("iso.preflight.question.v1", "Which metric?");
		const deferred = await client.deferPreflight(
			{
				preflightId: mutationPreflight.preflightId,
				reason: "metric_ambiguity",
				questionDigest,
				attemptId: mutationAttemptId,
			},
			{ requestId: "preflight-defer-stable" },
		);
		await assert.rejects(
			client.deferPreflight(
				{
					preflightId: mutationPreflight.preflightId,
					reason: "credentials",
					questionDigest,
					attemptId: mutationAttemptId,
				},
				{ requestId: "preflight-defer-stable" },
			),
			(error: unknown) => error instanceof KernelRemoteError && error.code === "idempotency_conflict",
		);
		const answerDigest = preflightTurnContentDigest("Use requests per second.");
		const resumed = await client.resumePreflight(
			{
				preflightId: mutationPreflight.preflightId,
				answerDigest,
				attemptId: "attempt_wire_resumed",
				sessionDigest: "f".repeat(64),
				leaseTtlMs: 60_000,
			},
			{ requestId: `preflight-resume:${mutationPreflight.preflightId}:${answerDigest}` },
		);
		assert.equal(resumed.preflightId, mutationPreflight.preflightId);
		assert.equal(resumed.answerDigest, answerDigest);

		await assert.rejects(
			client.request("preflight/open", {
				intentKey: "6".repeat(64),
				objective: "raw text must not cross this boundary",
			}),
			(error: unknown) => error instanceof KernelRemoteError && error.code === "invalid_payload",
		);
		await assert.rejects(
			client.resolvePreflight({
				preflightId: opened.preflightId,
				state: "launched",
				missionId: "mission_not_atomic",
				attemptId: "attempt_not_atomic",
			}),
			(error: unknown) => error instanceof KernelRemoteError && error.code === "invalid_payload",
		);

		await client.request("shutdown", {}, { requestId: "preflight-restart-one" });
		await kernel;
		kernel = runKernel(root);
		await waitForKernel(client);
		const persisted = await client.getPreflight({ preflightId: opened.preflightId });
		assert.deepEqual(persisted, opened);
		assert.notDeepEqual(resumed, deferred);
	} finally {
		if (kernel) {
			await settleKernel(client, kernel);
		}
		await rm(root, { force: true, recursive: true });
	}
});
