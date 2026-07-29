import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import type { EvaluatorSample } from "../src/evaluator.ts";
import {
	aggregateEvaluationSamples,
	EvaluatorAbortError,
	EvaluatorContractError,
	EvaluatorTimeoutError,
	parseEvaluatorOutput,
	runEvaluator,
} from "../src/evaluator.ts";

function sample(score: number, metrics: Record<string, number> = {}): EvaluatorSample {
	return {
		score,
		metrics,
		valid: true,
		constraints: {},
		trialId: "test",
		phase: "sample",
		sampleIndex: 0,
		seed: 0,
		durationMs: 1,
		stdout: "",
		stderr: "",
		stdoutBytes: 0,
		stderrBytes: 0,
		stdoutTruncated: false,
		stderrTruncated: false,
	};
}

function shellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function nodeCommand(source: string): string {
	return `exec ${shellArgument(process.execPath)} -e ${shellArgument(source)}`;
}

function sandboxSkipReason(): string | false {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		return `OS sandbox is unsupported on ${process.platform}`;
	}
	if (!SandboxManager.checkDependencies()) {
		return process.platform === "linux"
			? "OS sandbox dependencies are missing (requires rg, bwrap, socat, and seccomp support)"
			: "OS sandbox dependency is missing (requires rg)";
	}
	if (process.platform === "darwin" && !existsSync("/usr/bin/sandbox-exec")) {
		return "OS sandbox dependency is missing (/usr/bin/sandbox-exec)";
	}
	return false;
}

async function createEvaluatorFixture(): Promise<{
	candidate: string;
	control: string;
	liveRepo: string;
	root: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "iso-evaluator-test-"));
	const liveRepo = join(root, "live");
	const control = join(root, "control");
	const candidate = join(root, "candidate");
	await Promise.all([mkdir(liveRepo), mkdir(control), mkdir(candidate)]);
	return { candidate, control, liveRepo, root };
}

test("aggregates measured scores and secondary metrics", () => {
	const aggregate = aggregateEvaluationSamples([
		sample(1, { cost: 8, partial: 10 }),
		sample(2, { cost: 3, partial: 15 }),
		sample(7, { cost: 5, partial: 20 }),
	]);

	assert.equal(aggregate.score.mean, 10 / 3);
	assert.equal(aggregate.score.median, 2);
	assert.ok(Math.abs(aggregate.score.stddev - Math.sqrt(31 / 3)) < Number.EPSILON * 4);
	assert.equal(aggregate.score.min, 1);
	assert.equal(aggregate.score.max, 7);
	assert.deepEqual(aggregate.metrics, { cost: 5, partial: 15 });
});

test("requires every measured sample and constraint to be valid", async () => {
	const fixture = await createEvaluatorFixture();
	try {
		const evaluation = await runEvaluator(
			nodeCommand(
				'console.log("ISO_RESULT " + JSON.stringify({score: 4, valid: true, constraints: {correct: true, budget: false}}))',
			),
			{
				repoRoot: fixture.liveRepo,
				controlCwd: fixture.control,
				experimentDir: fixture.candidate,
				warmups: 0,
				samples: 2,
			},
		);

		assert.equal(evaluation.score, 4);
		assert.equal(evaluation.valid, false);
		assert.deepEqual(evaluation.constraints, { correct: true, budget: false });
		assert.equal(evaluation.samples.length, 2);
	} finally {
		await rm(fixture.root, { recursive: true });
	}
});

test("preserves absolute sample identity across fresh evaluator sandboxes", async () => {
	const fixture = await createEvaluatorFixture();
	try {
		const evaluation = await runEvaluator(
			nodeCommand('console.log("ISO_RESULT " + JSON.stringify({score: Number(process.env.ISO_SAMPLE_INDEX)}))'),
			{
				repoRoot: fixture.liveRepo,
				controlCwd: fixture.control,
				experimentDir: fixture.candidate,
				warmups: 1,
				samples: 1,
				sampleIndexOffset: 7,
				trialId: "absolute-index",
			},
		);

		assert.equal(evaluation.warmups[0]?.sampleIndex, 7);
		assert.equal(evaluation.samples[0]?.sampleIndex, 7);
		assert.equal(evaluation.score, 7);
		assert.notEqual(evaluation.warmups[0]?.seed, evaluation.samples[0]?.seed);
	} finally {
		await rm(fixture.root, { recursive: true });
	}
});

test("rejects malformed evaluator output", () => {
	assert.throws(
		() => parseEvaluatorOutput('ISO_RESULT {"score": 1, "metrics": {"latency": "fast"}}'),
		(error: unknown) =>
			error instanceof EvaluatorContractError && error.message === "metrics.latency must be a finite number.",
	);
	assert.throws(
		() => parseEvaluatorOutput('{"score": 1}'),
		(error: unknown) =>
			error instanceof EvaluatorContractError && error.message.includes("produced no ISO_RESULT line"),
	);
});

test("rejects ambiguous output with multiple ISO_RESULT lines", () => {
	assert.throws(
		() =>
			parseEvaluatorOutput(["diagnostic output", 'ISO_RESULT {"score": 1}', 'ISO_RESULT {"score": 999}'].join("\n")),
		(error: unknown) =>
			error instanceof EvaluatorContractError &&
			error.message === "Evaluator produced 2 ISO_RESULT lines; exactly one trusted result is required.",
	);
});

test("runs from the control directory and exposes the candidate directory", async (context) => {
	const fixture = await createEvaluatorFixture();
	context.after(async () => {
		await rm(fixture.root, { recursive: true });
	});

	const evaluation = await runEvaluator(
		nodeCommand(
			`console.log("ISO_RESULT " + JSON.stringify({score: process.env.ISO_EXPERIMENT_DIR === ${JSON.stringify(fixture.candidate)} ? 1 : 0, summary: process.cwd()}))`,
		),
		{
			repoRoot: fixture.liveRepo,
			controlCwd: fixture.control,
			experimentDir: fixture.candidate,
			warmups: 0,
			samples: 1,
		},
	);

	assert.equal(evaluation.score, 1);
	assert.equal(evaluation.summary, await realpath(fixture.control));
});

test(
	"evaluator reads only the source-pinned checkout, candidate and exact frozen artifacts",
	{ skip: sandboxSkipReason(), timeout: 20_000 },
	async () => {
		const fixture = await createEvaluatorFixture();
		const controlCwd = join(fixture.control, "harness");
		const dependencyDigest = "a".repeat(64);
		const otherDependencyDigest = "b".repeat(64);
		const dependencyStore = join(fixture.liveRepo, ".iso", "dependencies");
		const dependencyRoot = join(dependencyStore, dependencyDigest, "node_modules");
		const otherDependencySecret = join(dependencyStore, otherDependencyDigest, "node_modules", "secret.txt");
		const frozenRoot = join(fixture.liveRepo, ".iso", "evaluators", "frozen");
		const liveSentinel = join(fixture.liveRepo, "mutable-sentinel.txt");
		const liveEnvironment = join(fixture.liveRepo, ".env");
		const futureLiveSentinel = join(fixture.liveRepo, "created-after-policy.txt");
		const ready = join(fixture.candidate, "evaluator-ready");
		const proceed = join(fixture.candidate, "host-proceed");
		try {
			await Promise.all([
				mkdir(join(fixture.liveRepo, ".git"), { recursive: true }),
				mkdir(join(dependencyRoot, "fixture"), { recursive: true }),
				mkdir(join(dependencyStore, otherDependencyDigest, "node_modules"), { recursive: true }),
				mkdir(frozenRoot, { recursive: true }),
				mkdir(join(fixture.control, "node_modules")),
				mkdir(controlCwd),
			]);
			await Promise.all([
				writeFile(join(fixture.liveRepo, ".git", "config"), "live git secret\n"),
				writeFile(liveSentinel, "mutable live secret\n"),
				writeFile(liveEnvironment, "LIVE_SECRET=mutable\n"),
				writeFile(join(dependencyRoot, "fixture", "value.txt"), "frozen dependency\n"),
				writeFile(otherDependencySecret, "other dependency secret\n"),
				writeFile(join(dependencyStore, "active"), `${dependencyDigest}\n`),
				writeFile(join(fixture.control, ".git"), "gitdir: hidden-control-git\n"),
				writeFile(join(fixture.control, "control-source.txt"), "source-pinned control\n"),
				writeFile(join(fixture.candidate, ".git"), "gitdir: hidden-candidate-git\n"),
				writeFile(join(fixture.candidate, "candidate-source.txt"), "candidate input\n"),
			]);
			await Promise.all([
				symlink(dependencyRoot, join(fixture.control, "node_modules", ".iso-readonly-view"), "dir"),
				symlink(join(dependencyRoot, "fixture"), join(fixture.control, "node_modules", "fixture"), "dir"),
			]);

			const source = [
				'import { existsSync, readFileSync, writeFileSync } from "node:fs";',
				'import { setTimeout as delay } from "node:timers/promises";',
				'import { fileURLToPath } from "node:url";',
				"const candidate = process.env.ISO_EXPERIMENT_DIR;",
				'if (!candidate) throw new Error("missing candidate");',
				`writeFileSync(${JSON.stringify(ready)}, "ready");`,
				`while (!existsSync(${JSON.stringify(proceed)})) await delay(5);`,
				"const denied = (path) => {",
				"\ttry { readFileSync(path); return false; } catch { return true; }",
				"};",
				"const constraints = {",
				'\tcontrolSource: readFileSync("../control-source.txt", "utf8") === "source-pinned control\\n",',
				`\tcandidateSource: readFileSync(candidate + "/candidate-source.txt", "utf8") === "candidate input\\n",`,
				'\tdependency: readFileSync("../node_modules/fixture/value.txt", "utf8") === "frozen dependency\\n",',
				'\tfrozenEvaluator: readFileSync(fileURLToPath(import.meta.url), "utf8").includes("frozenEvaluator"),',
				`\tliveSentinel: denied(${JSON.stringify(liveSentinel)}),`,
				`\tliveEnvironment: denied(${JSON.stringify(liveEnvironment)}),`,
				`\tfutureLiveSentinel: denied(${JSON.stringify(futureLiveSentinel)}),`,
				`\tliveGit: denied(${JSON.stringify(join(fixture.liveRepo, ".git", "config"))}),`,
				'\tcontrolGit: denied("../.git"),',
				`\tcandidateGit: denied(candidate + "/.git"),`,
				`\tdependencyPointer: denied(${JSON.stringify(join(dependencyStore, "active"))}),`,
				`\totherDependency: denied(${JSON.stringify(otherDependencySecret)}),`,
				"};",
				'console.log("ISO_RESULT " + JSON.stringify({score: Object.values(constraints).every(Boolean) ? 1 : 0, valid: true, constraints}));',
				"",
			].join("\n");
			const digest = createHash("sha256").update(source).digest("hex");
			const frozenEvaluator = join(frozenRoot, `${digest}.mjs`);
			await writeFile(frozenEvaluator, source, { mode: 0o400 });

			const evaluationPromise = runEvaluator(
				`exec ${shellArgument(process.execPath)} -- ${shellArgument(frozenEvaluator)}`,
				{
					repoRoot: fixture.liveRepo,
					controlCwd,
					experimentDir: fixture.candidate,
					readOnlyPaths: [frozenEvaluator],
					warmups: 0,
					samples: 1,
					timeoutMs: 5_000,
				},
			);
			let evaluatorReady = false;
			for (let attempt = 0; attempt < 500; attempt += 1) {
				try {
					await access(ready);
					evaluatorReady = true;
					break;
				} catch {
					await delay(10);
				}
			}
			if (!evaluatorReady) {
				await evaluationPromise;
				assert.fail("evaluator did not reach the filesystem boundary probe");
			}
			await Promise.all([
				writeFile(futureLiveSentinel, "future mutable secret\n"),
				writeFile(proceed, "continue\n"),
			]);
			const evaluation = await evaluationPromise;
			assert.equal(evaluation.score, 1);
			assert.equal(evaluation.valid, true);
			assert.deepEqual(evaluation.constraints, {
				candidateGit: true,
				candidateSource: true,
				controlGit: true,
				controlSource: true,
				dependency: true,
				dependencyPointer: true,
				frozenEvaluator: true,
				futureLiveSentinel: true,
				liveEnvironment: true,
				liveGit: true,
				liveSentinel: true,
				otherDependency: true,
			});
		} finally {
			await rm(fixture.root, { force: true, recursive: true });
		}
	},
);

test("caps captured output without losing a trailing result", async () => {
	const fixture = await createEvaluatorFixture();
	try {
		const evaluation = await runEvaluator(
			nodeCommand(
				'process.stdout.write("x".repeat(5000)); console.log("\\nISO_RESULT " + JSON.stringify({score: 1}))',
			),
			{
				repoRoot: fixture.liveRepo,
				controlCwd: fixture.control,
				experimentDir: fixture.candidate,
				warmups: 0,
				samples: 1,
				outputLimitBytes: 256,
			},
		);

		assert.equal(evaluation.score, 1);
		assert.equal(evaluation.samples[0].stdoutTruncated, true);
		assert.ok(evaluation.samples[0].stdoutBytes > 256);
		assert.ok(Buffer.byteLength(evaluation.samples[0].stdout) <= 256);
	} finally {
		await rm(fixture.root, { recursive: true });
	}
});

test("rejects a forged result after the trusted result has left the output tail", async (context) => {
	const fixture = await createEvaluatorFixture();
	context.after(async () => {
		await rm(fixture.root, { recursive: true });
	});

	await assert.rejects(
		runEvaluator(
			nodeCommand(
				'console.log("ISO_RESULT " + JSON.stringify({score: 1})); process.stdout.write("x".repeat(5000)); console.log("\\nISO_RESULT " + JSON.stringify({score: 999}))',
			),
			{
				repoRoot: fixture.liveRepo,
				controlCwd: fixture.control,
				experimentDir: fixture.candidate,
				warmups: 0,
				samples: 1,
				outputLimitBytes: 256,
			},
		),
		(error: unknown) =>
			error instanceof EvaluatorContractError &&
			error.message === "Evaluator produced 2 ISO_RESULT lines; exactly one trusted result is required.",
	);
});

test("parses an early result after later diagnostics evict it from the output tail", async (context) => {
	const fixture = await createEvaluatorFixture();
	context.after(async () => {
		await rm(fixture.root, { recursive: true });
	});

	const evaluation = await runEvaluator(
		nodeCommand('console.log("ISO_RESULT " + JSON.stringify({score: 7})); process.stdout.write("x".repeat(5000))'),
		{
			repoRoot: fixture.liveRepo,
			controlCwd: fixture.control,
			experimentDir: fixture.candidate,
			warmups: 0,
			samples: 1,
			outputLimitBytes: 256,
		},
	);

	assert.equal(evaluation.score, 7);
	assert.equal(evaluation.samples[0].stdoutTruncated, true);
	assert.ok(evaluation.samples[0].stdoutBytes > 256);
	assert.ok(Buffer.byteLength(evaluation.samples[0].stdout) <= 256);
	assert.doesNotMatch(evaluation.samples[0].stdout, /ISO_RESULT/u);
});

test("parses an unterminated result split across output chunks", async (context) => {
	const fixture = await createEvaluatorFixture();
	context.after(async () => {
		await rm(fixture.root, { recursive: true });
	});

	const evaluation = await runEvaluator(
		nodeCommand(
			`process.stdout.write("  ISO_"); setTimeout(() => { process.stdout.write('RESULT {"sco'); setTimeout(() => { process.stdout.write('re": 3}'); }, 20); }, 20)`,
		),
		{
			repoRoot: fixture.liveRepo,
			controlCwd: fixture.control,
			experimentDir: fixture.candidate,
			warmups: 0,
			samples: 1,
			outputLimitBytes: 256,
		},
	);

	assert.equal(evaluation.score, 3);
});

test("fails closed when the trusted result line exceeds the capture limit", async (context) => {
	const fixture = await createEvaluatorFixture();
	context.after(async () => {
		await rm(fixture.root, { recursive: true });
	});

	await assert.rejects(
		runEvaluator(nodeCommand('console.log("ISO_RESULT " + JSON.stringify({score: 1, summary: "x".repeat(500)}))'), {
			repoRoot: fixture.liveRepo,
			controlCwd: fixture.control,
			experimentDir: fixture.candidate,
			warmups: 0,
			samples: 1,
			outputLimitBytes: 128,
		}),
		(error: unknown) =>
			error instanceof EvaluatorContractError &&
			error.message === "Evaluator ISO_RESULT line exceeded the 128-byte output capture limit.",
	);
});

test("times out and terminates an evaluator process", async () => {
	const startedAt = performance.now();
	const fixture = await createEvaluatorFixture();
	try {
		await assert.rejects(
			runEvaluator(nodeCommand("setInterval(() => {}, 1000)"), {
				repoRoot: fixture.liveRepo,
				controlCwd: fixture.control,
				experimentDir: fixture.candidate,
				warmups: 0,
				samples: 1,
				timeoutMs: 30,
			}),
			(error: unknown) => error instanceof EvaluatorTimeoutError && error.timeoutMs === 30,
		);
		assert.ok(performance.now() - startedAt < 2_000);
	} finally {
		await rm(fixture.root, { recursive: true });
	}
});

test("cancellation terminates an evaluator process", async () => {
	const controller = new AbortController();
	const fixture = await createEvaluatorFixture();
	const evaluation = runEvaluator(nodeCommand("setInterval(() => {}, 1000)"), {
		repoRoot: fixture.liveRepo,
		controlCwd: fixture.control,
		experimentDir: fixture.candidate,
		warmups: 0,
		samples: 1,
		timeoutMs: 5_000,
		signal: controller.signal,
	});
	setTimeout(() => {
		controller.abort();
	}, 30);

	await assert.rejects(
		evaluation,
		(error: unknown) => error instanceof EvaluatorAbortError && error.name === "AbortError",
	);
	await rm(fixture.root, { recursive: true });
});
