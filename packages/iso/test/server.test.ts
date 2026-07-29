import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import test from "node:test";
import {
	ControlConflictError,
	controlTargetForEntities,
	type ResearchControlOutcome,
	type ResearchControlReceipt,
	type ResearchControlRequest,
} from "../src/control.ts";
import type { IsoRuntime } from "../src/runtime.ts";
import { startDashboard } from "../src/server.ts";
import { IdempotencyConflictError } from "../src/store.ts";
import type {
	Campaign,
	DashboardSnapshot,
	EvaluationAggregate,
	Experiment,
	Generation,
	Idea,
	IsoEvent,
	ResearchMission,
} from "../src/types.ts";

const CAMPAIGN_ID = "campaign_dashboard";
const ACTIVE_GENERATION_ID = "generation_44";
const REDACTION_FIXTURES = {
	openAi: ["sk", "proj", "0123456789abcdefghijklmnop"].join("-"),
	anthropic: ["sk", "ant", "api03", "0123456789abcdefghijklmnop"].join("-"),
	aws: ["AKIA", "1234567890ABCDEF"].join(""),
	slack: ["xoxb", "123456789012", "abcdefghijklmnop"].join("-"),
	npm: ["npm", "1234567890abcdefghijklmnop"].join("_"),
	google: ["AIza", "1234567890abcdefghijklmnop"].join(""),
} as const;

interface DashboardWindow {
	totals: {
		generations: number;
		ideas: number;
		experiments: number;
		events: number;
		workers: number;
		graphNodes: number;
		operatorNotes: number;
	};
	shown: {
		generations: number;
		ideas: number;
		experiments: number;
		events: number;
		workers: number;
		graphNodes: number;
		operatorNotes: number;
	};
}

interface ProjectedEvaluation extends EvaluationAggregate {
	sampleCount: number;
}

interface ProjectedEvaluationPlan {
	id: string;
	kind: "screen" | "confirmation";
	trialIds: [];
	trialCount: number;
	startsWithCandidate: boolean;
	opportunityIndex?: number;
	createdAt: string;
}

interface ProjectedSnapshot extends DashboardSnapshot {
	window: DashboardWindow;
	activeMission?: ResearchMission;
	control?: {
		kind: "mission" | "campaign";
		id: string;
		fingerprint: string;
	};
}

function attachTestCommandStore<T extends object>(runtime: T, commands = new Map<string, unknown>()): T {
	const legacy = runtime as T &
		Partial<
			Pick<IsoRuntime, "snapshot" | "startResearch" | "resumeMission" | "pause" | "stop" | "queueOperatorNote">
		>;
	return Object.assign(runtime, {
		store: {
			async executeOnce<Result>(key: string, execute: () => Promise<Result>): Promise<Result> {
				if (commands.has(key)) {
					return structuredClone(commands.get(key)) as Result;
				}
				const result = await execute();
				commands.set(key, structuredClone(result));
				return result;
			},
		},
		async applyControl(request: ResearchControlRequest): Promise<ResearchControlReceipt> {
			const key = `test-dashboard-control:${request.actionId}`;
			const existing = commands.get(key) as
				| { actionFingerprint: string; receipt: ResearchControlReceipt }
				| undefined;
			if (existing) {
				if (existing.actionFingerprint !== request.actionFingerprint) {
					throw new IdempotencyConflictError(key);
				}
				return structuredClone(existing.receipt);
			}
			if (!legacy.snapshot) {
				throw new Error("The test runtime does not expose a snapshot.");
			}
			const snapshot = await legacy.snapshot();
			const mission = snapshot.state.missions
				.filter((candidate) => !["completed", "stopped", "failed"].includes(candidate.phase))
				.at(-1);
			const campaign = mission?.campaignId
				? snapshot.state.campaigns.find((candidate) => candidate.id === mission.campaignId)
				: mission
					? undefined
					: snapshot.activeCampaign;
			const target = controlTargetForEntities(mission, campaign);
			if (!target) {
				throw new ControlConflictError({
					code: "no_control_target",
					message: "There is no active mission or campaign to control.",
					revision: snapshot.state.revision,
				});
			}
			if (target.kind !== request.targetKind || target.id !== request.targetId) {
				throw new ControlConflictError({
					code: "control_target_changed",
					message: "The active research target changed. Refresh before issuing another control action.",
					revision: snapshot.state.revision,
					activeControl: target,
				});
			}
			if (target.fingerprint !== request.expectedControlFingerprint) {
				const rebaseEligible = request.action.kind === "note" || request.action.kind === "stop";
				throw new ControlConflictError({
					code: "control_precondition_changed",
					message: rebaseEligible
						? "The research control state changed. ISO can safely rebase this action after refresh."
						: "The research control state changed. Refresh and confirm this action again.",
					revision: snapshot.state.revision,
					activeControl: target,
					rebaseEligible,
				});
			}

			let outcome: ResearchControlOutcome;
			if (request.action.kind === "start" || request.action.kind === "resume") {
				const missionReceipt =
					target.kind === "mission" && legacy.resumeMission ? await legacy.resumeMission() : undefined;
				const researchReceipt =
					(target.kind === "campaign" || missionReceipt?.campaignId) && legacy.startResearch
						? await legacy.startResearch()
						: { runId: "mission-calibration", started: false };
				outcome = {
					kind: request.action.kind,
					missionResumed: missionReceipt !== undefined,
					missionPhase: missionReceipt?.phase,
					started: researchReceipt.started,
					runId: researchReceipt.runId,
					missionId: missionReceipt?.missionId,
					campaignId: missionReceipt?.campaignId ?? campaign?.id,
				};
			} else if (request.action.kind === "pause") {
				if (!legacy.pause) {
					throw new Error("The test runtime cannot pause.");
				}
				await legacy.pause();
				outcome = {
					kind: "pause",
					paused: true,
					missionId: mission?.id,
					campaignId: campaign?.id,
				};
			} else if (request.action.kind === "stop") {
				if (!legacy.stop) {
					throw new Error("The test runtime cannot stop.");
				}
				await legacy.stop(request.action.reason);
				outcome = {
					kind: "stop",
					stopped: true,
					missionId: mission?.id,
					campaignId: campaign?.id,
				};
			} else {
				if (!legacy.queueOperatorNote) {
					throw new Error("The test runtime cannot queue notes.");
				}
				const note = await legacy.queueOperatorNote(request.action.message, request.action.hypothesis);
				outcome = {
					kind: "note",
					queued: true,
					noteId: note.id,
					missionId: note.missionId,
					campaignId: note.campaignId,
				};
			}
			const receipt: ResearchControlReceipt = {
				actionId: request.actionId,
				actionFingerprint: request.actionFingerprint,
				targetKind: request.targetKind,
				targetId: request.targetId,
				acceptedControlFingerprint: request.expectedControlFingerprint,
				revision: (await legacy.snapshot()).state.revision,
				outcome,
			};
			commands.set(key, { actionFingerprint: request.actionFingerprint, receipt: structuredClone(receipt) });
			return receipt;
		},
	});
}

async function getWithHost(url: string, host: string): Promise<{ status: number; body: string }> {
	return new Promise((resolve, reject) => {
		const request = httpRequest(url, { headers: { host } }, (response) => {
			let body = "";
			response.setEncoding("utf8");
			response.on("data", (chunk: string) => {
				body += chunk;
			});
			response.on("end", () => resolve({ status: response.statusCode ?? 0, body }));
		});
		request.on("error", reject);
		request.end();
	});
}

function evaluation(): EvaluationAggregate {
	const samples = Array.from({ length: 15 }, (_, index) => ({
		score: 10 + index,
		metrics: { latency: 100 - index },
		summary: `summary-${"S".repeat(1_100)}`,
		valid: true,
		constraints: { safe: true },
		trialId: "SECRET_TRIAL_ID",
		phase: "sample" as const,
		sampleIndex: index,
		seed: index,
		durationMs: 1,
		stdout: `SECRET_STDOUT_${index}`,
		stderr: `SECRET_STDERR_${index}`,
	}));
	return {
		score: { mean: 17, median: 17, stddev: 1, min: 10, max: 24 },
		metrics: {
			latency: { mean: 93, median: 93, stddev: 1, min: 86, max: 100 },
		},
		samples,
		valid: true,
		failedConstraints: [],
		measuredAt: "2026-07-28T12:00:00.000Z",
	};
}

function dashboardSnapshot(): DashboardSnapshot {
	const measured = evaluation();
	const generations: Generation[] = Array.from({ length: 45 }, (_, index) => ({
		id: `generation_${index}`,
		campaignId: CAMPAIGN_ID,
		index,
		status: index === 44 ? "verifying" : "completed",
		baseCommit: `base-${index}`,
		ideaIds: index === 44 ? Array.from({ length: 125 }, (_value, ideaIndex) => `idea_${ideaIndex}`) : [],
		experimentIds:
			index === 44 ? Array.from({ length: 125 }, (_value, experimentIndex) => `experiment_${experimentIndex}`) : [],
		createdAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
		updatedAt: new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString(),
	}));
	const ideas: Idea[] = Array.from({ length: 125 }, (_, index) => ({
		id: `idea_${index}`,
		campaignId: CAMPAIGN_ID,
		generationId: index === 0 ? "generation_0" : ACTIVE_GENERATION_ID,
		title: index === 124 ? `Idea ${REDACTION_FIXTURES.openAi}` : `Idea ${index} ${"T".repeat(600)}`,
		hypothesis: index === 124 ? `AWS ${REDACTION_FIXTURES.aws}` : `Hypothesis ${"H".repeat(2_100)}`,
		rationale: index === 124 ? `Slack ${REDACTION_FIXTURES.slack}` : `Rationale ${"R".repeat(2_100)}`,
		implementationPlan: index === 124 ? `npm ${REDACTION_FIXTURES.npm}` : `Plan ${"P".repeat(2_100)}`,
		predictedEffect: index === 124 ? `GOOGLE_API_KEY=${REDACTION_FIXTURES.google}` : `Effect ${"E".repeat(1_100)}`,
		strategy: "explore",
		status: "measured",
		source: "planner",
		parentIdeaIds: index === 124 ? ["idea_0"] : [],
		fingerprint: `idea-${index}`,
		createdAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
		updatedAt: new Date(Date.UTC(2026, 0, 2, 0, 0, index)).toISOString(),
	}));
	const experiments: Experiment[] = Array.from({ length: 125 }, (_, index) => ({
		id: `experiment_${index}`,
		campaignId: CAMPAIGN_ID,
		generationId: ACTIVE_GENERATION_ID,
		ideaId: `idea_${index}`,
		attempt: 1,
		status: "measured",
		baseCommit: "base-secret",
		branch: `iso/experiment-${index}`,
		worktree: `/SECRET_WORKTREE/${index}`,
		candidateCommit: `candidate-${index}`,
		changedPaths: ["src/index.ts"],
		evaluation: measured,
		incumbentEvaluation: measured,
		improvement: 1,
		uncertainty: 0.1,
		confirmationEvaluation: measured,
		confirmationIncumbentEvaluation: measured,
		confirmationImprovement: 1,
		confirmationUncertainty: 0.1,
		confirmationRoundsPassed: 1,
		confirmationHistory: [
			{
				round: 1,
				trialId: "SECRET_CONFIRMATION_TRIAL",
				candidateMean: 17,
				incumbentMean: 16,
				improvement: 1,
				uncertainty: 0.1,
				lowerBound: 0.9,
				confirmed: true,
				measuredAt: "2026-07-28T12:00:00.000Z",
				interval: {
					method: "paired-bounded-hoeffding-bonferroni-v1",
					alpha: 0.05 / 45,
					uncertainty: 0.1,
					lowerBound: 0.9,
				},
				selection: {
					method: "paired-bounded-hoeffding-bonferroni-v1",
					claimClass: "bounded-independent-trials-fwer",
					familyWiseAlpha: 0.05,
					adjustedAlpha: 0.05 / 45,
					maxOpportunities: 45,
					opportunityIndex: 44,
					sampleCount: 15,
					uncertainty: 0.1,
					lowerBound: 0.9,
					improvement: 1,
					threshold: 0.1,
					promoted: true,
					assumptions: [
						"Each opportunity uses one fresh post-selection replication block.",
						"Read /Users/private/selection-secret only if this projection is broken.",
					],
				},
			},
		],
		screeningPlan: {
			id: `screen-plan-${index}`,
			kind: "screen",
			trialIds: ["SECRET_SCREENING_PLAN_TRIAL"],
			startsWithCandidate: true,
			createdAt: "2026-07-28T11:58:00.000Z",
		},
		confirmationPlan: {
			id: `confirmation-plan-${index}`,
			kind: "confirmation",
			trialIds: ["SECRET_CONFIRMATION_PLAN_TRIAL"],
			startsWithCandidate: false,
			opportunityIndex: 44,
			createdAt: "2026-07-28T11:59:00.000Z",
		},
		screeningPassed: true,
		credibleImprovement: true,
		failure: {
			phase: "evaluator",
			kind: "invalid-result",
			message: `failure /Users/private/secret ${"F".repeat(2_100)}`,
			retryable: false,
		},
		agent: {
			provider: "test-provider",
			model: "test-model",
			sessionId: "SECRET_AGENT_SESSION",
		},
		assistantSummary: `assistant-${"A".repeat(2_100)}`,
		createdAt: new Date(Date.UTC(2026, 0, 3, 0, 0, index)).toISOString(),
		updatedAt: new Date(Date.UTC(2026, 0, 3, 0, 0, index)).toISOString(),
	}));
	const events: IsoEvent[] = Array.from({ length: 305 }, (_, index) => ({
		id: `event_${index}`,
		sequence: index,
		campaignId: CAMPAIGN_ID,
		generationId: ACTIVE_GENERATION_ID,
		experimentId: `experiment_${index % 125}`,
		type: "experiment.measured",
		summary: `event-${index}-${"V".repeat(2_100)}`,
		actor: "evaluator",
		at: new Date(Date.UTC(2026, 0, 4, 0, 0, index)).toISOString(),
		refs: [],
		data: { secret: "EVENT_SECRET" },
	}));
	const campaign: Campaign = {
		id: CAMPAIGN_ID,
		goal: `Goal ${"G".repeat(4_100)}`,
		metric: { name: "score", direction: "maximize", minimumImprovement: 0.1 },
		config: {
			workers: 2,
			agentTimeoutMs: 10_000,
			evaluator: {
				command: "SECRET_EVALUATOR_COMMAND --token raw",
				controlCwd: "/SECRET_CONTROL_CWD",
				samples: 15,
				warmups: 0,
				timeoutMs: 10_000,
				protectedPaths: ["SECRET_PROTECTED_PATH"],
				scoreBounds: { min: 0, max: 100 },
			},
			budget: {
				maxGenerations: 45,
				maxExperiments: 125,
				maxWallClockMs: 60_000,
				maxConsecutivePlateaus: 3,
				maxFailures: 5,
			},
		},
		status: "running",
		runIntent: "running",
		sourceCommit: "source",
		evaluatorDigest: "digest",
		runtimeProvenance: {
			isoVersion: "0.1.0",
			nodeVersion: "v22",
			platform: "darwin",
			architecture: "arm64",
			sandboxRuntimeVersion: "0.0.26",
			piCodingAgentVersion: "0.82.1",
			artifactDigest: "artifact",
			evaluatorContract: "iso-result-line-v1",
			selectionMethod: "paired-postselection-bonferroni-v1",
		},
		baseline: {
			commit: "source",
			evaluatorDigest: "digest",
			evaluation: measured,
		},
		championExperimentId: "experiment_124",
		activeGenerationId: ACTIVE_GENERATION_ID,
		generationsCompleted: 44,
		experimentsStarted: 125,
		failures: 0,
		consecutivePlateaus: 0,
		createdAt: "2026-07-28T12:00:00.000Z",
		updatedAt: "2026-07-28T12:00:00.000Z",
	};
	return {
		state: {
			schemaVersion: 2,
			revision: 1,
			admissionEpoch: 0,
			campaigns: [campaign],
			ideas,
			generations,
			experiments,
			reflections: [],
			events,
			missions: [],
			operatorNotes: [],
			retryQueue: [],
			agentCallAttempts: [],
			materialUpdates: [],
			nextMaterialUpdateSequence: 1,
		},
		graph: { nodes: [], edges: [] },
		workers: [
			{
				id: "worker/one",
				ideaId: "idea_124",
				experimentId: "experiment_124",
				generationId: ACTIVE_GENERATION_ID,
				label: "Champion sk-ant-api03-0123456789abcdefghijklmnop",
				status: "evaluating",
				activity: "Running paired samples",
				startedAt: "2026-07-28T12:00:00.000Z",
			},
		],
		activeCampaign: campaign,
		kernel: { pid: 42, startedAt: "2026-07-28T12:00:00.000Z" },
	};
}

function campaignControlFingerprint(controlState = "running"): string {
	return createHash("sha256")
		.update(JSON.stringify({ kind: "campaign", id: CAMPAIGN_ID, campaignControlState: controlState }))
		.digest("base64url");
}

function actionBody(
	actionId: string,
	extra: Record<string, unknown> = {},
	target: { kind: "mission" | "campaign"; id: string; fingerprint: string } = {
		kind: "campaign",
		id: CAMPAIGN_ID,
		fingerprint: campaignControlFingerprint(),
	},
): string {
	return JSON.stringify({
		targetKind: target.kind,
		targetId: target.id,
		expectedControlFingerprint: target.fingerprint,
		actionId,
		...extra,
	});
}

test("loopback dashboard enforces projection, revision, idempotency, and control boundaries", async (context) => {
	const snapshot = dashboardSnapshot();
	const controls = {
		starts: 0,
		pauses: 0,
		stops: [] as string[],
		steers: [] as Array<{ workerId: string; message: string }>,
		aborts: [] as string[],
		notes: [] as string[],
		unsubscribes: 0,
		executorCalls: 0,
	};
	const runtime = {
		onChange(_listener: () => void): () => void {
			return () => {
				controls.unsubscribes += 1;
			};
		},
		async snapshot(): Promise<DashboardSnapshot> {
			return snapshot;
		},
		async startResearch() {
			controls.starts += 1;
			return { runId: `run-${controls.starts}`, started: true };
		},
		async pause(): Promise<void> {
			controls.pauses += 1;
		},
		async stop(reason?: string): Promise<void> {
			controls.stops.push(reason ?? "");
		},
		async steer(workerId: string, message: string): Promise<void> {
			controls.steers.push({ workerId, message });
		},
		async abort(workerId: string): Promise<void> {
			controls.aborts.push(workerId);
		},
		async queueOperatorNote(message: string) {
			controls.notes.push(message);
			return {
				id: `note-${controls.notes.length}`,
				campaignId: CAMPAIGN_ID,
				message,
				status: "queued" as const,
				createdAt: "2026-07-28T12:00:00.000Z",
			};
		},
	} satisfies Pick<
		IsoRuntime,
		"onChange" | "snapshot" | "startResearch" | "pause" | "stop" | "steer" | "abort" | "queueOperatorNote"
	>;
	const durableCommands = new Map<string, unknown>();
	attachTestCommandStore(runtime, durableCommands);
	const dashboard = await startDashboard(runtime as unknown as IsoRuntime, {
		host: "127.0.0.1",
		port: 0,
		mutationExecutor: async (operation) => {
			controls.executorCalls += 1;
			return operation();
		},
	});
	context.after(() => dashboard.close());
	const controlToken = dashboard.token;
	assert.ok(controlToken);

	const indexResponse = await fetch(dashboard.url);
	assert.equal(indexResponse.status, 200);
	assert.equal(indexResponse.headers.get("cache-control"), "no-store");
	assert.equal(indexResponse.headers.get("x-frame-options"), "DENY");
	assert.equal(indexResponse.headers.get("referrer-policy"), "no-referrer");
	const policy = indexResponse.headers.get("content-security-policy") ?? "";
	assert.match(policy, /^default-src 'self';/);
	assert.match(policy, /script-src 'self' 'nonce-[a-zA-Z0-9_-]+'/);
	assert.match(policy, /connect-src 'self'/);
	assert.match(policy, /object-src 'none'/);
	assert.match(policy, /frame-ancestors 'none'/);
	assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval/);
	const nonce = policy.match(/'nonce-([^']+)'/)?.[1];
	assert.ok(nonce);
	const html = await indexResponse.text();
	assert.ok(html.includes(`nonce="${nonce}"`));
	assert.ok(html.includes(JSON.stringify(controlToken)));
	assert.match(html, /window\.ISO_CAN_CONTROL = true/u);
	assert.match(html, /id="campaign-message-form"/u);
	assert.match(html, /<progress/u);
	assert.match(html, /id="lineage-list"/u);
	assert.match(
		html,
		/class="champion-kpi"[\s\S]*id="confidence-label"[\s\S]*<\/article>\s*<article>\s*<span>VS\. ORIGINAL BASELINE<\/span>[\s\S]*id="delta-label"[\s\S]*<\/article>/u,
	);
	assert.doesNotMatch(html, /__ISO_(?:CONTROL_TOKEN_JSON|CAN_CONTROL_JSON|SCRIPT_NONCE)__/);

	const snapshotResponse = await fetch(`${dashboard.url}/api/snapshot`);
	assert.equal(snapshotResponse.status, 200);
	assert.equal(snapshotResponse.headers.get("cache-control"), "no-store");
	assert.equal(snapshotResponse.headers.get("x-content-type-options"), "nosniff");
	const snapshotText = await snapshotResponse.text();
	assert.equal(Buffer.byteLength(snapshotText, "utf8") < 5_000_000, true);
	for (const secret of [
		"SECRET_EVALUATOR_COMMAND",
		"SECRET_CONTROL_CWD",
		"SECRET_PROTECTED_PATH",
		"SECRET_WORKTREE",
		"SECRET_STDOUT",
		"SECRET_STDERR",
		"SECRET_TRIAL_ID",
		"SECRET_CONFIRMATION_TRIAL",
		"SECRET_SCREENING_PLAN_TRIAL",
		"SECRET_CONFIRMATION_PLAN_TRIAL",
		"SECRET_AGENT_SESSION",
		"EVENT_SECRET",
		"/Users/private/secret",
		REDACTION_FIXTURES.openAi,
		REDACTION_FIXTURES.anthropic,
		REDACTION_FIXTURES.aws,
		REDACTION_FIXTURES.slack,
		REDACTION_FIXTURES.npm,
		REDACTION_FIXTURES.google,
	]) {
		assert.equal(snapshotText.includes(secret), false, `snapshot leaked ${secret}`);
	}
	const projected = JSON.parse(snapshotText) as ProjectedSnapshot;
	assert.equal(projected.state.admissionEpoch, 0);
	assert.equal(projected.control?.kind, "campaign");
	assert.equal(projected.activeCampaign?.config.evaluator.command, "[configured locally]");
	assert.equal(projected.activeCampaign?.config.evaluator.controlCwd, "[local control directory]");
	assert.deepEqual(projected.activeCampaign?.config.evaluator.protectedPaths, []);
	assert.deepEqual(projected.activeCampaign?.config.evaluator.scoreBounds, { min: 0, max: 100 });
	assert.equal(projected.activeCampaign?.goal.length, 4_000);
	assert.equal(projected.state.experiments.length, 120);
	assert.equal(projected.state.ideas.length, 125);
	assert.equal(projected.state.generations.length, 40);
	assert.equal(projected.state.events.length, 300);
	assert.equal(projected.window.totals.experiments, 125);
	assert.equal(projected.window.shown.experiments, 120);
	assert.equal(projected.window.totals.graphNodes > projected.window.shown.graphNodes, true);
	assert.ok(projected.state.experiments.some((experiment) => experiment.id === "experiment_124"));
	assert.ok(
		projected.graph.edges.some(
			(edge) => edge.kind === "derived-from" && edge.from === "idea_0" && edge.to === "idea_124",
		),
	);
	const champion = projected.state.experiments.find((experiment) => experiment.id === "experiment_124");
	assert.ok(champion);
	assert.equal(champion.worktree, "");
	assert.deepEqual(champion.changedPaths, []);
	assert.equal(champion.assistantSummary?.length, 2_000);
	assert.match(champion.failure?.message ?? "", /\[local path\]/);
	assert.equal((champion.evaluation as ProjectedEvaluation | undefined)?.sampleCount, 15);
	assert.equal(champion.evaluation?.samples.length, 0);
	assert.deepEqual(champion.evaluation?.metrics, {});
	assert.equal(champion.confirmationHistory?.[0].round, 1);
	assert.equal(champion.confirmationHistory?.[0].selection?.claimClass, "bounded-independent-trials-fwer");
	assert.equal(champion.confirmationHistory?.[0].selection?.method, "paired-bounded-hoeffding-bonferroni-v1");
	assert.match(champion.confirmationHistory?.[0].selection?.assumptions[1] ?? "", /\[local path\]/u);
	assert.equal(champion.confirmationHistory?.[0].candidateEvaluation, undefined);
	assert.equal(champion.confirmationHistory?.[0].sampleIdentities, undefined);
	const screeningPlan = champion.screeningPlan as ProjectedEvaluationPlan | undefined;
	const confirmationPlan = champion.confirmationPlan as ProjectedEvaluationPlan | undefined;
	assert.equal(screeningPlan?.trialCount, 1);
	assert.deepEqual(screeningPlan?.trialIds, []);
	assert.equal(confirmationPlan?.trialCount, 1);
	assert.deepEqual(confirmationPlan?.trialIds, []);
	assert.equal(confirmationPlan?.opportunityIndex, 44);
	assert.equal(champion.screeningPassed, true);
	assert.equal(champion.credibleImprovement, true);
	assert.equal(champion.agent?.sessionId, undefined);
	assert.ok(projected.state.events.every((event) => event.data === undefined && event.summary.length <= 2_000));
	assert.deepEqual(projected.state.missions, []);
	assert.deepEqual(projected.state.operatorNotes, []);

	const appSource = await readFile(new URL("../public/app.js", import.meta.url), "utf8");
	assert.match(appSource, /confirmationHistory/u);
	assert.match(appSource, /FRESH POST-SELECTION REPLICATION/u);
	assert.match(appSource, /bounded-independent-trials-fwer/u);
	assert.match(appSource, /function formatProbability/u);
	assert.match(appSource, /toExponential\(3\)/u);
	assert.match(appSource, /formatProbability\(selection\.adjustedAlpha\)/u);
	assert.match(appSource, /FINAL STEP VS INCUMBENT/u);
	assert.match(appSource, /result_screen_\$\{experiment\.id\}/u);
	assert.match(appSource, /result_confirmation_\$\{experiment\.id\}/u);
	assert.doesNotMatch(appSource, /All candidates/u);
	assert.match(appSource, /ADMISSION EPOCH/u);
	assert.match(appSource, /RECEIPT-GATED/u);
	assert.doesNotMatch(appSource, /independent confirmation|holdout|paired 95%/iu);
	assert.match(html, /id="evaluation-plan"/u);
	assert.match(html, /id="control-barrier"/u);
	assert.doesNotMatch(html, /independent confirmation|holdout|95% lower bounds/iu);
	assert.match(appSource, /events\.addEventListener\("ready", scheduleRefresh\)/u);
	assert.match(appSource, /expectedControlFingerprint/u);
	assert.match(appSource, /control_precondition_changed/u);
	assert.match(appSource, /window\.setInterval\(\(\) => \{\s*void refresh\(\);\s*\}, 10_000\)/u);
	const expectedDashboardRoutes = [
		"/api/snapshot",
		"/api/events",
		"/api/note",
		"/api/research/start",
		"/api/research/resume",
		"/api/research/pause",
		"/api/research/stop",
		`/api/workers/\${encodeURIComponent(workerId)}/steer`,
		`/api/workers/\${encodeURIComponent(workerId)}/abort`,
	].sort();
	const declaredDashboardRoutes = [
		...new Set([...appSource.matchAll(/["'`](\/api\/[^"'`]+)["'`]/gu)].map((match) => match[1])),
	].sort();
	assert.deepEqual(declaredDashboardRoutes, expectedDashboardRoutes);

	const eventController = new AbortController();
	const eventResponse = await fetch(`${dashboard.url}/api/events`, {
		signal: eventController.signal,
	});
	assert.equal(eventResponse.status, 200);
	const eventReader = eventResponse.body?.getReader();
	const firstEvent = await eventReader?.read();
	assert.match(new TextDecoder().decode(firstEvent?.value), /event: ready/);
	eventController.abort();
	await eventReader?.cancel().catch(() => undefined);

	const rejected = await fetch(`${dashboard.url}/api/research/start`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: actionBody("action-rejected"),
	});
	assert.equal(rejected.status, 403);
	const rebound = await getWithHost(dashboard.url, "attacker.example");
	assert.equal(rebound.status, 421);
	assert.equal(rebound.body.includes(controlToken), false);
	const headers = {
		"content-type": "application/json",
		"x-iso-control-token": controlToken,
	};
	const crossOrigin = await fetch(`${dashboard.url}/api/research/start`, {
		method: "POST",
		headers: { ...headers, origin: "https://attacker.example", "sec-fetch-site": "cross-site" },
		body: actionBody("cross-origin-action"),
	});
	assert.equal(crossOrigin.status, 403);
	const missingEnvelope = await fetch(`${dashboard.url}/api/research/start`, {
		method: "POST",
		headers,
		body: "{}",
	});
	assert.equal(missingEnvelope.status, 400);
	const wrongCampaign = await fetch(`${dashboard.url}/api/research/start`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			targetKind: "campaign",
			targetId: "campaign_wrong",
			expectedControlFingerprint: campaignControlFingerprint(),
			actionId: "action-wrong-campaign",
		}),
	});
	assert.equal(wrongCampaign.status, 409);
	const stale = await fetch(`${dashboard.url}/api/research/start`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			targetKind: "campaign",
			targetId: CAMPAIGN_ID,
			expectedControlFingerprint: "A".repeat(43),
			actionId: "action-stale-revision",
		}),
	});
	assert.equal(stale.status, 409);
	const staleResult = (await stale.json()) as { code?: string; rebaseEligible?: boolean };
	assert.equal(staleResult.code, "control_precondition_changed");
	assert.equal(staleResult.rebaseEligible, false);
	const staleNote = await fetch(`${dashboard.url}/api/note`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			targetKind: "campaign",
			targetId: CAMPAIGN_ID,
			expectedControlFingerprint: "A".repeat(43),
			actionId: "action-stale-note",
			message: "Preserve this guidance",
		}),
	});
	assert.equal(staleNote.status, 409);
	assert.equal(((await staleNote.json()) as { rebaseEligible?: boolean }).rebaseEligible, true);
	const liveCampaign = snapshot.state.campaigns[0];
	liveCampaign.status = "paused";
	liveCampaign.runIntent = "paused";
	const rebasedProjection = (await (await fetch(`${dashboard.url}/api/snapshot`)).json()) as ProjectedSnapshot;
	assert.ok(rebasedProjection.control);
	const rebased = await fetch(`${dashboard.url}/api/research/start`, {
		method: "POST",
		headers,
		body: actionBody("action-stale-revision", {}, rebasedProjection.control),
	});
	assert.equal(rebased.status, 202);
	assert.equal(controls.starts, 1);
	liveCampaign.status = "running";
	liveCampaign.runIntent = "running";

	// Evidence can advance the global store revision without invalidating a
	// control action whose semantic mission/campaign target is unchanged.
	snapshot.state.revision = 999;
	const actions = [
		{ path: "/api/research/start", body: actionBody("action-start"), status: 202 },
		{ path: "/api/research/resume", body: actionBody("action-resume"), status: 202 },
		{ path: "/api/research/pause", body: actionBody("action-pause"), status: 200 },
		{
			path: "/api/research/stop",
			body: actionBody("action-stop", { reason: "  operator stop  " }),
			status: 200,
		},
		{
			path: "/api/workers/worker%2Fone/steer",
			body: actionBody("action-steer", { message: "  focus on evidence  " }),
			status: 200,
		},
		{
			path: "/api/workers/worker%2Fone/abort",
			body: actionBody("action-abort"),
			status: 200,
		},
		{
			path: "/api/note",
			body: actionBody("action-note", { message: "  prioritize the retained evidence  " }),
			status: 200,
		},
	];
	for (const action of actions) {
		const response = await fetch(`${dashboard.url}${action.path}`, {
			method: "POST",
			headers,
			body: action.body,
		});
		assert.equal(response.status, action.status, action.path);
		const result = (await response.json()) as Record<string, unknown>;
		assert.equal(typeof result.actionId, "string");
		assert.equal(typeof result.actionFingerprint, "string");
		assert.equal(result.targetKind, "campaign");
		assert.equal(result.targetId, CAMPAIGN_ID);
		assert.equal(result.acceptedControlFingerprint, campaignControlFingerprint());
		if (action.path.includes("/workers/")) {
			assert.equal((result.outcome as { delivery?: string } | undefined)?.delivery, "best-effort");
		}
	}
	const duplicatePause = await fetch(`${dashboard.url}/api/research/pause`, {
		method: "POST",
		headers,
		body: actionBody("action-pause"),
	});
	assert.equal(duplicatePause.status, 200);
	const duplicateNote = await fetch(`${dashboard.url}/api/note`, {
		method: "POST",
		headers,
		body: actionBody("action-note", { message: "prioritize the retained evidence" }),
	});
	assert.equal(duplicateNote.status, 200);
	const changedDuplicateNote = await fetch(`${dashboard.url}/api/note`, {
		method: "POST",
		headers,
		body: actionBody("action-note", { message: "a different instruction" }),
	});
	assert.equal(changedDuplicateNote.status, 409);
	const reusedAction = await fetch(`${dashboard.url}/api/research/stop`, {
		method: "POST",
		headers,
		body: actionBody("action-pause"),
	});
	assert.equal(reusedAction.status, 409);
	assert.equal(controls.starts, 3);
	assert.equal(controls.pauses, 1);
	assert.deepEqual(controls.stops, ["operator stop"]);
	assert.deepEqual(controls.steers, [{ workerId: "worker/one", message: "focus on evidence" }]);
	assert.deepEqual(controls.aborts, ["worker/one"]);
	assert.deepEqual(controls.notes, ["prioritize the retained evidence"]);
	assert.equal(controls.executorCalls > 0, true);

	const firstClose = dashboard.close();
	const secondClose = dashboard.close();
	assert.equal(firstClose, secondClose);
	await firstClose;
	assert.equal(controls.unsubscribes, 1);

	const restartedDashboard = await startDashboard(runtime as unknown as IsoRuntime, {
		host: "127.0.0.1",
		port: 0,
	});
	const restartedToken = restartedDashboard.token;
	assert.ok(restartedToken);
	const durableReplay = await fetch(`${restartedDashboard.url}/api/note`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-iso-control-token": restartedToken,
		},
		body: actionBody("action-note", { message: "prioritize the retained evidence" }),
	});
	assert.equal(durableReplay.status, 200);
	assert.deepEqual(controls.notes, ["prioritize the retained evidence"]);
	const durableMismatch = await fetch(`${restartedDashboard.url}/api/note`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-iso-control-token": restartedToken,
		},
		body: actionBody("action-note", { message: "different after restart" }),
	});
	assert.equal(durableMismatch.status, 409);
	await restartedDashboard.close();
	assert.equal(controls.unsubscribes, 2);
});

test("worker controls reject a live worker that belongs to a stale campaign", async (context) => {
	const snapshot = dashboardSnapshot();
	const activeCampaign = snapshot.state.campaigns[0];
	const staleCampaign: Campaign = {
		...structuredClone(activeCampaign),
		id: "campaign_stale_worker",
		status: "stopped",
		runIntent: "stopped",
		activeGenerationId: undefined,
	};
	const staleExperiment: Experiment = {
		...structuredClone(snapshot.state.experiments[0]),
		id: "experiment_stale_worker",
		campaignId: staleCampaign.id,
	};
	snapshot.state.campaigns.unshift(staleCampaign);
	snapshot.state.experiments.push(staleExperiment);
	snapshot.workers = [
		snapshot.workers[0],
		{
			...snapshot.workers[0],
			id: "worker-stale-campaign",
			experimentId: staleExperiment.id,
		},
	];
	let steerCalls = 0;
	const runtime = {
		onChange(): () => void {
			return () => undefined;
		},
		async snapshot(): Promise<DashboardSnapshot> {
			return snapshot;
		},
		async steer(): Promise<void> {
			steerCalls += 1;
		},
	} satisfies Pick<IsoRuntime, "onChange" | "snapshot" | "steer">;
	attachTestCommandStore(runtime);
	const dashboard = await startDashboard(runtime as unknown as IsoRuntime, {
		host: "127.0.0.1",
		port: 0,
	});
	context.after(() => dashboard.close());
	assert.ok(dashboard.token);
	const projected = (await (await fetch(`${dashboard.url}/api/snapshot`)).json()) as ProjectedSnapshot;
	assert.deepEqual(
		projected.workers.map((worker) => worker.id),
		["worker/one"],
	);
	assert.equal(projected.window.totals.workers, 1);
	assert.equal(projected.window.shown.workers, 1);
	const response = await fetch(`${dashboard.url}/api/workers/worker-stale-campaign/steer`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-iso-control-token": dashboard.token,
		},
		body: actionBody("stale-worker-steer", { message: "Do not deliver this." }),
	});
	assert.equal(response.status, 404);
	assert.match(((await response.json()) as { error: string }).error, /not active for this research target/u);
	assert.equal(steerCalls, 0);
});

test("accepted mission is projected and controllable before campaign calibration", async (context) => {
	const historical = dashboardSnapshot();
	const mission: ResearchMission = {
		id: "mission_dashboard",
		input: {
			goal: "Make the local research loop self-driving",
			metric: { name: "quality", direction: "maximize", minimumImprovement: 0.2 },
			config: historical.state.campaigns[0].config,
			sourceCommit: "source-commit",
			sourceHeadCommit: "source-head",
			sourceSnapshotRef: "refs/iso/source-snapshots/source-commit",
			sourceHadLocalChanges: true,
			sourceSnapshotPaths: ["SECRET_SOURCE_PATH"],
			dependencyDigest: "dependency-digest",
		},
		desiredState: "running",
		phase: "accepted",
		diagnostics: [
			{
				id: "diagnostic-1",
				phase: "accepted",
				code: "accepted",
				message: "Frozen at /Users/private/mission-source",
				retryable: true,
				at: "2026-07-28T12:00:00.000Z",
			},
		],
		notificationCursor: 0,
		createdAt: "2026-07-28T12:00:00.000Z",
		updatedAt: "2026-07-28T12:00:00.000Z",
	};
	const missionSnapshot: DashboardSnapshot = {
		...historical,
		state: {
			...historical.state,
			revision: 7,
			missions: [mission],
			operatorNotes: [
				{
					id: "note-queued",
					missionId: mission.id,
					message: "Try the retained evidence first",
					status: "queued",
					createdAt: "2026-07-28T12:01:00.000Z",
				},
				{
					id: "note-consumed",
					missionId: mission.id,
					message: "Avoid /Users/private/operator-secret",
					status: "consumed",
					createdAt: "2026-07-28T12:00:00.000Z",
					consumedAt: "2026-07-28T12:02:00.000Z",
					consumedGenerationId: "generation-consumed",
				},
			],
			materialUpdates: [
				{
					sequence: 1,
					missionId: mission.id,
					kind: "mission",
					summary: "Mission accepted",
					at: "2026-07-28T12:00:00.000Z",
					refs: [mission.id],
				},
			],
			nextMaterialUpdateSequence: 2,
		},
	};
	const calls: string[] = [];
	const runtime = {
		onChange(): () => void {
			return () => undefined;
		},
		async snapshot(): Promise<DashboardSnapshot> {
			return missionSnapshot;
		},
		async resumeMission() {
			calls.push("resumeMission");
			return {
				missionId: mission.id,
				phase: mission.phase,
				accepted: false,
				campaignId: mission.campaignId,
			};
		},
		async startResearch() {
			calls.push("startResearch");
			return { runId: "mission-run", started: true };
		},
		async pause(): Promise<void> {
			calls.push("pause");
		},
		async stop(): Promise<void> {
			calls.push("stop");
		},
		async queueOperatorNote(message: string) {
			calls.push(`note:${message}`);
			return {
				id: "note-new",
				missionId: mission.id,
				message,
				status: "queued" as const,
				createdAt: "2026-07-28T12:03:00.000Z",
			};
		},
	} satisfies Pick<
		IsoRuntime,
		"onChange" | "snapshot" | "resumeMission" | "startResearch" | "pause" | "stop" | "queueOperatorNote"
	>;
	attachTestCommandStore(runtime);
	const dashboard = await startDashboard(runtime as unknown as IsoRuntime, {
		host: "127.0.0.1",
		port: 0,
	});
	context.after(() => dashboard.close());
	const controlToken = dashboard.token;
	assert.ok(controlToken);
	const headers = {
		"content-type": "application/json",
		"x-iso-control-token": controlToken,
	};

	const projected = (await (await fetch(`${dashboard.url}/api/snapshot`)).json()) as ProjectedSnapshot;
	assert.equal(projected.activeCampaign, undefined);
	assert.equal(projected.activeMission?.id, mission.id);
	assert.equal(projected.activeMission?.input.config.evaluator.command, "[configured locally]");
	assert.deepEqual(projected.activeMission?.input.sourceSnapshotPaths, []);
	assert.match(projected.activeMission?.diagnostics[0]?.message ?? "", /\[local path\]/u);
	assert.equal(projected.state.operatorNotes.length, 2);
	assert.match(projected.state.operatorNotes[1]?.message ?? "", /\[local path\]/u);
	assert.equal(projected.window.shown.operatorNotes, 2);
	assert.equal(projected.control?.kind, "mission");
	assert.equal(projected.control?.id, mission.id);
	assert.ok(projected.control);
	const target = projected.control;

	for (const action of [
		{ path: "/api/research/pause", body: {} },
		{ path: "/api/note", body: { message: "Prioritize the calibration invariant" } },
		{ path: "/api/research/stop", body: { reason: "Stop before calibration" } },
		{ path: "/api/research/resume", body: {} },
	]) {
		const response = await fetch(`${dashboard.url}${action.path}`, {
			method: "POST",
			headers,
			body: actionBody(`mission-${action.path.split("/").at(-1)}-action`, action.body, target),
		});
		assert.equal(response.status >= 200 && response.status < 300, true, action.path);
	}
	assert.deepEqual(calls, ["pause", "note:Prioritize the calibration invariant", "stop", "resumeMission"]);

	mission.campaignId = CAMPAIGN_ID;
	mission.phase = "paused";
	mission.desiredState = "paused";
	missionSnapshot.state.campaigns[0].missionId = mission.id;
	missionSnapshot.state.revision += 1;
	const linked = (await (await fetch(`${dashboard.url}/api/snapshot`)).json()) as ProjectedSnapshot;
	assert.equal(linked.activeCampaign?.id, CAMPAIGN_ID);
	assert.ok(linked.control);
	const linkedResume = await fetch(`${dashboard.url}/api/research/resume`, {
		method: "POST",
		headers,
		body: actionBody("linked-mission-resume", {}, linked.control),
	});
	assert.equal(linkedResume.status, 202);
	assert.deepEqual(calls.slice(-2), ["resumeMission", "startResearch"]);

	const completionReport = {
		campaignId: CAMPAIGN_ID,
		missionId: mission.id,
		outcome: "completed" as const,
		reason: "Budget completed with a confirmed champion",
		goal: mission.input.goal,
		metric: mission.input.metric,
		baselineScore: 10,
		champion: {
			campaignId: CAMPAIGN_ID,
			experimentId: "experiment_124",
			ideaId: "idea_124",
			sourceCommit: "source",
			candidateCommit: "candidate-124",
			changedPaths: ["src/index.ts"],
			baselineScore: 10,
			championScore: 17,
			cumulativeImprovement: 7,
			cumulativeUncertainty: 0.2,
			stepImprovement: 1.5,
			stepUncertainty: 0.1,
			improvement: 7,
			uncertainty: 0.1,
			confirmationRoundsPassed: 1,
			applyPrecondition: {
				expectedHead: "source",
				requiresCleanWorktree: true as const,
				requiresDirtySourceReconciliation: false,
				sourceSnapshotPaths: [],
			},
		},
		generationsCompleted: 2,
		experimentsStarted: 8,
		measuredExperiments: 7,
		failures: 1,
		agentUsage: {
			inputTokens: 100,
			outputTokens: 50,
			costUsd: 0.25,
			agentCalls: 4,
			callsMissingTokenAccounting: 0,
			callsMissingCostAccounting: 0,
		},
		keyFindings: ["The confirmed mechanism retained its lift."],
		generatedAt: "2026-07-28T12:10:00.000Z",
	};
	mission.phase = "completed";
	mission.desiredState = "stopped";
	mission.completionReport = completionReport;
	const linkedCampaign = missionSnapshot.state.campaigns[0];
	linkedCampaign.status = "completed";
	linkedCampaign.completionReport = completionReport;
	missionSnapshot.state.revision += 1;
	const terminal = (await (await fetch(`${dashboard.url}/api/snapshot`)).json()) as ProjectedSnapshot;
	assert.equal(terminal.control, undefined);
	assert.equal(terminal.activeMission?.completionReport?.outcome, "completed");
	assert.equal(terminal.activeCampaign?.completionReport?.champion?.candidateCommit, "candidate-124");
	assert.equal(terminal.activeCampaign?.completionReport?.champion?.cumulativeImprovement, 7);
	assert.equal(terminal.activeCampaign?.completionReport?.champion?.cumulativeUncertainty, 0.2);
	assert.equal(terminal.activeCampaign?.completionReport?.champion?.stepImprovement, 1.5);
	assert.equal(terminal.activeCampaign?.completionReport?.champion?.stepUncertainty, 0.1);

	linkedCampaign.status = "running";
	linkedCampaign.runIntent = "running";
	linkedCampaign.missionId = undefined;
	linkedCampaign.completionReport = undefined;
	missionSnapshot.state.revision += 1;
	const liveLegacyCampaign = (await (await fetch(`${dashboard.url}/api/snapshot`)).json()) as ProjectedSnapshot;
	assert.equal(liveLegacyCampaign.activeMission, undefined);
	assert.equal(liveLegacyCampaign.activeCampaign?.id, CAMPAIGN_ID);
	assert.equal(liveLegacyCampaign.control?.kind, "campaign");
});

test("dashboard refuses non-loopback exposure without an explicit trusted relay", async () => {
	await assert.rejects(startDashboard({} as IsoRuntime, { host: "0.0.0.0", port: 0 }), /non-loopback dashboard bind/u);
});

test("no-campaign projection and controls fail closed", async (context) => {
	const historical = dashboardSnapshot();
	const noCampaign: DashboardSnapshot = {
		...historical,
		activeCampaign: undefined,
		workers: [],
	};
	const runtime = {
		onChange(): () => void {
			return () => undefined;
		},
		async snapshot(): Promise<DashboardSnapshot> {
			return noCampaign;
		},
	} satisfies Pick<IsoRuntime, "onChange" | "snapshot">;
	attachTestCommandStore(runtime);
	const dashboard = await startDashboard(runtime as unknown as IsoRuntime, {
		host: "127.0.0.1",
		port: 0,
	});
	context.after(() => dashboard.close());
	const controlToken = dashboard.token;
	assert.ok(controlToken);

	const response = await fetch(`${dashboard.url}/api/snapshot`);
	const projected = (await response.json()) as ProjectedSnapshot;
	assert.deepEqual(projected.state.campaigns, []);
	assert.deepEqual(projected.state.events, []);
	assert.equal(projected.window.totals.experiments, 0);

	const mutation = await fetch(`${dashboard.url}/api/research/pause`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-iso-control-token": controlToken,
		},
		body: actionBody("no-campaign-action"),
	});
	assert.equal(mutation.status, 409);
	assert.deepEqual(await mutation.json(), {
		error: "There is no active mission or campaign to control.",
		code: "no_control_target",
		revision: 1,
	});

	noCampaign.activeCampaign = {
		...historical.state.campaigns[0],
		status: "completed",
	};
	const historicalMutation = await fetch(`${dashboard.url}/api/research/pause`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-iso-control-token": controlToken,
		},
		body: actionBody("historical-campaign-action"),
	});
	assert.equal(historicalMutation.status, 409);
});

test("trusted relay mode authenticates reads and controls without leaking either relay secret", async (context) => {
	const snapshot = dashboardSnapshot();
	let starts = 0;
	const runtime = {
		onChange(): () => void {
			return () => undefined;
		},
		async snapshot(): Promise<DashboardSnapshot> {
			return snapshot;
		},
		async startResearch() {
			starts += 1;
			return { runId: "relay-run", started: true };
		},
	} satisfies Pick<IsoRuntime, "onChange" | "snapshot" | "startResearch">;
	attachTestCommandStore(runtime);
	const readToken = "relay-read-token-0000000000000001";
	const controlToken = "relay-control-token-0000000000001";
	const dashboard = await startDashboard(runtime as unknown as IsoRuntime, {
		host: "0.0.0.0",
		port: 0,
		trustedRelay: { readToken, controlToken, allowedHosts: ["127.0.0.1"] },
	});
	context.after(() => dashboard.close());
	assert.equal(dashboard.token, undefined);
	const baseUrl = `http://127.0.0.1:${dashboard.port}`;

	assert.equal((await fetch(baseUrl)).status, 403);
	const readHeaders = { "x-iso-relay-read-token": readToken };
	const index = await fetch(baseUrl, { headers: readHeaders });
	assert.equal(index.status, 200);
	const html = await index.text();
	assert.match(html, /window\.ISO_CONTROL_TOKEN = null/u);
	assert.match(html, /window\.ISO_CAN_CONTROL = false/u);
	assert.equal(html.includes(readToken), false);
	assert.equal(html.includes(controlToken), false);
	const controlIndex = await fetch(baseUrl, {
		headers: { ...readHeaders, "x-iso-relay-control-token": controlToken },
	});
	assert.match(await controlIndex.text(), /window\.ISO_CAN_CONTROL = true/u);

	const readOnlyControl = await fetch(`${baseUrl}/api/research/start`, {
		method: "POST",
		headers: { ...readHeaders, "content-type": "application/json" },
		body: actionBody("relay-read-only"),
	});
	assert.equal(readOnlyControl.status, 403);
	const controlled = await fetch(`${baseUrl}/api/research/start`, {
		method: "POST",
		headers: {
			...readHeaders,
			"content-type": "application/json",
			"x-iso-relay-control-token": controlToken,
		},
		body: actionBody("relay-control"),
	});
	assert.equal(controlled.status, 202);
	assert.equal(starts, 1);
});

test("failed dashboard autostart closes the listener and unsubscribes", async () => {
	let unsubscribes = 0;
	const runtime = {
		onChange(): () => void {
			return () => {
				unsubscribes += 1;
			};
		},
		async snapshot(): Promise<DashboardSnapshot> {
			return dashboardSnapshot();
		},
		async startResearch(): Promise<never> {
			throw new Error("start failed");
		},
	} satisfies Pick<IsoRuntime, "onChange" | "snapshot" | "startResearch">;
	attachTestCommandStore(runtime);
	await assert.rejects(
		startDashboard(runtime as unknown as IsoRuntime, {
			host: "127.0.0.1",
			port: 0,
			startResearch: true,
		}),
		/start failed/u,
	);
	assert.equal(unsubscribes, 1);
});
