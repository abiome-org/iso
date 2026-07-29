import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PiResearchAgents, type ResearchAgents } from "../src/agents.ts";
import { ControlConflictError, controlContextForState, type ResearchControlRequest } from "../src/control.ts";
import { EvaluatorContractError } from "../src/evaluator.ts";
import {
	EvaluatorIntegrityError,
	prepareDependencySnapshot,
	resolveCommit,
	snapshotCurrentWorktree,
} from "../src/git.ts";
import { critical95, IsoRuntime } from "../src/runtime.ts";
import { fingerprintIdea, IdempotencyConflictError, IsoStore, queueRetry } from "../src/store.ts";
import type {
	Campaign,
	CampaignCreateInput,
	EvaluationAggregate,
	Experiment,
	ExperimentEvidence,
	Generation,
	Idea,
	PairedEvaluationPlan,
} from "../src/types.ts";

const exec = promisify(execFile);

const DETERMINISTIC_EVALUATOR = [
	'import { readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"const experimentDir = process.env.ISO_EXPERIMENT_DIR;",
	'if (!experimentDir) throw new Error("ISO_EXPERIMENT_DIR is required");',
	'const score = Number(readFileSync(join(experimentDir, "score.txt"), "utf8").trim());',
	'console.log("ISO_RESULT " + JSON.stringify({',
	"  score,",
	"  metrics: { score },",
	"  constraints: { finite: Number.isFinite(score) }",
	"}));",
	"",
].join("\n");

const NOISY_EVALUATOR = [
	'import { readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"const experimentDir = process.env.ISO_EXPERIMENT_DIR;",
	'if (!experimentDir) throw new Error("ISO_EXPERIMENT_DIR is required");',
	'const score = Number(readFileSync(join(experimentDir, "score.txt"), "utf8").trim());',
	"const count = Number(process.env.ISO_SAMPLE_INDEX ?? 0);",
	"const noise = (score > 10 ? [10, 0, -10] : [-10, 0, 10])[count % 3];",
	'console.log("ISO_RESULT " + JSON.stringify({ score: score + noise }));',
	"",
].join("\n");

const IGNORED_ARTIFACT_EVALUATOR = [
	'import { existsSync, readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"const experimentDir = process.env.ISO_EXPERIMENT_DIR;",
	'if (!experimentDir) throw new Error("ISO_EXPERIMENT_DIR is required");',
	'const ignored = join(experimentDir, "ignored-score.txt");',
	'const source = existsSync(ignored) ? ignored : join(experimentDir, "score.txt");',
	'const score = Number(readFileSync(source, "utf8").trim());',
	'console.log("ISO_RESULT " + JSON.stringify({ score }));',
	"",
].join("\n");

const STATEFUL_EVALUATOR = [
	'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"const experimentDir = process.env.ISO_EXPERIMENT_DIR;",
	'if (!experimentDir) throw new Error("ISO_EXPERIMENT_DIR is required");',
	'const marker = join(experimentDir, "evaluator-state.txt");',
	"const leakedState = existsSync(marker);",
	'writeFileSync(marker, "measured\\n");',
	'const base = Number(readFileSync(join(experimentDir, "score.txt"), "utf8").trim());',
	'console.log("ISO_RESULT " + JSON.stringify({ score: base + (leakedState ? 100 : 0) }));',
	"",
].join("\n");

const SCHEMA_MUTATING_EVALUATOR = [
	'import { readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"const experimentDir = process.env.ISO_EXPERIMENT_DIR;",
	'if (!experimentDir) throw new Error("ISO_EXPERIMENT_DIR is required");',
	'const score = Number(readFileSync(join(experimentDir, "score.txt"), "utf8").trim());',
	"let metrics = { frozen: score };",
	"let constraints = { finite: Number.isFinite(score) };",
	"if (score === 11) metrics = {};",
	"if (score === 12) metrics = { frozen: score, added: score };",
	"if (score === 13) constraints = {};",
	"if (score === 14) constraints = { finite: true, added: true };",
	'console.log("ISO_RESULT " + JSON.stringify({ score, metrics, constraints }));',
	"",
].join("\n");

const SAMPLE_INDEX_SCHEMA_MUTATING_EVALUATOR = [
	'import { readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"const experimentDir = process.env.ISO_EXPERIMENT_DIR;",
	'if (!experimentDir) throw new Error("ISO_EXPERIMENT_DIR is required");',
	'const score = Number(readFileSync(join(experimentDir, "score.txt"), "utf8").trim());',
	"const sampleIndex = Number(process.env.ISO_SAMPLE_INDEX ?? 0);",
	"let metrics = { frozen: score };",
	"let constraints = { finite: Number.isFinite(score) };",
	"if (score === 11 && sampleIndex > 0) metrics = {};",
	"if (score === 12 && sampleIndex > 0) constraints = {};",
	'console.log("ISO_RESULT " + JSON.stringify({ score, metrics, constraints }));',
	"",
].join("\n");

const BASELINE_SAMPLE_INDEX_SCHEMA_MUTATING_EVALUATOR = [
	'import { readFileSync } from "node:fs";',
	'import { join } from "node:path";',
	"const experimentDir = process.env.ISO_EXPERIMENT_DIR;",
	'if (!experimentDir) throw new Error("ISO_EXPERIMENT_DIR is required");',
	'const score = Number(readFileSync(join(experimentDir, "score.txt"), "utf8").trim());',
	"const sampleIndex = Number(process.env.ISO_SAMPLE_INDEX ?? 0);",
	"const constraints = sampleIndex === 0 ? { finite: Number.isFinite(score) } : {};",
	'console.log("ISO_RESULT " + JSON.stringify({ score, metrics: { frozen: score }, constraints }));',
	"",
].join("\n");

function abortError(message: string): Error {
	const error = new Error(message);
	error.name = "AbortError";
	return error;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolveDelay) => {
		setTimeout(resolveDelay, milliseconds);
	});
}

async function waitFor(predicate: () => boolean, message: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await delay(10);
	}
}

async function waitForAsync(predicate: () => Promise<boolean>, message: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (!(await predicate())) {
		if (Date.now() >= deadline) {
			throw new Error(message);
		}
		await delay(10);
	}
}

interface ScriptedAgentOptions {
	scores: number[];
	selfCommitIndexes?: number[];
	modifyEvaluator?: boolean;
	waitForAbort?: boolean;
	waitInPlanner?: boolean;
	reflectionStops?: boolean;
	delayMs?: number;
	writeIgnoredArtifact?: boolean;
	duplicatePlans?: boolean;
}

class ScriptedAgents implements ResearchAgents {
	readonly scores: number[];
	readonly selfCommitIndexes: Set<number>;
	readonly modifyEvaluator: boolean;
	readonly waitForAbort: boolean;
	readonly waitInPlanner: boolean;
	readonly reflectionStops: boolean;
	readonly delayMs: number;
	readonly writeIgnoredArtifact: boolean;
	readonly duplicatePlans: boolean;
	readonly plannedBases: string[] = [];
	readonly workerBases: string[] = [];
	plannerEntered = false;
	maxParallelWorkers = 0;
	private releasePlanning?: () => void;
	private parallelWorkers = 0;

	constructor(options: ScriptedAgentOptions) {
		this.scores = options.scores;
		this.selfCommitIndexes = new Set(options.selfCommitIndexes ?? []);
		this.modifyEvaluator = options.modifyEvaluator ?? false;
		this.waitForAbort = options.waitForAbort ?? false;
		this.waitInPlanner = options.waitInPlanner ?? false;
		this.reflectionStops = options.reflectionStops ?? false;
		this.delayMs = options.delayMs ?? 0;
		this.writeIgnoredArtifact = options.writeIgnoredArtifact ?? false;
		this.duplicatePlans = options.duplicatePlans ?? false;
	}

	releasePlanner(): void {
		this.releasePlanning?.();
	}

	async planGeneration(
		options: Parameters<ResearchAgents["planGeneration"]>[0],
	): ReturnType<ResearchAgents["planGeneration"]> {
		this.plannedBases.push(options.generation.baseCommit);
		assert.equal(options.count, this.scores.length);
		if (this.waitInPlanner) {
			this.plannerEntered = true;
			await new Promise<void>((resolvePlanning) => {
				this.releasePlanning = resolvePlanning;
			});
		}
		return {
			thesis: "Deterministically test the score mechanism",
			ideas: this.scores.map((score, index) => ({
				title: `Candidate ${index}`,
				hypothesis: this.duplicatePlans
					? "The same duplicated mechanism raises the score"
					: `Writing ${score} raises the measured score`,
				rationale: "The evaluator directly measures the score fixture",
				implementationPlan: this.duplicatePlans
					? "Apply the same duplicated change"
					: `Write ${score} to score.txt`,
				predictedEffect: `Move score to ${score}`,
				strategy: index === 0 ? "explore" : "exploit",
			})),
			provenance: {
				provider: options.campaign.config.agentModel?.provider ?? "test",
				model: options.campaign.config.agentModel?.model ?? "deterministic-planner",
				thinkingLevel: options.campaign.config.agentModel?.thinkingLevel ?? "off",
				sessionId: `planner-${options.generation.id}`,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
			},
		};
	}

	async runExperiment(
		options: Parameters<ResearchAgents["runExperiment"]>[0],
	): ReturnType<ResearchAgents["runExperiment"]> {
		const index = Number(options.idea.title.replace("Candidate ", ""));
		this.parallelWorkers += 1;
		this.maxParallelWorkers = Math.max(this.maxParallelWorkers, this.parallelWorkers);
		try {
			this.workerBases.push(await resolveCommit(options.cwd));
			options.callbacks.onActivity("Applying deterministic test change");
			options.callbacks.onControl({
				steer: async () => undefined,
				abort: async () => undefined,
			});
			if (this.waitForAbort) {
				await new Promise<void>((_resolve, reject) => {
					if (options.signal.aborted) {
						reject(abortError("Experiment cancelled."));
						return;
					}
					options.signal.addEventListener(
						"abort",
						() => {
							reject(abortError("Experiment cancelled."));
						},
						{ once: true },
					);
				});
			}
			if (this.delayMs > 0) {
				await delay(this.delayMs);
			}
			if (this.modifyEvaluator) {
				await writeFile(join(options.cwd, "evaluator.mjs"), "console.log('ISO_RESULT {\"score\":9999}')\n");
			} else {
				await writeFile(join(options.cwd, "score.txt"), `${this.scores[index]}\n`);
				if (this.writeIgnoredArtifact) {
					await writeFile(join(options.cwd, "ignored-score.txt"), "9999\n");
				}
			}
			if (this.selfCommitIndexes.has(index)) {
				await exec("git", ["add", "--", "score.txt"], { cwd: options.cwd });
				await exec("git", ["commit", "-q", "-m", `worker candidate ${index}`], { cwd: options.cwd });
			}
			return {
				assistantSummary: `Applied candidate ${index}`,
				provenance: {
					provider: options.campaign.config.agentModel?.provider ?? "test",
					model: options.campaign.config.agentModel?.model ?? "deterministic",
					thinkingLevel: options.campaign.config.agentModel?.thinkingLevel ?? "off",
					sessionId: `session-${index}`,
					inputTokens: 10,
					outputTokens: 5,
					cost: 0,
				},
			};
		} finally {
			this.parallelWorkers -= 1;
		}
	}

	async reflectGeneration(
		options: Parameters<ResearchAgents["reflectGeneration"]>[0],
	): ReturnType<ResearchAgents["reflectGeneration"]> {
		const credible = options.experiments.filter((experiment) => experiment.credibleImprovement).length;
		return {
			summary: `${credible} credible candidates`,
			lessons: ["Trust repeated evaluator evidence"],
			deadEnds: options.experiments
				.filter((experiment) => !experiment.credibleImprovement)
				.map((experiment) => experiment.id),
			nextFocus: ["Retest the strongest mechanism"],
			shouldStop: this.reflectionStops,
			stopReason: this.reflectionStops ? "Scripted test stop" : undefined,
			provenance: {
				provider: options.campaign.config.agentModel?.provider ?? "test",
				model: options.campaign.config.agentModel?.model ?? "deterministic-critic",
				thinkingLevel: options.campaign.config.agentModel?.thinkingLevel ?? "off",
				sessionId: `critic-${options.generation.id}`,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
			},
		};
	}
}

class FailingPlannerAgents extends ScriptedAgents {
	readonly reportUsage: boolean;
	planningCalls = 0;

	constructor(reportUsage: boolean) {
		super({ scores: [11] });
		this.reportUsage = reportUsage;
	}

	override async planGeneration(
		options: Parameters<ResearchAgents["planGeneration"]>[0],
	): ReturnType<ResearchAgents["planGeneration"]> {
		this.planningCalls += 1;
		if (this.reportUsage) {
			options.onUsage?.({
				provider: "test",
				model: "failing-planner",
				thinkingLevel: "high",
				sessionId: `failed-planner-${this.planningCalls}`,
				inputTokens: 4,
				outputTokens: 1,
				cost: 0.01,
			});
		}
		throw new Error(`scripted planner failure ${this.planningCalls}`);
	}
}

class FailOnceWorkerAgents extends ScriptedAgents {
	workerCalls = 0;

	override async runExperiment(
		options: Parameters<ResearchAgents["runExperiment"]>[0],
	): ReturnType<ResearchAgents["runExperiment"]> {
		this.workerCalls += 1;
		if (this.workerCalls === 1) {
			throw new Error("scripted ordinary worker failure");
		}
		return super.runExperiment(options);
	}
}

class SequentialScoreAgents extends ScriptedAgents {
	readonly generationScores: number[];

	constructor(generationScores: number[]) {
		super({ scores: [0] });
		this.generationScores = generationScores;
	}

	override async planGeneration(
		options: Parameters<ResearchAgents["planGeneration"]>[0],
	): ReturnType<ResearchAgents["planGeneration"]> {
		const score = this.generationScores[options.generation.index - 1];
		assert.notEqual(score, undefined);
		return {
			thesis: `Advance generation ${options.generation.index} to ${score}`,
			ideas: [
				{
					title: `Sequential candidate ${score}`,
					hypothesis: `Generation ${options.generation.index} raises the score to ${score}`,
					rationale: "Each generation advances from the prior champion",
					implementationPlan: `Write ${score} to score.txt in generation ${options.generation.index}`,
					predictedEffect: `Move score to ${score}`,
					strategy: "exploit",
				},
			],
			provenance: {
				provider: "test",
				model: "sequential-planner",
				thinkingLevel: "off",
				sessionId: `sequential-planner-${options.generation.index}`,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
			},
		};
	}

	override async runExperiment(
		options: Parameters<ResearchAgents["runExperiment"]>[0],
	): ReturnType<ResearchAgents["runExperiment"]> {
		const score = Number(options.idea.title.replace("Sequential candidate ", ""));
		await writeFile(join(options.cwd, "score.txt"), `${score}\n`);
		return {
			assistantSummary: `Advanced score to ${score}`,
			provenance: {
				provider: "test",
				model: "sequential-worker",
				thinkingLevel: "off",
				sessionId: `sequential-worker-${score}`,
				inputTokens: 0,
				outputTokens: 0,
				cost: 0,
			},
		};
	}
}

function mockEvaluation(score: number, valid: boolean, trialId: string): EvaluationAggregate {
	const scoreSummary = { mean: score, median: score, stddev: 0, min: score, max: score };
	return {
		score: scoreSummary,
		metrics: { score: scoreSummary },
		samples: Array.from({ length: 3 }, (_, sampleIndex) => ({
			score,
			metrics: { score },
			valid,
			constraints: { finite: valid },
			trialId: `${trialId}-${sampleIndex}`,
			phase: "sample",
			sampleIndex,
			seed: sampleIndex,
			durationMs: 1,
			stdout: "",
			stderr: "",
		})),
		valid,
		failedConstraints: valid ? [] : ["finite"],
		measuredAt: new Date().toISOString(),
	};
}

function pairedEvaluationPlan(id: string, samples: number): PairedEvaluationPlan {
	return {
		id,
		kind: "screen",
		trialIds: Array.from({ length: samples }, (_, index) => `${id}-trial-${index}`),
		startsWithCandidate: true,
		createdAt: "2026-01-01T00:00:00.000Z",
	};
}

function sampleIdentityForTest(sample: EvaluationAggregate["samples"][number]): {
	trialId?: string;
	phase?: EvaluationAggregate["samples"][number]["phase"];
	sampleIndex?: number;
	seed?: number;
} {
	return {
		trialId: sample.trialId,
		phase: sample.phase,
		sampleIndex: sample.sampleIndex,
		seed: sample.seed,
	};
}

function storedCampaignInput(root: string): CampaignCreateInput {
	const commit = "a".repeat(40);
	const measuredAt = new Date().toISOString();
	return {
		goal: "Recover interrupted research",
		metric: { name: "score", direction: "maximize", minimumImprovement: 1 },
		config: {
			workers: 1,
			agentTimeoutMs: 10_000,
			evaluator: {
				command: "node evaluator.mjs",
				controlCwd: root,
				samples: 3,
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

function controlRequest(
	state: Awaited<ReturnType<IsoStore["read"]>>,
	actionId: string,
	actionFingerprint: string,
	action: ResearchControlRequest["action"],
): ResearchControlRequest {
	const context = controlContextForState(state);
	assert.ok(context);
	return {
		actionId,
		actionFingerprint,
		targetKind: context.target.kind,
		targetId: context.target.id,
		expectedControlFingerprint: context.target.fingerprint,
		action,
	};
}

async function createFixture(
	agents: ResearchAgents,
	options: {
		evaluatorSource?: string;
		packageJson?: string;
		workers?: number;
		maxExperiments?: number;
		minimumImprovement?: number;
		samples?: number;
		scoreBounds?: { min: number; max: number };
	} = {},
): Promise<{ root: string; runtime: IsoRuntime; sourceCommit: string }> {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
	await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".iso/\nignored-score.txt\n");
	await writeFile(join(root, "evaluator.mjs"), options.evaluatorSource ?? DETERMINISTIC_EVALUATOR);
	await writeFile(join(root, "score.txt"), "10\n");
	const trackedPaths = [".gitignore", "evaluator.mjs", "score.txt"];
	if (options.packageJson !== undefined) {
		await writeFile(join(root, "package.json"), options.packageJson);
		trackedPaths.push("package.json");
	}
	await exec("git", ["add", "--", ...trackedPaths], { cwd: root });
	await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	const sourceCommit = await resolveCommit(root);
	const runtime = new IsoRuntime(root, new IsoStore(root), agents);
	await runtime.calibrateCampaign({
		goal: "Maximize the deterministic score",
		metric: {
			name: "score",
			direction: "maximize",
			minimumImprovement: options.minimumImprovement ?? 1,
		},
		config: {
			workers: options.workers ?? 2,
			agentTimeoutMs: 10_000,
			evaluator: {
				command: "exec node evaluator.mjs",
				controlCwd: ".",
				samples: options.samples ?? 3,
				warmups: 0,
				timeoutMs: 10_000,
				protectedPaths: ["evaluator.mjs"],
				...(options.scoreBounds === undefined ? {} : { scoreBounds: options.scoreBounds }),
			},
			budget: {
				maxGenerations: 1,
				maxExperiments: options.maxExperiments ?? 2,
				maxWallClockMs: 60_000,
				maxConsecutivePlateaus: 1,
				maxFailures: 5,
			},
		},
	});
	return { root, runtime, sourceCommit };
}

async function createMissionFixture(): Promise<{
	root: string;
	input: Parameters<IsoRuntime["launchMission"]>[0];
}> {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-mission-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
	await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".iso/\n");
	await writeFile(
		join(root, "evaluator.mjs"),
		[
			'import { existsSync, readFileSync } from "node:fs";',
			'import { join } from "node:path";',
			"const experimentDir = process.env.ISO_EXPERIMENT_DIR;",
			'if (!experimentDir) throw new Error("ISO_EXPERIMENT_DIR is required");',
			"await new Promise((resolve) => setTimeout(resolve, 750));",
			'const score = Number(readFileSync(join(experimentDir, "score.txt"), "utf8").trim());',
			'console.log("ISO_RESULT " + JSON.stringify({ score }));',
			"",
		].join("\n"),
	);
	await writeFile(join(root, "score.txt"), "10\n");
	await exec("git", ["add", "--", ".gitignore", "evaluator.mjs", "score.txt"], { cwd: root });
	await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	return {
		root,
		input: {
			goal: "Durably launch and resume a one-prompt mission",
			metric: { name: "score", direction: "maximize", minimumImprovement: 1 },
			config: {
				workers: 1,
				agentTimeoutMs: 10_000,
				evaluator: {
					command: "exec node evaluator.mjs",
					controlCwd: ".",
					samples: 2,
					warmups: 0,
					timeoutMs: 60_000,
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
		},
	};
}

test("uses exact Student-t critical values through df 30 and a continuous large-df approximation", () => {
	assert.equal(critical95(1), 12.706204736174705);
	assert.equal(critical95(6), 2.44691185114497);
	assert.equal(critical95(11), 2.2009851600916397);
	assert.equal(critical95(16), 2.1199052992212546);
	assert.equal(critical95(29), 2.0452296421327043);
	assert.equal(critical95(30), 2.042272456301238);

	assert.ok(Math.abs(critical95(31) - 2.0395134463964086) < 3e-8);
	assert.ok(Math.abs(critical95(100) - 1.9839715185235522) < 1e-9);
	assert.ok(critical95(31) < critical95(30));
	assert.ok(critical95(10_000) > 1.959963984540054);
	assert.throws(() => critical95(0), RangeError);
	assert.throws(() => critical95(1.5), RangeError);
});

test("runs a pinned parallel generation and promotes only the strongest credible candidate", async () => {
	const agents = new ScriptedAgents({
		scores: [14, 20],
		selfCommitIndexes: [1],
		delayMs: 30,
	});
	const fixture = await createFixture(agents);
	try {
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const campaign = snapshot.state.campaigns[0];
		const generation = snapshot.state.generations[0];
		const champion = snapshot.state.experiments.find((experiment) => experiment.id === campaign.championExperimentId);

		assert.equal(campaign.status, "completed");
		assert.match(campaign.stopReason ?? "", /Generation budget reached/);
		assert.equal(campaign.baseline.evaluation.samples.length, 3);
		assert.equal(generation.status, "completed");
		assert.equal(generation.baseCommit, fixture.sourceCommit);
		assert.deepEqual(agents.plannedBases, [fixture.sourceCommit]);
		assert.deepEqual(agents.workerBases, [fixture.sourceCommit, fixture.sourceCommit]);
		assert.equal(agents.maxParallelWorkers, 2);
		assert.equal(snapshot.state.experiments.length, 2);
		assert.ok(snapshot.state.experiments.every((experiment) => experiment.baseCommit === fixture.sourceCommit));
		assert.ok(snapshot.state.experiments.every((experiment) => experiment.screeningPassed === true));
		assert.equal(
			snapshot.state.experiments.filter((experiment) => experiment.credibleImprovement === true).length,
			1,
		);
		assert.equal(champion?.credibleImprovement, true);
		assert.equal(champion?.evaluation?.score.median, 20);
		assert.equal(snapshot.state.reflections.length, 1);
		assert.equal(campaign.completionReport?.champion?.candidateCommit, champion?.candidateCommit);
		assert.equal(campaign.completionReport?.outcome, "completed");
		assert.equal(campaign.completionReport?.agentUsage.inputTokens, 20);
		assert.equal(campaign.completionReport?.agentUsage.outputTokens, 10);
		assert.ok(snapshot.state.events.some((event) => event.type === "champion.promoted"));
		assert.equal(snapshot.graph.nodes.filter((node) => node.status === "screening-passed").length, 2);
		assert.equal(snapshot.graph.nodes.filter((node) => node.status === "confirmed-promotion").length, 1);
		assert.ok(snapshot.graph.nodes.some((node) => node.label === "Confirmed promotion: 20"));

		for (const experiment of snapshot.state.experiments) {
			assert.ok(experiment.candidateCommit);
			const parent = await exec("git", ["show", "-s", "--format=%P", experiment.candidateCommit], {
				cwd: fixture.root,
			});
			assert.equal(parent.stdout.trim(), fixture.sourceCommit);
		}
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("uses the declared bounded post-selection gate in the end-to-end research loop", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [20] }), {
		workers: 1,
		maxExperiments: 1,
		minimumImprovement: 1,
		samples: 10,
		scoreBounds: { min: 10, max: 20 },
	});
	try {
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const campaign = snapshot.state.campaigns[0];
		const champion = snapshot.state.experiments.find((experiment) => experiment.id === campaign.championExperimentId);
		assert.ok(champion);
		assert.equal(champion.confirmationHistory?.length, 1);
		const selection = champion.confirmationHistory?.[0]?.selection;
		assert.equal(selection?.method, "paired-bounded-hoeffding-bonferroni-v1");
		assert.equal(selection?.claimClass, "bounded-independent-trials-fwer");
		assert.equal(selection?.promoted, true);
		assert.equal(selection?.maxOpportunities, 1);
		assert.equal(selection?.opportunityIndex, 1);
		assert.ok((selection?.lowerBound ?? Number.NEGATIVE_INFINITY) >= 1);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("labels cumulative and final-step champion handoff effects across generations", async () => {
	const fixture = await createFixture(new SequentialScoreAgents([12, 15]), {
		workers: 1,
		maxExperiments: 2,
		samples: 2,
	});
	try {
		await fixture.runtime.store.update((state) => {
			state.campaigns[0].config.budget.maxGenerations = 2;
			state.campaigns[0].config.budget.maxConsecutivePlateaus = 2;
		});
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const handoff = await fixture.runtime.championHandoff();
		assert.equal(snapshot.state.generations.length, 2);
		assert.equal(snapshot.state.experiments[0].confirmationImprovement, 2);
		assert.equal(snapshot.state.experiments[1].confirmationImprovement, 3);
		assert.equal(handoff?.baselineScore, 10);
		assert.equal(handoff?.championScore, 15);
		assert.equal(handoff?.cumulativeImprovement, 5);
		assert.equal(handoff?.cumulativeUncertainty, 0);
		assert.equal(handoff?.stepImprovement, 3);
		assert.equal(handoff?.stepUncertainty, 0);
		assert.equal(handoff?.improvement, 5);
		assert.equal(handoff?.uncertainty, 0);
		assert.equal(snapshot.state.campaigns[0].completionReport?.champion?.cumulativeImprovement, 5);
		assert.equal(snapshot.state.campaigns[0].completionReport?.champion?.stepImprovement, 3);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("enforces optional aggregate token budgets at a durable generation boundary", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [11] }), {
		workers: 1,
		maxExperiments: 1,
	});
	try {
		await fixture.runtime.store.update((state) => {
			state.campaigns[0].config.budget.maxGenerations = 2;
			state.campaigns[0].config.budget.maxExperiments = 2;
			state.campaigns[0].config.budget.maxInputTokens = 5;
		});
		await fixture.runtime.runToCompletion();
		const campaign = (await fixture.runtime.snapshot()).state.campaigns[0];
		assert.equal(campaign.status, "completed");
		assert.equal(campaign.generationsCompleted, 1);
		assert.equal(campaign.experimentsStarted, 1);
		assert.equal(campaign.stopReason, "Input-token budget reached (5)");
		assert.equal(campaign.completionReport?.agentUsage.inputTokens, 10);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("charges failed planner retries to the durable usage ledger and token budget", async () => {
	const agents = new FailingPlannerAgents(true);
	const fixture = await createFixture(agents, { workers: 1, maxExperiments: 1 });
	try {
		await fixture.runtime.store.update((state) => {
			state.campaigns[0].config.budget.maxGenerations = 10;
			state.campaigns[0].config.budget.maxExperiments = 10;
			state.campaigns[0].config.budget.maxFailures = 10;
			state.campaigns[0].config.budget.maxInputTokens = 5;
		});
		await fixture.runtime.runToCompletion();

		const snapshot = await fixture.runtime.snapshot();
		const summary = await fixture.runtime.summary();
		const attempts = snapshot.state.agentCallAttempts.filter((attempt) => attempt.role === "planner");
		assert.equal(agents.planningCalls, 3);
		assert.equal(attempts.length, 3);
		assert.ok(attempts.every((attempt) => attempt.status === "failed"));
		assert.ok(attempts.every((attempt) => attempt.missingTokenAccounting === false));
		assert.deepEqual(
			attempts.map((attempt) => attempt.inputTokens),
			[4, 4, 4],
		);
		assert.equal(summary.agentUsage.inputTokens, 12);
		assert.equal(summary.agentUsage.outputTokens, 3);
		assert.equal(summary.agentUsage.costUsd, 0.03);
		assert.equal(summary.agentUsage.agentCalls, 3);
		assert.equal(snapshot.state.campaigns[0].stopReason, "Input-token budget reached (5)");
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("fails closed at the boundary when failed agent calls lack usage accounting", async () => {
	const agents = new FailingPlannerAgents(false);
	const fixture = await createFixture(agents, { workers: 1, maxExperiments: 1 });
	try {
		await fixture.runtime.store.update((state) => {
			state.campaigns[0].config.budget.maxGenerations = 10;
			state.campaigns[0].config.budget.maxExperiments = 10;
			state.campaigns[0].config.budget.maxFailures = 10;
			state.campaigns[0].config.budget.maxInputTokens = 100;
		});
		await fixture.runtime.runToCompletion();

		const snapshot = await fixture.runtime.snapshot();
		const summary = await fixture.runtime.summary();
		const attempts = snapshot.state.agentCallAttempts.filter((attempt) => attempt.role === "planner");
		assert.equal(attempts.length, 3);
		assert.ok(attempts.every((attempt) => attempt.status === "failed"));
		assert.ok(attempts.every((attempt) => attempt.missingTokenAccounting));
		assert.equal(summary.agentUsage.callsMissingTokenAccounting, 3);
		assert.equal(
			snapshot.state.campaigns[0].stopReason,
			"Token budget accounting became unavailable; stopped at the generation boundary",
		);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("fails closed before prompting when the exact pinned research model is unavailable", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-pinned-model-"));
	const store = new IsoStore(root);
	try {
		const input = storedCampaignInput(root);
		input.config.agentModel = {
			provider: "iso-test-provider-does-not-exist",
			model: "iso-test-model-does-not-exist",
			thinkingLevel: "high",
		};
		const campaign = await store.initialize(input);
		const generation: Generation = {
			id: "generation_pinned_model",
			campaignId: campaign.id,
			index: 1,
			status: "planning",
			baseCommit: campaign.sourceCommit,
			ideaIds: [],
			experimentIds: [],
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		};
		await assert.rejects(
			new PiResearchAgents().planGeneration({
				cwd: root,
				state: await store.read(),
				campaign,
				generation,
				count: 1,
				timeoutMs: 1_000,
				signal: new AbortController().signal,
			}),
			/Pinned research model is unavailable: iso-test-provider-does-not-exist\/iso-test-model-does-not-exist/,
		);
	} finally {
		store.close();
		await rm(root, { recursive: true });
	}
});

test("does not promote a nominal improvement that is smaller than measured uncertainty", async () => {
	const agents = new ScriptedAgents({ scores: [12] });
	const fixture = await createFixture(agents, {
		evaluatorSource: NOISY_EVALUATOR,
		workers: 1,
		maxExperiments: 1,
	});
	try {
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const experiment = snapshot.state.experiments[0];
		assert.equal(experiment.evaluation?.score.median, 12);
		assert.equal(experiment.improvement, 2);
		assert.ok((experiment.uncertainty ?? 0) > 2);
		assert.equal(experiment.credibleImprovement, false);
		assert.equal(snapshot.state.campaigns[0].championExperimentId, undefined);
		assert.equal(snapshot.state.campaigns[0].consecutivePlateaus, 1);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("rejects a provisional winner that fails fresh post-selection replication", async () => {
	const agents = new ScriptedAgents({ scores: [20] });
	const fixture = await createFixture(agents, {
		workers: 1,
		maxExperiments: 1,
	});
	const evaluations = [
		mockEvaluation(10, true, "screen"),
		mockEvaluation(20, true, "screen"),
		mockEvaluation(10, true, "confirmation"),
		mockEvaluation(9, true, "confirmation"),
	];
	let evaluationCalls = 0;
	(
		fixture.runtime as unknown as {
			evaluateFrozenPair: (
				...arguments_: unknown[]
			) => Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }>;
		}
	).evaluateFrozenPair = async () => {
		const incumbent = evaluations[evaluationCalls];
		const candidate = evaluations[evaluationCalls + 1];
		evaluationCalls += 2;
		if (!incumbent || !candidate) {
			throw new Error("Unexpected extra evaluator call during holdout confirmation.");
		}
		return { incumbent, candidate };
	};
	try {
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const experiment = snapshot.state.experiments[0];
		assert.equal(evaluationCalls, 4);
		assert.equal(experiment.evaluation?.score.median, 20);
		assert.equal(experiment.confirmationEvaluation?.score.median, 9);
		assert.equal(experiment.confirmationRoundsPassed, 0);
		assert.equal(experiment.credibleImprovement, false);
		assert.equal(snapshot.state.campaigns[0].championExperimentId, undefined);
		assert.ok(snapshot.state.events.some((event) => event.type === "champion.confirmation-rejected"));
		assert.ok(!snapshot.state.events.some((event) => event.type === "champion.promoted"));
		assert.ok(snapshot.graph.nodes.some((node) => node.status === "screening-passed"));
		assert.ok(
			snapshot.graph.nodes.some(
				(node) => node.status === "confirmation-rejection" && node.label === "Confirmation rejected: 9",
			),
		);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("preserves complete immutable evidence for the fresh post-selection replication block", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [11] }), {
		workers: 1,
		maxExperiments: 21,
		samples: 2,
	});
	try {
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const experiment = snapshot.state.experiments[0];
		const history = experiment.confirmationHistory;
		assert.equal(experiment.confirmationRoundsPassed, 1);
		assert.equal(history?.length, 1);
		assert.deepEqual(
			history?.map((round) => round.round),
			[1],
		);
		for (const round of history ?? []) {
			const candidateEvaluation = round.candidateEvaluation;
			const incumbentEvaluation = round.incumbentEvaluation;
			const interval = round.interval;
			const identities = round.sampleIdentities;
			assert.ok(candidateEvaluation);
			assert.ok(incumbentEvaluation);
			assert.ok(interval);
			assert.ok(identities);
			assert.equal(candidateEvaluation.score.mean, 11);
			assert.equal(incumbentEvaluation.score.mean, 10);
			assert.equal(candidateEvaluation.samples.length, 2);
			assert.equal(incumbentEvaluation.samples.length, 2);
			assert.equal(interval.method, "paired-student-t-bonferroni-v1");
			assert.equal(interval.df, undefined);
			assert.equal(interval.alpha, 0.05);
			assert.equal(interval.uncertainty, 0);
			assert.equal(interval.lowerBound, 1);
			assert.deepEqual(identities.candidate, candidateEvaluation.samples.map(sampleIdentityForTest));
			assert.deepEqual(identities.incumbent, incumbentEvaluation.samples.map(sampleIdentityForTest));
			assert.equal(round.selection?.claimClass, "assumption-based-paired-student-t");
			assert.equal(round.selection?.opportunityIndex, 1);
		}
		assert.deepEqual(experiment.confirmationEvaluation, history?.[0].candidateEvaluation);
		assert.deepEqual(experiment.confirmationIncumbentEvaluation, history?.[0].incumbentEvaluation);

		const evidence = await fixture.runtime.queryEvidence({
			kind: "experiments",
			experimentId: experiment.id,
		});
		const projected = evidence.items[0] as ExperimentEvidence;
		assert.equal(projected.confirmationRoundsPassed, 1);
		assert.deepEqual(projected.confirmationHistory, history);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("fails the campaign when the incumbent becomes invalid during confirmation", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-invalid-incumbent-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
	await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".iso/\n");
	await writeFile(join(root, "evaluator.mjs"), DETERMINISTIC_EVALUATOR);
	await writeFile(join(root, "score.txt"), "10\n");
	await exec("git", ["add", "--", ".gitignore", "evaluator.mjs", "score.txt"], { cwd: root });
	await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	const sourceCommit = await resolveCommit(root);
	const store = new IsoStore(root);
	const runtime = new IsoRuntime(root, store, new ScriptedAgents({ scores: [20] }));
	const campaignInput = storedCampaignInput(root);
	campaignInput.sourceCommit = sourceCommit;
	campaignInput.baseline.commit = sourceCommit;
	await store.initialize(campaignInput);

	let evaluationCalls = 0;
	const internals = runtime as unknown as {
		confirmCandidate: (
			campaign: Awaited<ReturnType<IsoStore["initialize"]>>,
			generation: Generation,
			experiment: Experiment,
			round: number,
		) => Promise<boolean>;
		evaluateFrozenPair: (
			...arguments_: unknown[]
		) => Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }>;
		verifyAndSelect: (campaignId: string, generationId: string) => Promise<void>;
	};
	const confirmCandidate = internals.confirmCandidate.bind(runtime);
	internals.evaluateFrozenPair = async () => {
		evaluationCalls += 1;
		return {
			incumbent: mockEvaluation(10, false, "confirmation"),
			candidate: mockEvaluation(20, true, "confirmation"),
		};
	};
	internals.verifyAndSelect = async (campaignId, generationId) => {
		const state = await store.read();
		const campaign = state.campaigns.find((entry) => entry.id === campaignId);
		const generation = state.generations.find((entry) => entry.id === generationId);
		const experiment = state.experiments.find((entry) => entry.generationId === generationId);
		assert.ok(campaign);
		assert.ok(generation);
		assert.ok(experiment?.candidateCommit);
		await confirmCandidate(campaign, generation, experiment, 1);
	};

	try {
		await assert.rejects(
			runtime.runToCompletion(),
			(error: unknown) =>
				error instanceof Error &&
				error.name === "IncumbentInvalidError" &&
				error.message === "Incumbent failed evaluator constraints during confirmation 1: finite",
		);
		const snapshot = await runtime.snapshot();
		const campaign = snapshot.state.campaigns[0];
		const generation = snapshot.state.generations[0];
		const experiment = snapshot.state.experiments[0];

		assert.equal(evaluationCalls, 1);
		assert.equal(campaign.status, "failed");
		assert.equal(campaign.runIntent, "idle");
		assert.equal(campaign.stopReason, "Incumbent failed evaluator constraints during confirmation 1: finite");
		assert.equal(campaign.championExperimentId, undefined);
		assert.equal(generation.status, "failed");
		assert.equal(experiment.status, "interrupted");
		assert.equal(experiment.confirmationEvaluation, undefined);
		assert.ok(snapshot.state.events.some((event) => event.type === "campaign.failed"));
		assert.ok(!snapshot.state.events.some((event) => event.type === "champion.confirmation-rejected"));
		assert.ok(!snapshot.state.events.some((event) => event.type === "champion.confirmation-failed"));
	} finally {
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("evaluates only the frozen candidate commit, excluding ignored worker artifacts", async () => {
	const agents = new ScriptedAgents({ scores: [11], writeIgnoredArtifact: true });
	const fixture = await createFixture(agents, {
		evaluatorSource: IGNORED_ARTIFACT_EVALUATOR,
		workers: 1,
		maxExperiments: 1,
	});
	try {
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const experiment = snapshot.state.experiments[0];
		assert.equal(experiment.evaluation?.score.median, 11);
		assert.deepEqual(experiment.changedPaths, ["score.txt"]);
		assert.ok(experiment.candidateCommit);
		assert.equal(snapshot.state.campaigns[0].championExperimentId, experiment.id);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("uses fresh materializations and alternating arm order for every paired sample", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [11] }), {
		evaluatorSource: STATEFUL_EVALUATOR,
		workers: 1,
		maxExperiments: 1,
		samples: 3,
	});
	try {
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const experiment = snapshot.state.experiments[0];
		assert.deepEqual(
			snapshot.state.campaigns[0].baseline.evaluation.samples.map((sample) => sample.score),
			[10, 10, 10],
			"baseline samples must not share evaluator-written state",
		);
		assert.deepEqual(
			experiment.incumbentEvaluation?.samples.map((sample) => sample.score),
			[10, 10, 10],
		);
		assert.deepEqual(
			experiment.evaluation?.samples.map((sample) => sample.score),
			[11, 11, 11],
		);
		assert.deepEqual(
			experiment.evaluation?.samples.map((sample) => sample.trialId),
			experiment.incumbentEvaluation?.samples.map((sample) => sample.trialId),
		);
		assert.equal(new Set(experiment.evaluation?.samples.map((sample) => sample.trialId)).size, 3);
		assert.equal(experiment.screeningPlan?.trialIds.length, 3);
		assert.equal(experiment.confirmationPlan?.trialIds.length, 3);
		assert.equal(
			experiment.screeningPlan?.trialIds.some((trialId) => experiment.confirmationPlan?.trialIds.includes(trialId)),
			false,
		);
		const candidateFrozenSequence = snapshot.state.events.find(
			(event) => event.experimentId === experiment.id && event.type === "candidate.frozen",
		)?.sequence;
		const planFrozenSequence = snapshot.state.events.find(
			(event) => event.experimentId === experiment.id && event.type === "evaluator.screen-plan-frozen",
		)?.sequence;
		assert.ok(candidateFrozenSequence !== undefined);
		assert.ok(planFrozenSequence !== undefined);
		assert.ok(candidateFrozenSequence < planFrozenSequence);

		const armOrder: string[] = [];
		const internals = fixture.runtime as unknown as {
			evaluateFrozenPair: (
				campaign: (typeof snapshot.state.campaigns)[number],
				incumbentCommit: string,
				candidateCommit: string,
				plan: PairedEvaluationPlan,
			) => Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }>;
			evaluateFrozenSample: (
				campaign: (typeof snapshot.state.campaigns)[number],
				commit: string,
				worktreeId: string,
				controlWorktree: string,
				signal: AbortSignal | undefined,
				trialId: string,
				sampleIndex: number,
			) => Promise<EvaluationAggregate>;
		};
		internals.evaluateFrozenSample = async (
			_campaign,
			_commit,
			worktreeId,
			_controlWorktree,
			_signal,
			trialId,
			sampleIndex,
		) => {
			armOrder.push(worktreeId);
			const score = worktreeId.endsWith("-candidate") ? 11 : 10;
			const scoreSummary = { mean: score, median: score, stddev: 0, min: score, max: score };
			return {
				score: scoreSummary,
				metrics: {},
				samples: [
					{
						score,
						metrics: {},
						valid: true,
						constraints: {},
						trialId,
						phase: "sample",
						sampleIndex,
						seed: 1,
						durationMs: 1,
						stdout: "",
						stderr: "",
					},
				],
				valid: true,
				failedConstraints: [],
				measuredAt: new Date().toISOString(),
			};
		};
		await internals.evaluateFrozenPair(
			snapshot.state.campaigns[0],
			fixture.sourceCommit,
			experiment.candidateCommit ?? fixture.sourceCommit,
			pairedEvaluationPlan("order-regression", 3),
		);
		const firstArms = [armOrder[0], armOrder[2], armOrder[4]].map((entry) =>
			entry.endsWith("-candidate") ? "candidate" : "incumbent",
		);
		assert.deepEqual(firstArms, [
			firstArms[0],
			firstArms[0] === "candidate" ? "incumbent" : "candidate",
			firstArms[0],
		]);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("validates every recombined incumbent sample before screening or confirmation", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [11] }), {
		workers: 1,
		maxExperiments: 1,
		samples: 3,
	});
	try {
		const campaign = (await fixture.runtime.snapshot()).state.campaigns[0];
		const internals = fixture.runtime as unknown as {
			evaluateFrozenPair: (
				campaign: Campaign,
				incumbentCommit: string,
				candidateCommit: string,
				plan: PairedEvaluationPlan,
			) => Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }>;
			evaluateFrozenSample: (
				campaign: Campaign,
				commit: string,
				worktreeId: string,
				controlWorktree: string,
				signal: AbortSignal | undefined,
				trialId: string,
				sampleIndex: number,
			) => Promise<EvaluationAggregate>;
		};
		internals.evaluateFrozenSample = async (
			_campaign,
			_commit,
			worktreeId,
			_controlWorktree,
			_signal,
			trialId,
			sampleIndex,
		) => {
			const incumbent = worktreeId.endsWith("-incumbent");
			const constraints: Record<string, boolean> = incumbent && sampleIndex > 0 ? {} : { finite: true };
			const score = incumbent ? 10 : 11;
			const summary = { mean: score, median: score, stddev: 0, min: score, max: score };
			return {
				score: summary,
				metrics: { score: summary },
				samples: [
					{
						score,
						metrics: { score },
						valid: true,
						constraints,
						trialId,
						phase: "sample",
						sampleIndex,
						seed: sampleIndex,
						durationMs: 1,
						stdout: "",
						stderr: "",
					},
				],
				valid: true,
				failedConstraints: [],
				measuredAt: new Date().toISOString(),
			};
		};
		await assert.rejects(
			internals.evaluateFrozenPair(
				campaign,
				fixture.sourceCommit,
				fixture.sourceCommit,
				pairedEvaluationPlan("incumbent-sample-schema-regression", campaign.config.evaluator.samples),
			),
			/Evaluator constraint schema changed from \[finite\] to \[\]\./,
		);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("classifies incumbent-arm contract violations separately from candidate-invalid output", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [11] }), {
		workers: 1,
		maxExperiments: 1,
		samples: 2,
	});
	try {
		const campaign = (await fixture.runtime.snapshot()).state.campaigns[0];
		const internals = fixture.runtime as unknown as {
			evaluateFrozenPair: (
				campaign: Campaign,
				incumbentCommit: string,
				candidateCommit: string,
				plan: PairedEvaluationPlan,
			) => Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }>;
			evaluateFrozenSample: (
				campaign: Campaign,
				commit: string,
				worktreeId: string,
				controlWorktree: string,
				signal: AbortSignal | undefined,
				trialId: string,
				sampleIndex: number,
			) => Promise<EvaluationAggregate>;
		};
		internals.evaluateFrozenSample = async (
			_campaign,
			_commit,
			worktreeId,
			_controlWorktree,
			_signal,
			trialId,
			sampleIndex,
		) => {
			if (worktreeId.endsWith("-incumbent")) {
				throw new EvaluatorContractError("missing ISO_RESULT");
			}
			const evaluation = mockEvaluation(11, true, trialId);
			evaluation.samples = [evaluation.samples[sampleIndex] ?? evaluation.samples[0]];
			return evaluation;
		};
		await assert.rejects(
			internals.evaluateFrozenPair(
				campaign,
				fixture.sourceCommit,
				fixture.sourceCommit,
				pairedEvaluationPlan("incumbent-arm-contract", campaign.config.evaluator.samples),
			),
			(error: unknown) =>
				error instanceof Error &&
				error.name === "IncumbentInvalidError" &&
				/Incumbent evaluator output violated the frozen contract: missing ISO_RESULT/.test(error.message),
		);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("freezes metric and constraint key schemas against candidate-controlled changes", async (context) => {
	const mutations = [
		{
			name: "dropped metric",
			score: 11,
			expected: /Evaluator metric schema changed from \[frozen\] to \[\]\./,
		},
		{
			name: "added metric",
			score: 12,
			expected: /Evaluator metric schema changed from \[frozen\] to \[added, frozen\]\./,
		},
		{
			name: "dropped constraint",
			score: 13,
			expected: /Evaluator constraint schema changed from \[finite\] to \[\]\./,
		},
		{
			name: "added constraint",
			score: 14,
			expected: /Evaluator constraint schema changed from \[finite\] to \[added, finite\]\./,
		},
	];

	for (const mutation of mutations) {
		await context.test(mutation.name, async () => {
			const fixture = await createFixture(new ScriptedAgents({ scores: [mutation.score] }), {
				evaluatorSource: SCHEMA_MUTATING_EVALUATOR,
				workers: 1,
				maxExperiments: 1,
				samples: 2,
			});
			try {
				await fixture.runtime.runToCompletion();
				const snapshot = await fixture.runtime.snapshot();
				const experiment = snapshot.state.experiments[0];

				assert.equal(experiment.status, "invalid");
				assert.equal(experiment.failure?.phase, "evaluator");
				assert.equal(experiment.failure?.kind, "invalid-result");
				assert.match(experiment.failure?.message ?? "", mutation.expected);
				assert.equal(experiment.evaluation, undefined);
				assert.equal(snapshot.state.campaigns[0].championExperimentId, undefined);
				assert.ok(
					snapshot.state.events.some(
						(event) => event.type === "experiment.invalid" && mutation.expected.test(event.summary),
					),
				);
			} finally {
				await fixture.runtime.shutdown();
				await rm(fixture.root, { recursive: true });
			}
		});
	}
});

test("validates every recombined candidate sample against the frozen result schema", async (context) => {
	const mutations = [
		{
			name: "metric omitted after sample zero",
			score: 11,
			expected: /Evaluator metric schema changed from \[frozen\] to \[\]\./,
		},
		{
			name: "required constraint omitted after sample zero",
			score: 12,
			expected: /Evaluator constraint schema changed from \[finite\] to \[\]\./,
		},
	];

	for (const mutation of mutations) {
		await context.test(mutation.name, async () => {
			const fixture = await createFixture(new ScriptedAgents({ scores: [mutation.score] }), {
				evaluatorSource: SAMPLE_INDEX_SCHEMA_MUTATING_EVALUATOR,
				workers: 1,
				maxExperiments: 1,
				samples: 3,
			});
			try {
				await fixture.runtime.runToCompletion();
				const snapshot = await fixture.runtime.snapshot();
				const experiment = snapshot.state.experiments[0];
				assert.equal(experiment.status, "invalid");
				assert.equal(experiment.failure?.phase, "evaluator");
				assert.equal(experiment.failure?.kind, "invalid-result");
				assert.match(experiment.failure?.message ?? "", mutation.expected);
				assert.equal(experiment.evaluation, undefined);
				assert.equal(snapshot.state.campaigns[0].championExperimentId, undefined);
			} finally {
				await fixture.runtime.shutdown();
				await rm(fixture.root, { recursive: true });
			}
		});
	}
});

test("rejects baseline calibration when a required constraint disappears after sample zero", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-baseline-sample-schema-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
	await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".iso/\n");
	await writeFile(join(root, "evaluator.mjs"), BASELINE_SAMPLE_INDEX_SCHEMA_MUTATING_EVALUATOR);
	await writeFile(join(root, "score.txt"), "10\n");
	await exec("git", ["add", "--", ".gitignore", "evaluator.mjs", "score.txt"], { cwd: root });
	await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	const runtime = new IsoRuntime(root, new IsoStore(root), new ScriptedAgents({ scores: [11] }));
	try {
		await assert.rejects(
			runtime.calibrateCampaign({
				goal: "Reject a drifting baseline schema",
				metric: { name: "score", direction: "maximize", minimumImprovement: 1 },
				config: {
					workers: 1,
					agentTimeoutMs: 10_000,
					evaluator: {
						command: "exec node evaluator.mjs",
						controlCwd: ".",
						samples: 3,
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
			}),
			/Evaluator constraint schema changed from \[finite\] to \[\]\./,
		);
		assert.equal((await runtime.snapshot()).state.campaigns.length, 0);
	} finally {
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("fails closed on runtime provenance drift before planning or worker dispatch", async () => {
	const agents = new ScriptedAgents({ scores: [20] });
	const fixture = await createFixture(agents, { workers: 1, maxExperiments: 1 });
	const store = new IsoStore(fixture.root);
	try {
		await store.update((state) => {
			const campaign = state.campaigns[0];
			assert.ok(campaign.runtimeProvenance);
			campaign.runtimeProvenance = {
				...campaign.runtimeProvenance,
				nodeVersion: "v0.0.0-provenance-mismatch",
			};
		});

		await assert.rejects(
			fixture.runtime.runToCompletion(),
			(error: unknown) =>
				error instanceof EvaluatorIntegrityError &&
				error.message ===
					"ISO runtime, Node, sandbox, agent harness, evaluator contract, or selection method changed after calibration.",
		);
		const snapshot = await fixture.runtime.snapshot();
		assert.equal(snapshot.state.campaigns[0].status, "failed");
		assert.equal(snapshot.state.campaigns[0].runIntent, "idle");
		assert.equal(snapshot.state.generations.length, 0);
		assert.equal(snapshot.state.experiments.length, 0);
		assert.equal(snapshot.workers.length, 0);
		assert.equal(agents.plannedBases.length, 0);
		assert.equal(agents.workerBases.length, 0);
		assert.ok(snapshot.state.events.some((event) => event.type === "campaign.failed"));
	} finally {
		store.close();
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("deduplicates starts in one runtime and durably records worker cancellation", async () => {
	const agents = new ScriptedAgents({
		scores: [20],
		waitForAbort: true,
		reflectionStops: true,
	});
	const fixture = await createFixture(agents, { workers: 1, maxExperiments: 1 });
	try {
		const first = await fixture.runtime.startResearch();
		const duplicate = await fixture.runtime.startResearch();
		assert.equal(first.started, true);
		assert.equal(duplicate.started, false);
		assert.equal(duplicate.runId, first.runId);

		await waitFor(() => fixture.runtime.workers().length === 1, "worker did not become active");
		const worker = fixture.runtime.workers()[0];
		await fixture.runtime.abort(worker.id);
		await fixture.runtime.runToCompletion();

		const snapshot = await fixture.runtime.snapshot();
		const experiment = snapshot.state.experiments[0];
		assert.equal(experiment.status, "cancelled");
		assert.equal(experiment.failure?.kind, "cancelled");
		assert.ok(snapshot.state.events.some((event) => event.type === "experiment.cancelled"));
		assert.equal(snapshot.state.campaigns[0].status, "completed");
		assert.equal(snapshot.state.campaigns[0].stopReason, "Scripted test stop");
		assert.equal(snapshot.state.campaigns[0].completionReport?.reason, "Scripted test stop");
		assert.ok(snapshot.state.events.some((event) => event.type === "critic.stop-accepted"));
		assert.equal(snapshot.workers.length, 0);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("startup recovery cannot overwrite paused intent, while an explicit start can resume it", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-intent-cas-"));
	const store = new IsoStore(root);
	const runtime = new IsoRuntime(root, store, new ScriptedAgents({ scores: [20] }));
	try {
		await store.initialize(storedCampaignInput(root));
		await store.update((state) => {
			state.campaigns[0].status = "paused";
			state.campaigns[0].runIntent = "paused";
		});

		const recovered = await runtime.resumePersistedResearch();
		assert.deepEqual(recovered, { runId: "none", started: false });
		let campaign = (await store.read()).campaigns[0];
		assert.equal(campaign.status, "paused");
		assert.equal(campaign.runIntent, "paused");

		assert.equal(store.tryAcquireLease("orchestrator", "external-test-owner", 30_000), true);
		const explicit = await runtime.startResearch();
		assert.deepEqual(explicit, { runId: "external", started: false });
		campaign = (await store.read()).campaigns[0];
		assert.equal(campaign.status, "ready");
		assert.equal(campaign.runIntent, "running");
		store.releaseLease("orchestrator", "external-test-owner");
	} finally {
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("an active calibration mission outranks an older terminal campaign in default projections", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-active-mission-selection-"));
	const store = new IsoStore(root);
	const runtime = new IsoRuntime(root, store, new ScriptedAgents({ scores: [20] }));
	try {
		const terminal = await store.initialize(storedCampaignInput(root));
		await store.update((state) => {
			state.campaigns[0].status = "completed";
			state.campaigns[0].runIntent = "idle";
			state.missions.push({
				id: "mission_new_calibration",
				input: {
					goal: "New active mission",
					metric: { name: "new-score", direction: "maximize", minimumImprovement: 1 },
					config: structuredClone(terminal.config),
					sourceCommit: terminal.sourceCommit,
					sourceHeadCommit: terminal.sourceCommit,
					sourceSnapshotRef: `refs/iso/source-snapshots/${terminal.sourceCommit}`,
					sourceHadLocalChanges: false,
					sourceSnapshotPaths: [],
					dependencyDigest: "b".repeat(64),
				},
				desiredState: "running",
				phase: "calibrating",
				diagnostics: [],
				notificationCursor: 0,
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			});
		});

		const snapshot = await runtime.snapshot();
		const summary = await runtime.summary();
		const terminalSummary = await runtime.summary(terminal.id);
		assert.equal(snapshot.activeCampaign, undefined);
		assert.deepEqual(snapshot.graph, { nodes: [], edges: [] });
		assert.equal(summary.mission?.id, "mission_new_calibration");
		assert.equal(summary.campaign, undefined);
		assert.equal(terminalSummary.campaign?.id, terminal.id);
		assert.equal(terminalSummary.mission, undefined);
	} finally {
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("targeted controls replay durably without duplicating notes or state revisions", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-control-replay-"));
	const firstStore = new IsoStore(root);
	const first = new IsoRuntime(root, firstStore, new ScriptedAgents({ scores: [20] }));
	let second: IsoRuntime | undefined;
	try {
		await firstStore.initialize(storedCampaignInput(root));
		const request = controlRequest(await firstStore.read(), "dashboard-note-replay", "dashboard-note-fingerprint", {
			kind: "note",
			message: "Retain this exact causal instruction.",
		});
		const committed = await first.applyControl(request);
		const committedState = await firstStore.read();
		assert.equal(committedState.operatorNotes.length, 1);
		assert.equal(committedState.events.filter((event) => event.type === "operator.note-queued").length, 1);
		assert.equal(committed.revision, committedState.revision);
		await first.shutdown();

		const reopenedStore = new IsoStore(root);
		second = new IsoRuntime(root, reopenedStore, new ScriptedAgents({ scores: [20] }));
		const replayed = await second.applyControl(request);
		assert.deepEqual(replayed, committed);
		const replayedState = await reopenedStore.read();
		assert.equal(replayedState.revision, committedState.revision);
		assert.equal(replayedState.operatorNotes.length, 1);
		assert.equal(replayedState.events.filter((event) => event.type === "operator.note-queued").length, 1);
		await assert.rejects(
			second.applyControl({
				...request,
				actionFingerprint: "different-dashboard-note-fingerprint",
				action: { kind: "note", message: "A conflicting instruction." },
			}),
			(error: unknown) => error instanceof IdempotencyConflictError,
		);
	} finally {
		await second?.shutdown().catch(() => undefined);
		await first.shutdown().catch(() => undefined);
		await rm(root, { recursive: true });
	}
});

test("trusted current controls replay terminal receipts without touching a replacement", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-current-control-"));
	const firstStore = new IsoStore(root);
	const first = new IsoRuntime(root, firstStore, new ScriptedAgents({ scores: [20] }));
	let second: IsoRuntime | undefined;
	try {
		const original = await firstStore.initialize(storedCampaignInput(root));
		const noteRequest = {
			actionId: "note:trusted-replay",
			actionFingerprint: "trusted-note-fingerprint",
			action: { kind: "note", message: "  Preserve this exact guidance.  " } as const,
		};
		const note = await first.applyCurrentControl(noteRequest);
		const replayedNote = await first.applyCurrentControl(noteRequest);
		assert.deepEqual(replayedNote, note);
		let state = await firstStore.read();
		assert.equal(state.operatorNotes.length, 1);
		assert.equal(state.operatorNotes[0].message, "Preserve this exact guidance.");
		assert.equal(state.events.filter((event) => event.type === "operator.note-queued").length, 1);

		const stopRequest = {
			actionId: "stop:trusted-replay",
			actionFingerprint: "trusted-stop-fingerprint",
			action: { kind: "stop", reason: "Stop the original target." } as const,
		};
		const stopped = await first.applyCurrentControl(stopRequest);
		assert.equal(stopped.outcome.kind, "stop");
		await first.shutdown();

		const reopenedStore = new IsoStore(root);
		second = new IsoRuntime(root, reopenedStore, new ScriptedAgents({ scores: [20] }));
		const terminalReplay = await second.applyCurrentControl(stopRequest);
		assert.deepEqual(terminalReplay, stopped);
		const replacement = await reopenedStore.initialize(storedCampaignInput(root));
		assert.notEqual(replacement.id, original.id);
		await reopenedStore.update((draft) => {
			const active = draft.campaigns.find((campaign) => campaign.id === replacement.id);
			assert.ok(active);
			active.status = "paused";
			active.runIntent = "paused";
		});
		const beforeStaleReplay = await reopenedStore.read();
		const staleReplay = await second.applyCurrentControl(stopRequest);
		assert.deepEqual(staleReplay, stopped);
		state = await reopenedStore.read();
		assert.equal(state.revision, beforeStaleReplay.revision);
		assert.equal(state.campaigns.at(-1)?.id, replacement.id);
		assert.equal(state.campaigns.at(-1)?.status, "paused");
		assert.equal(state.campaigns.at(-1)?.runIntent, "paused");
		assert.equal(state.operatorNotes.length, 1);
		assert.equal(state.events.filter((event) => event.type === "operator.note-queued").length, 1);
		await assert.rejects(
			second.applyCurrentControl({
				...noteRequest,
				actionFingerprint: "changed-trusted-note-fingerprint",
				action: { kind: "note", message: "Different guidance." },
			}),
			(error: unknown) => error instanceof IdempotencyConflictError,
		);
	} finally {
		await second?.stop("Current control test cleanup").catch(() => undefined);
		await second?.shutdown().catch(() => undefined);
		await first.shutdown().catch(() => undefined);
		await rm(root, { recursive: true });
	}
});

test("trusted no-target controls retain their historical no-op receipt", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-no-target-control-"));
	const store = new IsoStore(root);
	const runtime = new IsoRuntime(root, store, new ScriptedAgents({ scores: [20] }));
	try {
		assert.equal((await store.read()).admissionEpoch, 0);
		await assert.rejects(
			runtime.applyCurrentControl({
				actionId: "note:no-target",
				actionFingerprint: "note-no-target-fingerprint",
				action: { kind: "note", message: "Do not queue this later." },
			}),
			(error: unknown) => error instanceof ControlConflictError && error.code === "no_control_target",
		);
		const startRequest = {
			actionId: "start:no-target",
			actionFingerprint: "start-no-target-fingerprint",
			action: { kind: "start" } as const,
		};
		const pauseRequest = {
			actionId: "pause:no-target",
			actionFingerprint: "pause-no-target-fingerprint",
			action: { kind: "pause" } as const,
		};
		const stopRequest = {
			actionId: "stop:no-target",
			actionFingerprint: "stop-no-target-fingerprint",
			action: { kind: "stop", reason: "Nothing is active." } as const,
		};
		const start = await runtime.applyCurrentControl(startRequest);
		assert.equal((await store.read()).admissionEpoch, 0);
		const pause = await runtime.applyCurrentControl(pauseRequest);
		assert.equal((await store.read()).admissionEpoch, 1);
		const stop = await runtime.applyCurrentControl(stopRequest);
		assert.equal((await store.read()).admissionEpoch, 2);
		assert.deepEqual(start.outcome, {
			kind: "start",
			missionResumed: false,
			started: false,
			runId: "none",
		});
		assert.deepEqual(pause.outcome, { kind: "pause", paused: true });
		assert.deepEqual(stop.outcome, { kind: "stop", stopped: true });
		assert.equal(start.targetKind, "none");
		assert.equal(pause.targetKind, "none");
		assert.equal(stop.targetKind, "none");

		const campaign = await store.initialize(storedCampaignInput(root));
		await store.update((draft) => {
			const active = draft.campaigns.find((candidate) => candidate.id === campaign.id);
			assert.ok(active);
			active.status = "paused";
			active.runIntent = "paused";
		});
		const beforeReplay = await store.read();
		assert.equal(beforeReplay.admissionEpoch, 2);
		assert.deepEqual(await runtime.applyCurrentControl(startRequest), start);
		assert.deepEqual(await runtime.applyCurrentControl(pauseRequest), pause);
		assert.deepEqual(await runtime.applyCurrentControl(stopRequest), stop);
		const afterReplay = await store.read();
		assert.equal(afterReplay.revision, beforeReplay.revision);
		assert.equal(afterReplay.admissionEpoch, beforeReplay.admissionEpoch);
		assert.equal(afterReplay.campaigns[0].status, "paused");
		assert.equal(afterReplay.campaigns[0].runIntent, "paused");
		assert.equal(afterReplay.operatorNotes.length, 0);
	} finally {
		await runtime.stop("No-target current control test cleanup").catch(() => undefined);
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("targeted start commits intent once and stale controls cannot touch a replacement campaign", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-target-cas-"));
	const store = new IsoStore(root);
	const runtime = new IsoRuntime(root, store, new ScriptedAgents({ scores: [20] }));
	try {
		const original = await store.initialize(storedCampaignInput(root));
		await store.update((state) => {
			state.campaigns[0].status = "paused";
			state.campaigns[0].runIntent = "paused";
		});
		const staleNote = controlRequest(await store.read(), "stale-note-for-original", "stale-note-fingerprint", {
			kind: "note",
			message: "This must never land on a replacement campaign.",
		});
		const start = controlRequest(await store.read(), "targeted-start-original", "targeted-start-fingerprint", {
			kind: "start",
		});
		assert.equal(store.tryAcquireLease("orchestrator", "external-control-owner", 30_000), true);
		const started = await runtime.applyControl(start);
		const afterStart = await store.read();
		assert.equal(afterStart.campaigns[0].status, "ready");
		assert.equal(afterStart.campaigns[0].runIntent, "running");
		assert.equal(started.revision, afterStart.revision);
		const replayedStart = await runtime.applyControl(start);
		assert.deepEqual(replayedStart, started);
		assert.equal((await store.read()).revision, afterStart.revision);
		store.releaseLease("orchestrator", "external-control-owner");

		const stop = controlRequest(await store.read(), "targeted-stop-original", "targeted-stop-fingerprint", {
			kind: "stop",
			reason: "Replace the original campaign.",
		});
		await runtime.applyControl(stop);
		const replacement = await store.initialize(storedCampaignInput(root));
		assert.notEqual(replacement.id, original.id);
		const beforeStaleAction = await store.read();
		await assert.rejects(
			runtime.applyControl(staleNote),
			(error: unknown) =>
				error instanceof ControlConflictError &&
				error.code === "control_target_changed" &&
				error.activeControl?.id === replacement.id,
		);
		const afterStaleAction = await store.read();
		assert.equal(afterStaleAction.revision, beforeStaleAction.revision);
		assert.equal(afterStaleAction.operatorNotes.length, 0);
		assert.equal(afterStaleAction.campaigns.at(-1)?.id, replacement.id);
		assert.equal(afterStaleAction.campaigns.at(-1)?.status, "ready");
	} finally {
		await runtime.stop("Targeted control test cleanup").catch(() => undefined);
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("targeted stop commits terminal mission state before aborting calibration", async () => {
	const fixture = await createMissionFixture();
	const runtime = new IsoRuntime(fixture.root, new IsoStore(fixture.root), new ScriptedAgents({ scores: [11] }));
	try {
		await runtime.launchMission(fixture.input);
		const internals = runtime as unknown as { calibrationController?: AbortController };
		await waitForAsync(async () => {
			const state = (await runtime.snapshot()).state;
			return state.missions[0]?.phase === "calibrating" && internals.calibrationController !== undefined;
		}, "mission did not enter calibration before targeted stop");
		const controller = internals.calibrationController;
		assert.ok(controller);
		let stateAtAbort: ReturnType<IsoStore["read"]> | undefined;
		controller.signal.addEventListener(
			"abort",
			() => {
				const observer = new IsoStore(fixture.root);
				stateAtAbort = observer.read().finally(() => observer.close());
			},
			{ once: true },
		);
		const request = controlRequest(
			(await runtime.snapshot()).state,
			"targeted-stop-during-calibration",
			"targeted-calibration-stop-fingerprint",
			{ kind: "stop", reason: "Stop only after the terminal intent is durable." },
		);
		await runtime.applyControl(request);
		assert.ok(stateAtAbort);
		const observed = await stateAtAbort;
		assert.equal(observed.missions[0].phase, "stopped");
		assert.equal(observed.missions[0].desiredState, "stopped");
		assert.equal((await runtime.snapshot()).state.campaigns.length, 0);
	} finally {
		await runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("stop preempts an in-flight calibration and leaves no half-created campaign", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-calibration-stop-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
	await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".iso/\n");
	await writeFile(join(root, "subject.txt"), "baseline\n");
	await exec("git", ["add", "--", ".gitignore", "subject.txt"], { cwd: root });
	await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	const runtime = new IsoRuntime(root, new IsoStore(root), new ScriptedAgents({ scores: [20] }));
	const calibration = runtime.calibrateCampaign({
		goal: "Never finish this calibration",
		metric: { name: "score", direction: "maximize", minimumImprovement: 0 },
		config: {
			workers: 1,
			agentTimeoutMs: 10_000,
			evaluator: {
				command: "exec node -e 'setInterval(() => {}, 1000)'",
				controlCwd: ".",
				samples: 2,
				warmups: 0,
				timeoutMs: 60_000,
				protectedPaths: [],
			},
			budget: {
				maxGenerations: 1,
				maxExperiments: 1,
				maxWallClockMs: 60_000,
				maxConsecutivePlateaus: 1,
				maxFailures: 1,
			},
		},
	});
	try {
		await delay(30);
		await Promise.race([
			runtime.stop("Stop calibration"),
			delay(3_000).then(() => {
				throw new Error("stop did not preempt calibration");
			}),
		]);
		await assert.rejects(calibration, (error: unknown) => error instanceof Error && error.name === "AbortError");
		assert.equal((await runtime.snapshot()).state.campaigns.length, 0);
	} finally {
		await calibration.catch(() => undefined);
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("calibrates from an immutable snapshot of dirty source without mutating the user's branch", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-dirty-source-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
	await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".iso/\n");
	await writeFile(join(root, "evaluator.mjs"), DETERMINISTIC_EVALUATOR);
	await writeFile(join(root, "score.txt"), "10\n");
	await exec("git", ["add", "--", ".gitignore", "evaluator.mjs", "score.txt"], { cwd: root });
	await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	const sourceHead = await resolveCommit(root);
	await writeFile(join(root, "score.txt"), "11\n");
	await writeFile(join(root, "research-note.txt"), "include this local source input\n");
	const runtime = new IsoRuntime(root, new IsoStore(root), new ScriptedAgents({ scores: [12] }));
	try {
		const campaign = await runtime.calibrateCampaign({
			goal: "Calibrate the actual local source bytes",
			metric: { name: "score", direction: "maximize", minimumImprovement: 1 },
			config: {
				workers: 1,
				agentTimeoutMs: 10_000,
				evaluator: {
					command: "exec node evaluator.mjs",
					controlCwd: ".",
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
		});
		assert.equal(campaign.sourceHeadCommit, sourceHead);
		assert.notEqual(campaign.sourceCommit, sourceHead);
		assert.equal(campaign.sourceHadLocalChanges, true);
		assert.deepEqual(campaign.sourceSnapshotPaths, ["research-note.txt", "score.txt"]);
		assert.equal(campaign.baseline.evaluation.score.mean, 11);
		assert.equal(await resolveCommit(root), sourceHead);
		assert.equal((await exec("git", ["show", `${campaign.sourceCommit}:score.txt`], { cwd: root })).stdout, "11\n");
		assert.match((await exec("git", ["status", "--porcelain=v1"], { cwd: root })).stdout, /score\.txt/);
	} finally {
		await runtime.stop("Dirty source snapshot test cleanup");
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("calibration consumes the accepted source bundle instead of later live worktree bytes", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-accepted-source-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
	await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".iso/\n");
	await writeFile(join(root, "evaluator.mjs"), DETERMINISTIC_EVALUATOR);
	await writeFile(join(root, "score.txt"), "10\n");
	await exec("git", ["add", "--", ".gitignore", "evaluator.mjs", "score.txt"], { cwd: root });
	await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	const dependencyDigest = await prepareDependencySnapshot(root);
	const source = await snapshotCurrentWorktree({ repoRoot: root });
	await writeFile(join(root, "score.txt"), "999\n");
	const runtime = new IsoRuntime(root, new IsoStore(root), new ScriptedAgents({ scores: [11] }));
	try {
		const campaign = await runtime.calibrateCampaign({
			goal: "Use exactly the source bundle accepted before calibration",
			metric: { name: "score", direction: "maximize", minimumImprovement: 1 },
			config: {
				workers: 1,
				agentTimeoutMs: 10_000,
				evaluator: {
					command: "exec node evaluator.mjs",
					controlCwd: ".",
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
			sourceCommit: source.commit,
			sourceHeadCommit: source.baseCommit,
			sourceSnapshotRef: source.ref,
			sourceHadLocalChanges: source.commit !== source.baseCommit,
			sourceSnapshotPaths: source.changedPaths,
			dependencyDigest,
		});
		assert.equal(campaign.sourceCommit, source.commit);
		assert.equal(campaign.dependencyDigest, dependencyDigest);
		assert.equal(campaign.baseline.evaluation.score.mean, 10);
		assert.equal(await readFile(join(root, "score.txt"), "utf8"), "999\n");
	} finally {
		await runtime.stop("Accepted source bundle test cleanup");
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("verification ignores live manifest edits after calibration and uses the frozen control checkout", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [11] }), {
		workers: 1,
		maxExperiments: 1,
		packageJson: '{"name":"frozen-control","private":true}\n',
	});
	try {
		await writeFile(
			join(fixture.root, "package.json"),
			'{"name":"operator-live-edit","private":true,"description":"must not affect frozen evaluation"}\n',
		);
		await fixture.runtime.runToCompletion();
		const snapshot = await fixture.runtime.snapshot();
		const experiment = snapshot.state.experiments[0];
		assert.equal(experiment.status, "measured");
		assert.equal(snapshot.state.campaigns[0].championExperimentId, experiment.id);
		assert.equal(
			await readFile(join(fixture.root, "package.json"), "utf8"),
			'{"name":"operator-live-edit","private":true,"description":"must not affect frozen evaluation"}\n',
		);
		assert.ok(!snapshot.state.events.some((event) => /integrity check failed/iu.test(event.summary)));
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("direct kernel launch binds replay to the wire request while fresh invocations can relaunch", async () => {
	const fixture = await createMissionFixture();
	const runtime = new IsoRuntime(fixture.root, new IsoStore(fixture.root), new ScriptedAgents({ scores: [11] }));
	try {
		const direct = {
			requestId: "direct-cli-launch-one",
			requestFingerprint: "direct-cli-launch-one-fingerprint",
		};
		const accepted = await runtime.launchMissionFromKernel(fixture.input, direct);
		const replayed = await runtime.launchMissionFromKernel(fixture.input, direct);
		assert.deepEqual(replayed, accepted);
		assert.equal(accepted.mission.accepted, true);
		assert.equal(replayed.mission.missionId, accepted.mission.missionId);
		await assert.rejects(
			runtime.launchMissionFromKernel(fixture.input, {
				...direct,
				requestFingerprint: "changed-direct-cli-launch-fingerprint",
			}),
			(error: unknown) => error instanceof IdempotencyConflictError,
		);

		await runtime.stop("Complete the first direct CLI invocation.");
		const fresh = await runtime.launchMissionFromKernel(fixture.input, {
			requestId: "direct-cli-launch-two",
			requestFingerprint: "direct-cli-launch-two-fingerprint",
		});
		assert.equal(fresh.mission.accepted, true);
		assert.notEqual(fresh.mission.missionId, accepted.mission.missionId);
		assert.notEqual(fresh.preflight.preflightId, accepted.preflight.preflightId);
	} finally {
		await runtime.stop("Direct CLI launch test cleanup").catch(() => undefined);
		await runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("a paused mission survives calibration interruption and resumes through automatic research start", async () => {
	const fixture = await createMissionFixture();
	const runtime = new IsoRuntime(
		fixture.root,
		new IsoStore(fixture.root),
		new ScriptedAgents({ scores: [11], reflectionStops: true }),
	);
	try {
		const receipt = await runtime.launchMission(fixture.input);
		assert.equal(receipt.accepted, true);
		await waitForAsync(
			async () => (await runtime.snapshot()).state.missions[0]?.phase === "calibrating",
			"mission did not persist its calibrating phase",
		);
		await runtime.pause();
		let snapshot = await runtime.snapshot();
		assert.equal(snapshot.state.missions[0].desiredState, "paused");
		assert.equal(snapshot.state.missions[0].phase, "paused");
		assert.equal(snapshot.state.campaigns.length, 0);

		const resumed = await runtime.resumeMission();
		assert.equal(resumed?.missionId, receipt.missionId);
		await waitForAsync(async () => {
			const current = await runtime.snapshot();
			return current.state.events.some((event) => event.type === "research.started");
		}, "resumed mission did not calibrate and start research");
		snapshot = await runtime.snapshot();
		assert.equal(snapshot.state.missions[0].campaignId, snapshot.state.campaigns[0].id);
		assert.equal(snapshot.state.campaigns[0].runIntent, "running");
	} finally {
		await runtime.stop("Mission pause/resume test cleanup").catch(() => undefined);
		await runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("kernel shutdown leaves an in-flight mission retryable for the next runtime", async () => {
	const fixture = await createMissionFixture();
	const first = new IsoRuntime(
		fixture.root,
		new IsoStore(fixture.root),
		new ScriptedAgents({ scores: [11], reflectionStops: true }),
	);
	const receipt = await first.launchMission(fixture.input);
	await waitForAsync(
		async () => (await first.snapshot()).state.missions[0]?.phase === "calibrating",
		"mission did not begin calibration before shutdown",
	);
	await first.shutdown();

	const second = new IsoRuntime(
		fixture.root,
		new IsoStore(fixture.root),
		new ScriptedAgents({ scores: [11], reflectionStops: true }),
	);
	try {
		let state = (await second.snapshot()).state;
		assert.equal(state.missions[0].id, receipt.missionId);
		assert.equal(state.missions[0].desiredState, "running");
		assert.equal(state.missions[0].phase, "accepted");
		assert.equal(state.missions[0].diagnostics.at(-1)?.retryable, true);

		await second.resumePersistedMission();
		await waitForAsync(async () => {
			const current = await second.snapshot();
			return current.state.events.some((event) => event.type === "research.started");
		}, "new runtime did not resume calibration and start research");
		state = (await second.snapshot()).state;
		assert.equal(state.missions[0].campaignId, state.campaigns[0].id);
	} finally {
		await second.stop("Mission restart test cleanup").catch(() => undefined);
		await second.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("stopping during mission calibration prevents automatic recovery", async () => {
	const fixture = await createMissionFixture();
	const runtime = new IsoRuntime(fixture.root, new IsoStore(fixture.root), new ScriptedAgents({ scores: [11] }));
	try {
		await runtime.launchMission(fixture.input);
		await waitForAsync(
			async () => (await runtime.snapshot()).state.missions[0]?.phase === "calibrating",
			"mission did not begin calibration before stop",
		);
		await runtime.stop("Stop the mission before baseline");
		const state = (await runtime.snapshot()).state;
		assert.equal(state.campaigns.length, 0);
		assert.equal(state.missions[0].phase, "stopped");
		assert.equal(state.missions[0].desiredState, "stopped");
		assert.equal(await runtime.resumePersistedMission(), undefined);
	} finally {
		await runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("deduplicates planner fingerprints within one generation", async () => {
	const agents = new ScriptedAgents({ scores: [11, 12], duplicatePlans: true });
	const fixture = await createFixture(agents, { workers: 2, maxExperiments: 2 });
	try {
		await fixture.runtime.runToCompletion();
		const state = (await fixture.runtime.snapshot()).state;
		assert.equal(state.generations.length, 1);
		assert.equal(state.ideas.length, 1);
		assert.equal(state.experiments.length, 1);
		assert.equal(new Set(state.ideas.map((idea) => idea.fingerprint)).size, 1);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("atomically queues and executes a retry after an ordinary worker failure", async () => {
	const agents = new FailOnceWorkerAgents({ scores: [11] });
	const fixture = await createFixture(agents, { workers: 1, maxExperiments: 2 });
	try {
		await fixture.runtime.store.update((state) => {
			state.campaigns[0].config.budget.maxGenerations = 2;
			state.campaigns[0].config.budget.maxConsecutivePlateaus = 2;
		});
		await fixture.runtime.runToCompletion();
		const state = (await fixture.runtime.snapshot()).state;
		const [failed, retried] = state.experiments;
		assert.equal(agents.workerCalls, 2);
		assert.equal(failed.status, "failed");
		assert.equal(failed.attempt, 1);
		assert.equal(failed.failure?.phase, "agent");
		assert.equal(failed.failure?.retryable, true);
		assert.equal(retried.status, "measured");
		assert.equal(retried.attempt, 2);
		assert.equal(retried.retryOfExperimentId, failed.id);
		assert.equal(state.retryQueue.length, 1);
		assert.equal(state.retryQueue[0].sourceExperimentId, failed.id);
		assert.equal(state.retryQueue[0].attempt, 2);
		assert.equal(state.retryQueue[0].status, "exhausted");
		assert.equal(state.ideas[0].fingerprint, state.ideas[1].fingerprint);
		assert.equal(state.campaigns[0].championExperimentId, retried.id);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("requeues a claimed retry when pause cancels its generation before durable dispatch", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [11] }), {
		workers: 1,
		maxExperiments: 3,
	});
	const timestamp = new Date().toISOString();
	const proposal = {
		title: "Candidate 0",
		hypothesis: "Writing 11 raises the measured score",
		rationale: "The evaluator directly measures the score fixture",
		implementationPlan: "Write 11 to score.txt",
		predictedEffect: "Move score to 11",
		strategy: "verify" as const,
	};
	const sourceIdeaId = "idea_retry_pause_source";
	const sourceExperimentId = "experiment_retry_pause_source";
	await fixture.runtime.store.update((state) => {
		const campaign = state.campaigns[0];
		campaign.experimentsStarted = 1;
		state.ideas.push({
			id: sourceIdeaId,
			campaignId: campaign.id,
			generationId: "generation_retry_pause_source",
			...proposal,
			status: "failed",
			source: "planner",
			parentIdeaIds: [],
			fingerprint: fingerprintIdea(proposal),
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		state.experiments.push({
			id: sourceExperimentId,
			campaignId: campaign.id,
			generationId: "generation_retry_pause_source",
			ideaId: sourceIdeaId,
			attempt: 1,
			status: "failed",
			baseCommit: campaign.sourceCommit,
			branch: "iso/retry-pause-source",
			worktree: join(fixture.root, ".iso", "worktrees", sourceExperimentId),
			changedPaths: [],
			failure: {
				phase: "agent",
				kind: "agent",
				message: "Seed retry source",
				retryable: true,
			},
			finishedAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp,
		});
		queueRetry(state, {
			campaignId: campaign.id,
			sourceExperimentId,
			sourceIdeaId,
			proposal,
			attempt: 2,
		});
	});

	const internals = fixture.runtime as unknown as {
		persistPlan: (
			campaign: Campaign,
			generation: Generation,
			proposals: unknown[],
			consumedNoteIds: string[],
		) => Promise<Experiment[]>;
		loopPromise?: Promise<void>;
	};
	const originalPersistPlan = internals.persistPlan.bind(fixture.runtime);
	let pauseAfterClaim = true;
	internals.persistPlan = async (...arguments_) => {
		const experiments = await originalPersistPlan(...arguments_);
		if (pauseAfterClaim) {
			pauseAfterClaim = false;
			await fixture.runtime.pause();
		}
		return experiments;
	};
	try {
		const started = await fixture.runtime.startResearch();
		assert.equal(started.started, true);
		await waitForAsync(
			async () => (await fixture.runtime.snapshot()).state.campaigns[0].status === "paused",
			"campaign did not pause after claiming the retry",
		);
		await waitFor(() => internals.loopPromise === undefined, "paused research loop did not quiesce");

		let state = (await fixture.runtime.snapshot()).state;
		const cancelled = state.experiments.find((experiment) => experiment.retryOfExperimentId === sourceExperimentId);
		assert.equal(cancelled?.status, "cancelled");
		assert.equal(cancelled?.attempt, 2);
		assert.equal(cancelled?.startedAt, undefined);
		assert.equal(state.retryQueue[0].status, "queued");
		assert.equal(state.retryQueue[0].claimedAt, undefined);
		assert.equal(state.retryQueue[0].claimedGenerationId, undefined);

		internals.persistPlan = originalPersistPlan;
		await fixture.runtime.runToCompletion();
		state = (await fixture.runtime.snapshot()).state;
		const attempts = state.experiments.filter((experiment) => experiment.retryOfExperimentId === sourceExperimentId);
		assert.equal(attempts.length, 2);
		assert.deepEqual(
			attempts.map((experiment) => [experiment.attempt, experiment.status]),
			[
				[2, "cancelled"],
				[2, "measured"],
			],
		);
		assert.equal(state.retryQueue[0].status, "exhausted");
		assert.ok(state.ideas.every((idea) => idea.fingerprint === fingerprintIdea(proposal)));
	} finally {
		internals.persistPlan = originalPersistPlan;
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("summary and evidence projections stay bounded when durable state contains large raw evidence", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-bounded-query-"));
	const store = new IsoStore(root);
	const runtime = new IsoRuntime(root, store, new ScriptedAgents({ scores: [11] }));
	try {
		const campaign = await store.initialize(storedCampaignInput(root));
		const timestamp = new Date().toISOString();
		const confirmationCandidate = mockEvaluation(11, true, "bounded-candidate");
		const confirmationIncumbent = mockEvaluation(10, true, "bounded-incumbent");
		const keys = Object.fromEntries(
			Array.from({ length: 200 }, (_, index) => [`metric-${index}-${"x".repeat(200)}`, index]),
		);
		await store.update((state) => {
			state.campaigns[0].baseline.evaluation.samples = Array.from({ length: 20 }, (_, sampleIndex) => ({
				score: 10,
				metrics: keys,
				valid: true,
				constraints: Object.fromEntries(Object.keys(keys).map((key) => [key, true])),
				durationMs: 1,
				stdout: "x".repeat(4_096),
				stderr: "x".repeat(4_096),
				sampleIndex,
			}));
			state.experiments.push({
				id: "experiment_large_evidence",
				campaignId: campaign.id,
				generationId: "generation_large_evidence",
				ideaId: "idea_large_evidence",
				attempt: 1,
				status: "failed",
				baseCommit: campaign.sourceCommit,
				branch: "iso/large-evidence",
				worktree: join(root, ".iso", "worktrees", "large-evidence"),
				changedPaths: Array.from({ length: 250 }, (_, index) => `${index}-${"p".repeat(4_000)}`),
				assistantSummary: "s".repeat(100_000),
				failure: {
					phase: "agent",
					kind: "agent",
					message: "f".repeat(100_000),
					retryable: false,
				},
				confirmationRoundsPassed: 25,
				confirmationHistory: Array.from({ length: 25 }, (_, index) => ({
					round: index + 1,
					trialId: `bounded-round-${index + 1}`,
					candidateMean: 11,
					incumbentMean: 10,
					improvement: 1,
					uncertainty: 0,
					lowerBound: 1,
					confirmed: true,
					measuredAt: timestamp,
					candidateEvaluation: structuredClone(confirmationCandidate),
					incumbentEvaluation: structuredClone(confirmationIncumbent),
					interval: {
						method: "paired-student-t",
						df: 2,
						alpha: 0.05,
						criticalValue: critical95(2),
						uncertainty: 0,
						lowerBound: 1,
					},
					sampleIdentities: {
						candidate: confirmationCandidate.samples.map(sampleIdentityForTest),
						incumbent: confirmationIncumbent.samples.map(sampleIdentityForTest),
					},
				})),
				createdAt: timestamp,
				updatedAt: timestamp,
			});
		});

		const summary = await runtime.summary(campaign.id);
		const evidence = await runtime.queryEvidence({
			kind: "experiments",
			campaignId: campaign.id,
			limit: 1,
		});
		assert.ok(Buffer.byteLength(JSON.stringify(summary)) < 1024 * 1024);
		assert.ok(Buffer.byteLength(JSON.stringify(evidence)) < 1024 * 1024);
		const experiment = evidence.items[0] as { changedPaths: string[]; assistantSummary?: string };
		assert.equal(experiment.changedPaths.length, 20);
		assert.ok(experiment.changedPaths.every((path) => path.length <= 512));
		assert.equal(experiment.assistantSummary?.length, 4_000);
		const confirmation = evidence.items[0] as ExperimentEvidence;
		assert.equal(confirmation.confirmationHistory?.length, 10);
		assert.deepEqual(
			confirmation.confirmationHistory?.map((round) => round.round),
			[16, 17, 18, 19, 20, 21, 22, 23, 24, 25],
		);
	} finally {
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("consumes a queued operator hypothesis as the next generation's human-authored experiment", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [11] }), {
		workers: 1,
		maxExperiments: 1,
	});
	try {
		const note = await fixture.runtime.queueOperatorNote("Test this exact mechanism next.", {
			title: "Candidate 0",
			hypothesis: "An operator-selected score change should improve the metric",
			rationale: "The human explicitly prioritized this causal mechanism",
			implementationPlan: "Write 11 to score.txt",
			predictedEffect: "Increase score to 11",
			strategy: "verify",
		});
		await fixture.runtime.runToCompletion();
		const state = (await fixture.runtime.snapshot()).state;
		assert.equal(state.ideas[0].source, "human");
		assert.equal(state.operatorNotes.find((candidate) => candidate.id === note.id)?.status, "consumed");
		assert.equal(
			state.operatorNotes.find((candidate) => candidate.id === note.id)?.consumedGenerationId,
			state.generations[0].id,
		);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("pauses at the planning boundary without dispatching persisted experiment intents", async () => {
	const agents = new ScriptedAgents({
		scores: [20],
		waitInPlanner: true,
	});
	const fixture = await createFixture(agents, { workers: 1, maxExperiments: 1 });
	try {
		const receipt = await fixture.runtime.startResearch();
		assert.equal(receipt.started, true);
		await waitFor(() => agents.plannerEntered, "planner did not reach the durable pause boundary");
		await fixture.runtime.pause();
		agents.releasePlanner();
		await waitForAsync(
			async () => (await fixture.runtime.snapshot()).state.campaigns[0].status === "paused",
			"campaign did not reach the paused state",
		);

		const snapshot = await fixture.runtime.snapshot();
		assert.equal(snapshot.state.campaigns[0].status, "paused");
		assert.equal(snapshot.state.campaigns[0].activeGenerationId, undefined);
		assert.equal(snapshot.state.generations[0].status, "cancelled");
		assert.equal(snapshot.state.experiments[0].status, "cancelled");
		assert.equal(snapshot.state.experiments[0].startedAt, undefined);
		assert.equal(agents.workerBases.length, 0);
		assert.equal(snapshot.workers.length, 0);
		assert.ok(snapshot.state.events.some((event) => event.type === "campaign.pause-requested"));
		assert.ok(snapshot.state.events.some((event) => event.type === "generation.cancelled"));
	} finally {
		agents.releasePlanner();
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("stops atomically during planning and waits for planner quiescence without deadlocking", async () => {
	const agents = new ScriptedAgents({
		scores: [20],
		waitInPlanner: true,
	});
	const fixture = await createFixture(agents, { workers: 1, maxExperiments: 1 });
	let stopTimeout: ReturnType<typeof setTimeout> | undefined;
	try {
		const receipt = await fixture.runtime.startResearch();
		assert.equal(receipt.started, true);
		await waitFor(() => agents.plannerEntered, "planner did not enter before stop");
		let stopSettled = false;
		const stopping = fixture.runtime.stop("Operator stop during planning").then(() => {
			stopSettled = true;
		});
		await delay(30);
		assert.equal(stopSettled, false, "stop resolved before the in-flight planner became quiescent");
		agents.releasePlanner();
		await Promise.race([
			stopping,
			new Promise<never>((_resolve, reject) => {
				stopTimeout = setTimeout(() => {
					reject(new Error("stop deadlocked after the planner became quiescent"));
				}, 2_000);
			}),
		]);

		const snapshot = await fixture.runtime.snapshot();
		assert.equal(snapshot.state.campaigns[0].status, "stopped");
		assert.equal(snapshot.state.generations[0].status, "cancelled");
		assert.equal(snapshot.state.experiments[0].status, "cancelled");
		assert.equal(snapshot.state.experiments[0].startedAt, undefined);
		assert.equal(agents.workerBases.length, 0);
		assert.equal(snapshot.workers.length, 0);
	} finally {
		if (stopTimeout) {
			clearTimeout(stopTimeout);
		}
		agents.releasePlanner();
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("allows only one runtime instance to own the orchestration lease", async () => {
	const primaryAgents = new ScriptedAgents({
		scores: [20],
		waitForAbort: true,
		reflectionStops: true,
	});
	const fixture = await createFixture(primaryAgents, { workers: 1, maxExperiments: 1 });
	const secondary = new IsoRuntime(
		fixture.root,
		new IsoStore(fixture.root),
		new ScriptedAgents({ scores: [30], reflectionStops: true }),
	);
	try {
		const primary = await fixture.runtime.startResearch();
		const duplicate = await secondary.startResearch();
		assert.equal(primary.started, true);
		assert.equal(duplicate.started, false);
		assert.equal(duplicate.runId, "external");

		await waitFor(() => fixture.runtime.workers().length === 1, "primary worker did not become active");
		await fixture.runtime.abort(fixture.runtime.workers()[0].id);
		await fixture.runtime.runToCompletion();

		const state = (await fixture.runtime.snapshot()).state;
		assert.notEqual(state.campaigns[0].status, "failed");
		assert.equal(state.events.filter((event) => event.type === "research.started").length, 1);
	} finally {
		await secondary.shutdown();
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("classifies attempts to modify protected evaluator inputs as policy-invalid", async () => {
	const agents = new ScriptedAgents({
		scores: [9999],
		modifyEvaluator: true,
		reflectionStops: true,
	});
	const fixture = await createFixture(agents, { workers: 1, maxExperiments: 1 });
	try {
		await fixture.runtime.runToCompletion();
		const experiment = (await fixture.runtime.snapshot()).state.experiments[0];
		assert.equal(experiment.status, "invalid");
		assert.equal(experiment.failure?.kind, "policy");
		assert.equal(experiment.failure?.phase, "policy");
		assert.match(experiment.failure?.message ?? "", /protected evaluator inputs/);
		assert.equal(experiment.candidateCommit, undefined);
	} finally {
		await fixture.runtime.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("restart during confirmation reuses the same experiment, candidate commit, and opaque plans", async () => {
	const fixture = await createFixture(new ScriptedAgents({ scores: [20] }), {
		workers: 1,
		maxExperiments: 1,
	});
	const firstInternals = fixture.runtime as unknown as {
		evaluateFrozenPair: (
			campaign: Campaign,
			incumbentCommit: string,
			candidateCommit: string,
			plan: PairedEvaluationPlan,
			signal?: AbortSignal,
		) => Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }>;
	};
	const evaluateNormally = firstInternals.evaluateFrozenPair.bind(fixture.runtime);
	firstInternals.evaluateFrozenPair = async (campaign, incumbentCommit, candidateCommit, plan, signal) => {
		if (plan.kind === "screen") {
			return evaluateNormally(campaign, incumbentCommit, candidateCommit, plan, signal);
		}
		await new Promise<void>((_resolve, reject) => {
			if (signal?.aborted) {
				reject(abortError("Simulated kernel exit during confirmation."));
				return;
			}
			signal?.addEventListener("abort", () => reject(abortError("Simulated kernel exit during confirmation.")), {
				once: true,
			});
		});
		throw new Error("unreachable");
	};
	const started = await fixture.runtime.startResearch();
	assert.equal(started.started, true);
	await waitForAsync(async () => {
		const experiment = (await fixture.runtime.snapshot()).state.experiments[0];
		return experiment?.confirmationPlan !== undefined;
	}, "confirmation plan was not frozen before simulated restart");
	await fixture.runtime.shutdown();

	const observer = new IsoStore(fixture.root);
	const interrupted = await observer.read();
	observer.close();
	const originalExperiment = interrupted.experiments[0];
	assert.ok(originalExperiment.candidateCommit);
	assert.ok(originalExperiment.screeningPlan);
	assert.ok(originalExperiment.confirmationPlan);
	assert.equal(interrupted.retryQueue.length, 0);

	const resumedAgents = new ScriptedAgents({ scores: [999] });
	const resumed = new IsoRuntime(fixture.root, new IsoStore(fixture.root), resumedAgents);
	const resumedPlanKinds: PairedEvaluationPlan["kind"][] = [];
	const resumedInternals = resumed as unknown as {
		evaluateFrozenPair: (
			campaign: Campaign,
			incumbentCommit: string,
			candidateCommit: string,
			plan: PairedEvaluationPlan,
			signal?: AbortSignal,
		) => Promise<{ incumbent: EvaluationAggregate; candidate: EvaluationAggregate }>;
	};
	const resumedEvaluation = resumedInternals.evaluateFrozenPair.bind(resumed);
	resumedInternals.evaluateFrozenPair = async (...arguments_) => {
		resumedPlanKinds.push(arguments_[3].kind);
		return resumedEvaluation(...arguments_);
	};
	try {
		await resumed.reconcileAfterRestart();
		await resumed.runToCompletion();
		const state = (await resumed.snapshot()).state;
		assert.equal(state.experiments.length, 1);
		assert.equal(state.experiments[0].id, originalExperiment.id);
		assert.equal(state.experiments[0].candidateCommit, originalExperiment.candidateCommit);
		assert.deepEqual(state.experiments[0].screeningPlan, originalExperiment.screeningPlan);
		assert.deepEqual(state.experiments[0].confirmationPlan, originalExperiment.confirmationPlan);
		assert.deepEqual(resumedPlanKinds, ["confirmation"]);
		assert.equal(resumedAgents.workerBases.length, 0);
		assert.equal(state.retryQueue.length, 0);
		assert.equal(state.campaigns[0].championExperimentId, originalExperiment.id);
	} finally {
		await resumed.shutdown();
		await rm(fixture.root, { recursive: true });
	}
});

test("restart reconciles a confirmed-evidence promotion failpoint exactly once", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-confirmation-promotion-reconcile-"));
	const store = new IsoStore(root);
	const runtime = new IsoRuntime(root, store, new ScriptedAgents({ scores: [20] }));
	try {
		const campaign = await store.initialize(storedCampaignInput(root));
		const timestamp = new Date().toISOString();
		const candidateEvaluation = mockEvaluation(20, true, "confirmed-gap");
		const incumbentEvaluation = mockEvaluation(10, true, "confirmed-gap");
		await store.update((state) => {
			state.campaigns[0].status = "running";
			state.campaigns[0].runIntent = "running";
			state.campaigns[0].activeGenerationId = "generation_confirmed_gap";
			state.generations.push({
				id: "generation_confirmed_gap",
				campaignId: campaign.id,
				index: 1,
				status: "verifying",
				baseCommit: campaign.sourceCommit,
				ideaIds: ["idea_confirmed_gap"],
				experimentIds: ["experiment_confirmed_gap"],
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			state.ideas.push({
				id: "idea_confirmed_gap",
				campaignId: campaign.id,
				generationId: "generation_confirmed_gap",
				title: "Confirmed gap",
				hypothesis: "The persisted confirmation should promote exactly once",
				rationale: "Exercise deterministic reconciliation",
				implementationPlan: "Reuse frozen evidence",
				predictedEffect: "Promote candidate",
				strategy: "verify",
				status: "measured",
				source: "planner",
				parentIdeaIds: [],
				fingerprint: "confirmed-gap",
				createdAt: timestamp,
				updatedAt: timestamp,
			});
			state.experiments.push({
				id: "experiment_confirmed_gap",
				campaignId: campaign.id,
				generationId: "generation_confirmed_gap",
				ideaId: "idea_confirmed_gap",
				attempt: 1,
				status: "measured",
				baseCommit: campaign.sourceCommit,
				branch: "iso/confirmed-gap",
				worktree: join(root, ".iso", "worktrees", "confirmed-gap"),
				candidateCommit: campaign.sourceCommit,
				changedPaths: ["score.txt"],
				evaluation: candidateEvaluation,
				incumbentEvaluation,
				improvement: 10,
				uncertainty: 0,
				screeningPassed: true,
				credibleImprovement: false,
				confirmationHistory: [
					{
						round: 1,
						planId: "pair_confirmed_gap",
						candidateMean: 20,
						incumbentMean: 10,
						improvement: 10,
						uncertainty: 0,
						lowerBound: 10,
						confirmed: true,
						measuredAt: timestamp,
						candidateEvaluation,
						incumbentEvaluation,
					},
				],
				createdAt: timestamp,
				updatedAt: timestamp,
			});
		});

		await runtime.reconcileAfterRestart();
		await runtime.reconcileAfterRestart();
		const state = await store.read();
		assert.equal(state.campaigns[0].championExperimentId, "experiment_confirmed_gap");
		assert.equal(state.generations[0].selectedExperimentId, "experiment_confirmed_gap");
		assert.equal(state.generations[0].status, "reflecting");
		assert.equal(state.experiments[0].credibleImprovement, true);
		assert.equal(
			state.events.filter(
				(event) => event.type === "champion.promoted" && event.experimentId === "experiment_confirmed_gap",
			).length,
			1,
		);
		assert.equal(
			state.materialUpdates.filter(
				(update) => update.kind === "champion" && update.refs.includes("experiment_confirmed_gap"),
			).length,
			1,
		);
	} finally {
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});

test("reconciles an evaluator interrupted by restart with its original phase", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-runtime-recovery-"));
	const store = new IsoStore(root);
	const agents = new ScriptedAgents({ scores: [20] });
	const runtime = new IsoRuntime(root, store, agents);
	try {
		const campaign = await store.initialize(storedCampaignInput(root));
		const timestamp = new Date().toISOString();
		const generation: Generation = {
			id: "generation_recovery",
			campaignId: campaign.id,
			index: 1,
			status: "verifying",
			baseCommit: campaign.sourceCommit,
			ideaIds: ["idea_recovery"],
			experimentIds: ["experiment_recovery"],
			startedAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const idea: Idea = {
			id: "idea_recovery",
			campaignId: campaign.id,
			generationId: generation.id,
			title: "Interrupted evaluator",
			hypothesis: "The candidate improves the score",
			rationale: "A measurement was in flight",
			implementationPlan: "Measure the candidate",
			predictedEffect: "Increase score",
			strategy: "verify",
			status: "running",
			source: "planner",
			parentIdeaIds: [],
			fingerprint: "interrupted evaluator measure candidate",
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		const experiment: Experiment = {
			id: "experiment_recovery",
			campaignId: campaign.id,
			generationId: generation.id,
			ideaId: idea.id,
			attempt: 1,
			status: "evaluating",
			baseCommit: campaign.sourceCommit,
			branch: "iso/recovery",
			worktree: join(root, ".iso", "worktrees", "experiment_recovery"),
			changedPaths: ["score.txt"],
			startedAt: timestamp,
			createdAt: timestamp,
			updatedAt: timestamp,
		};
		await store.update((state) => {
			state.campaigns[0].status = "running";
			state.campaigns[0].runIntent = "running";
			state.campaigns[0].activeGenerationId = generation.id;
			state.generations.push(generation);
			state.ideas.push(idea);
			state.experiments.push(experiment);
			state.agentCallAttempts.push({
				id: "agent-call-recovery",
				campaignId: campaign.id,
				generationId: generation.id,
				experimentId: experiment.id,
				ideaId: idea.id,
				role: "worker",
				attempt: 1,
				status: "running",
				missingTokenAccounting: true,
				missingCostAccounting: true,
				startedAt: timestamp,
			});
		});

		assert.equal(await runtime.reconcileAfterRestart(), 1);
		const state = await store.read();
		assert.equal(state.agentCallAttempts[0].status, "interrupted");
		assert.equal(state.agentCallAttempts[0].missingTokenAccounting, true);
		assert.equal(state.agentCallAttempts[0].missingCostAccounting, true);
		assert.match(state.agentCallAttempts[0].error ?? "", /durable terminal state/);
		assert.ok(state.agentCallAttempts[0].finishedAt);
		assert.equal(state.experiments[0].status, "interrupted");
		assert.equal(state.experiments[0].failure?.kind, "infrastructure");
		assert.equal(state.experiments[0].failure?.phase, "evaluator");
		assert.equal(state.experiments[0].failure?.retryable, true);
		assert.equal(state.generations[0].status, "failed");
		assert.equal(state.campaigns[0].status, "ready");
		assert.equal(state.campaigns[0].runIntent, "running");
		assert.equal(state.campaigns[0].activeGenerationId, undefined);
		assert.equal(state.retryQueue.length, 1);
		assert.equal(state.retryQueue[0].sourceExperimentId, experiment.id);
		assert.equal(state.retryQueue[0].attempt, 2);
		assert.equal(state.retryQueue[0].status, "queued");
		assert.ok(state.events.some((event) => event.type === "kernel.reconciled"));
	} finally {
		await runtime.shutdown();
		await rm(root, { recursive: true });
	}
});
