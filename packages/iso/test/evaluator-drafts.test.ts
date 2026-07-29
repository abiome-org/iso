import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { chmod, link, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { runEvaluator } from "../src/evaluator.ts";
import {
	EvaluatorDraftStoreError,
	freezeEvaluatorDraft,
	storeEvaluatorDraft,
	validateEvaluatorDraft,
} from "../src/evaluator-drafts.ts";

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

async function createValidationFixture(): Promise<{
	candidate: string;
	parent: string;
	repo: string;
}> {
	const parent = await mkdtemp(join(tmpdir(), "iso-evaluator-drafts-test-"));
	const repo = join(parent, "repo");
	const candidate = join(parent, "candidate");
	await Promise.all([mkdir(repo, { mode: 0o700 }), mkdir(candidate, { mode: 0o700 })]);
	await writeFile(join(candidate, "score.txt"), "7\n");
	return { candidate, parent, repo };
}

function evaluatorSource(version: number): string {
	return [
		'import { readFileSync } from "node:fs";',
		"const candidate = process.env.ISO_EXPERIMENT_DIR;",
		'if (!candidate) throw new Error("missing candidate");',
		'const score = Number(readFileSync(candidate + "/score.txt", "utf8"));',
		`console.log("ISO_RESULT " + JSON.stringify({ score: score + ${version - 1}, metrics: { version: ${version} }, valid: true, constraints: { candidate: true } }));`,
		"",
	].join("\n");
}

function absoluteStoredPath(repo: string, relativePath: string): string {
	return join(repo, ...relativePath.split("/"));
}

function shellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function currentProcessStartIdentity(): string {
	if (process.platform === "linux") {
		const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
		const commandEnd = stat.lastIndexOf(")");
		assert.notEqual(commandEnd, -1);
		const startTicks = stat
			.slice(commandEnd + 1)
			.trim()
			.split(/\s+/u)[19];
		assert.ok(startTicks);
		const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		return `linux:${bootId}:${startTicks}`;
	}
	assert.equal(process.platform, "darwin");
	const inspected = spawnSync("/bin/ps", ["-p", String(process.pid), "-o", "lstart="], {
		encoding: "utf8",
		env: { LC_ALL: "C", PATH: "/usr/bin:/bin" },
	});
	assert.equal(inspected.status, 0, inspected.stderr);
	assert.notEqual(inspected.stdout.trim(), "");
	return `darwin:${inspected.stdout.trim()}`;
}

async function killedProcessId(): Promise<number> {
	const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
	const processId = child.pid;
	assert.ok(processId);
	child.kill("SIGKILL");
	await new Promise<void>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("close", () => resolveExit());
	});
	return processId;
}

async function mode(path: string): Promise<number> {
	return (await lstat(path)).mode & 0o777;
}

test(
	"atomically replaces named drafts while preserving immutable campaign artifacts by digest",
	{ skip: sandboxSkipReason(), timeout: 30_000 },
	async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		try {
			const sourceV1 = evaluatorSource(1);
			const storedV1 = await storeEvaluatorDraft({
				repoRoot: repo,
				candidateCwd: candidate,
				name: "quality",
				source: sourceV1,
				timeoutMs: 2_000,
			});
			assert.equal(storedV1.evaluation.score, 7);
			assert.equal(storedV1.evaluation.valid, true);
			assert.equal(storedV1.digest, createHash("sha256").update(sourceV1).digest("hex"));
			const draftPath = absoluteStoredPath(repo, storedV1.draftPath);
			const objectV1Path = absoluteStoredPath(repo, storedV1.objectPath);
			assert.equal(await readFile(draftPath, "utf8"), sourceV1);
			assert.equal(await readFile(objectV1Path, "utf8"), sourceV1);
			assert.equal(await mode(draftPath), 0o600);
			assert.equal(await mode(objectV1Path), 0o400);

			const frozenV1 = await freezeEvaluatorDraft({
				repoRoot: repo,
				candidateCwd: candidate,
				name: "quality",
				digest: storedV1.digest,
				timeoutMs: 2_000,
			});
			const frozenV1Path = absoluteStoredPath(repo, frozenV1.frozenPath);
			assert.equal(await readFile(frozenV1Path, "utf8"), sourceV1);
			assert.equal(await mode(frozenV1Path), 0o400);
			assert.equal(await mode(draftPath), 0o600);

			await chmod(join(repo, ".iso"), 0o755);
			await chmod(join(repo, ".iso", "evaluators", "drafts"), 0o755);
			await chmod(draftPath, 0o644);
			const sourceV2 = evaluatorSource(2);
			const storedV2 = await storeEvaluatorDraft({
				repoRoot: repo,
				candidateCwd: candidate,
				name: "quality",
				source: sourceV2,
				timeoutMs: 2_000,
			});
			assert.notEqual(storedV2.digest, storedV1.digest);
			assert.equal(storedV2.evaluation.score, 8);
			assert.equal(await readFile(draftPath, "utf8"), sourceV2);
			assert.equal(await mode(draftPath), 0o600);
			assert.equal(await mode(join(repo, ".iso")), 0o700);
			assert.equal(await mode(join(repo, ".iso", "evaluators", "drafts")), 0o700);
			assert.equal(await readFile(objectV1Path, "utf8"), sourceV1);
			assert.equal(await readFile(frozenV1Path, "utf8"), sourceV1);

			const frozenV2 = await freezeEvaluatorDraft({
				repoRoot: repo,
				candidateCwd: candidate,
				name: "quality",
				digest: storedV2.digest,
				timeoutMs: 2_000,
			});
			assert.notEqual(frozenV2.frozenPath, frozenV1.frozenPath);
			assert.equal(await readFile(absoluteStoredPath(repo, frozenV2.frozenPath), "utf8"), sourceV2);
			assert.equal(await readFile(frozenV1Path, "utf8"), sourceV1);
			await assert.rejects(
				freezeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "quality",
					digest: storedV1.digest,
					timeoutMs: 2_000,
				}),
				/no longer matches expected digest/u,
			);

			assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", ".locks")), []);
			assert.equal(
				(await readdir(join(repo, ".iso", "evaluators", "drafts"))).some((entry) => entry.startsWith(".replace-")),
				false,
			);
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	},
);

test("rejects invalid Node syntax before installing any evaluator bytes", async () => {
	const { candidate, parent, repo } = await createValidationFixture();
	try {
		await assert.rejects(
			storeEvaluatorDraft({
				repoRoot: repo,
				candidateCwd: candidate,
				name: "syntax",
				source: "export const = ;\n",
			}),
			/failed Node syntax validation/u,
		);
		assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "drafts")), []);
		assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "objects")), []);
		assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "frozen")), []);
		assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", ".locks")), []);
		for (const directory of [
			join(repo, ".iso"),
			join(repo, ".iso", "evaluators"),
			join(repo, ".iso", "evaluators", "drafts"),
			join(repo, ".iso", "evaluators", "objects"),
			join(repo, ".iso", "evaluators", "frozen"),
		]) {
			assert.equal(await mode(directory), 0o700);
		}
	} finally {
		await rm(parent, { force: true, recursive: true });
	}
});

test(
	"reclaims an evaluator name lock whose PID and process-start owner is demonstrably stale",
	{ skip: process.platform !== "darwin" && process.platform !== "linux" },
	async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		const source = "export const = ;\n";
		try {
			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "setup",
					source,
				}),
				/failed Node syntax validation/u,
			);
			const locks = join(repo, ".iso", "evaluators", ".locks");
			const stalePid = await killedProcessId();
			const token = "c".repeat(32);
			const staleLock = join(locks, `quality.${stalePid}.${token}.lock`);
			await writeFile(
				staleLock,
				`${JSON.stringify({
					version: 1,
					name: "quality",
					pid: stalePid,
					processStart: "stale-owner",
					token,
				})}\n`,
				{ mode: 0o600 },
			);

			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "quality",
					source,
				}),
				/failed Node syntax validation/u,
			);
			assert.deepEqual(await readdir(locks), []);
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	},
);

test(
	"preserves mutual exclusion for a live evaluator name-lock owner",
	{ skip: process.platform !== "darwin" && process.platform !== "linux" },
	async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		const source = "export const = ;\n";
		try {
			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "setup",
					source,
				}),
				/failed Node syntax validation/u,
			);
			const locks = join(repo, ".iso", "evaluators", ".locks");
			const token = "d".repeat(32);
			const liveLockName = `quality.${process.pid}.${token}.lock`;
			const liveLock = join(locks, liveLockName);
			await writeFile(
				liveLock,
				`${JSON.stringify({
					version: 1,
					name: "quality",
					pid: process.pid,
					processStart: currentProcessStartIdentity(),
					token,
				})}\n`,
				{ mode: 0o600 },
			);

			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "quality",
					source,
				}),
				/already being changed/u,
			);
			assert.deepEqual(await readdir(locks), [liveLockName]);

			await rm(liveLock);
			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "quality",
					source,
				}),
				/failed Node syntax validation/u,
			);
			assert.deepEqual(await readdir(locks), []);
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	},
);

test(
	"rejects malformed or invalid ISO_RESULT dry-runs before installing drafts",
	{ skip: sandboxSkipReason(), timeout: 20_000 },
	async (context) => {
		await context.test("missing result", async () => {
			const { candidate, parent, repo } = await createValidationFixture();
			try {
				await assert.rejects(
					storeEvaluatorDraft({
						repoRoot: repo,
						candidateCwd: candidate,
						name: "missing",
						source: 'console.log("not a result");\n',
						timeoutMs: 1_000,
					}),
					/produced no ISO_RESULT line/u,
				);
				assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "drafts")), []);
				assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "objects")), []);
			} finally {
				await rm(parent, { force: true, recursive: true });
			}
		});

		await context.test("failed constraint", async () => {
			const { candidate, parent, repo } = await createValidationFixture();
			try {
				await assert.rejects(
					storeEvaluatorDraft({
						repoRoot: repo,
						candidateCwd: candidate,
						name: "invalid",
						source:
							'console.log("ISO_RESULT " + JSON.stringify({score: 1, valid: true, constraints: {safe: false}}));\n',
						timeoutMs: 1_000,
					}),
					/valid=false or a failed ISO_RESULT constraint/u,
				);
				assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "drafts")), []);
				assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "objects")), []);
			} finally {
				await rm(parent, { force: true, recursive: true });
			}
		});

		await context.test("bounded timeout", async () => {
			const { candidate, parent, repo } = await createValidationFixture();
			try {
				await assert.rejects(
					storeEvaluatorDraft({
						repoRoot: repo,
						candidateCwd: candidate,
						name: "timeout",
						source: "setInterval(() => {}, 1000);\n",
						timeoutMs: 100,
					}),
					/timed out after 100ms/u,
				);
				assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "drafts")), []);
				assert.deepEqual(await readdir(join(repo, ".iso", "evaluators", "objects")), []);
			} finally {
				await rm(parent, { force: true, recursive: true });
			}
		});
	},
);

test("refuses symlink, hard-link and wrong-type evaluator control paths without following them", async (context) => {
	await context.test("symlink evaluator directory", async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		const outside = join(parent, "outside");
		await Promise.all([mkdir(join(repo, ".iso"), { mode: 0o700 }), mkdir(outside, { mode: 0o700 })]);
		await symlink(outside, join(repo, ".iso", "evaluators"), "dir");
		try {
			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "quality",
					source: evaluatorSource(1),
				}),
				/Evaluator store directory must be a real directory/u,
			);
			assert.deepEqual(await readdir(outside), []);
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	});

	await context.test("symlink named draft", async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		const store = join(repo, ".iso", "evaluators");
		await Promise.all([
			mkdir(join(store, "drafts"), { recursive: true, mode: 0o700 }),
			mkdir(join(store, "objects"), { recursive: true, mode: 0o700 }),
			mkdir(join(store, "frozen"), { recursive: true, mode: 0o700 }),
			mkdir(join(store, ".locks"), { recursive: true, mode: 0o700 }),
		]);
		const outside = join(parent, "outside.mjs");
		await writeFile(outside, "outside sentinel\n");
		await symlink(outside, join(store, "drafts", "quality.mjs"));
		try {
			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "quality",
					source: evaluatorSource(1),
				}),
				/Evaluator draft 'quality' must be a regular file/u,
			);
			assert.equal(await readFile(outside, "utf8"), "outside sentinel\n");
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	});

	await context.test("hard-linked named draft", async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		const store = join(repo, ".iso", "evaluators");
		await Promise.all([
			mkdir(join(store, "drafts"), { recursive: true, mode: 0o700 }),
			mkdir(join(store, "objects"), { recursive: true, mode: 0o700 }),
			mkdir(join(store, "frozen"), { recursive: true, mode: 0o700 }),
			mkdir(join(store, ".locks"), { recursive: true, mode: 0o700 }),
		]);
		const outside = join(parent, "outside-hardlink.mjs");
		await writeFile(outside, "outside sentinel\n", { mode: 0o600 });
		await link(outside, join(store, "drafts", "quality.mjs"));
		try {
			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "quality",
					source: evaluatorSource(1),
				}),
				/must have exactly one filesystem link/u,
			);
			assert.equal(await readFile(outside, "utf8"), "outside sentinel\n");
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	});

	await context.test("wrong-type objects directory", async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		const store = join(repo, ".iso", "evaluators");
		await mkdir(store, { recursive: true, mode: 0o700 });
		await writeFile(join(store, "objects"), "not a directory\n", { mode: 0o600 });
		try {
			await assert.rejects(
				storeEvaluatorDraft({
					repoRoot: repo,
					candidateCwd: candidate,
					name: "quality",
					source: evaluatorSource(1),
				}),
				/Evaluator objects directory must be a real directory/u,
			);
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	});
});

test("requires an explicit disposable candidate directory disjoint from the repository", async () => {
	const parent = await mkdtemp(join(tmpdir(), "iso-evaluator-candidate-policy-"));
	const repo = join(parent, "repo");
	await mkdir(repo);
	try {
		await assert.rejects(
			validateEvaluatorDraft({
				repoRoot: repo,
				candidateCwd: repo,
				source: evaluatorSource(1),
			}),
			(error: unknown) =>
				error instanceof EvaluatorDraftStoreError &&
				error.message.includes("must be a disposable directory disjoint"),
		);
	} finally {
		await rm(parent, { force: true, recursive: true });
	}
});

test(
	"validates from the same detached control cwd used by campaign evaluation",
	{ skip: sandboxSkipReason(), timeout: 20_000 },
	async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		const control = join(parent, "control");
		await mkdir(control, { mode: 0o700 });
		await writeFile(join(control, "control-score.txt"), "11\n");
		const source = [
			'import { readFileSync } from "node:fs";',
			"const candidate = process.env.ISO_EXPERIMENT_DIR;",
			'if (!candidate) throw new Error("missing candidate");',
			'const controlScore = Number(readFileSync("control-score.txt", "utf8"));',
			'const candidateScore = Number(readFileSync(candidate + "/score.txt", "utf8"));',
			'console.log("ISO_RESULT " + JSON.stringify({score: controlScore + candidateScore, valid: true}));',
			"",
		].join("\n");
		try {
			const validation = await validateEvaluatorDraft({
				repoRoot: repo,
				controlCwd: control,
				candidateCwd: candidate,
				source,
				timeoutMs: 2_000,
			});
			assert.equal(validation.evaluation.score, 18);
			assert.equal(
				(await readdir(control)).some((entry) => entry.startsWith(".iso-evaluator-validation-")),
				false,
			);
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	},
);

test(
	"admits only the exact frozen evaluator file while keeping siblings, drafts and database hidden",
	{ skip: sandboxSkipReason(), timeout: 20_000 },
	async () => {
		const { candidate, parent, repo } = await createValidationFixture();
		const control = join(parent, "control");
		const evaluatorRoot = join(repo, ".iso", "evaluators");
		const frozenRoot = join(evaluatorRoot, "frozen");
		const draftsRoot = join(evaluatorRoot, "drafts");
		await Promise.all([
			mkdir(control, { mode: 0o700 }),
			mkdir(frozenRoot, { recursive: true, mode: 0o700 }),
			mkdir(draftsRoot, { recursive: true, mode: 0o700 }),
		]);
		const sibling = join(frozenRoot, `${"b".repeat(64)}.mjs`);
		const draft = join(draftsRoot, "quality.mjs");
		const database = join(repo, ".iso", "iso.db");
		await Promise.all([
			writeFile(sibling, "sibling secret\n", { mode: 0o400 }),
			writeFile(draft, "draft secret\n", { mode: 0o600 }),
			writeFile(database, "database secret\n", { mode: 0o600 }),
		]);
		const source = [
			'import { readFileSync } from "node:fs";',
			"const denied = (path) => {",
			"\ttry { readFileSync(path); return false; } catch { return true; }",
			"};",
			`const constraints = { sibling: denied(${JSON.stringify(sibling)}), draft: denied(${JSON.stringify(draft)}), database: denied(${JSON.stringify(database)}) };`,
			'console.log("ISO_RESULT " + JSON.stringify({score: 1, valid: true, constraints}));',
			"",
		].join("\n");
		const digest = createHash("sha256").update(source).digest("hex");
		const frozen = join(frozenRoot, `${digest}.mjs`);
		const forged = join(frozenRoot, `${"c".repeat(64)}.mjs`);
		await writeFile(frozen, source, { mode: 0o400 });
		await writeFile(forged, source, { mode: 0o400 });
		const command = `exec node -- ${shellArgument(frozen)}`;
		try {
			await assert.rejects(
				runEvaluator(command, {
					repoRoot: repo,
					controlCwd: control,
					experimentDir: candidate,
					warmups: 0,
					samples: 1,
					timeoutMs: 1_000,
				}),
			);
			await assert.rejects(
				runEvaluator(`exec node -- ${shellArgument(forged)}`, {
					repoRoot: repo,
					controlCwd: control,
					experimentDir: candidate,
					readOnlyPaths: [forged],
					warmups: 0,
					samples: 1,
					timeoutMs: 1_000,
				}),
				/failed content-address verification/u,
			);
			const evaluation = await runEvaluator(command, {
				repoRoot: repo,
				controlCwd: control,
				experimentDir: candidate,
				readOnlyPaths: [frozen],
				warmups: 0,
				samples: 1,
				timeoutMs: 1_000,
			});
			assert.equal(evaluation.valid, true);
			assert.deepEqual(evaluation.constraints, {
				database: true,
				draft: true,
				sibling: true,
			});
			await assert.rejects(
				runEvaluator("exec true", {
					repoRoot: repo,
					controlCwd: control,
					experimentDir: candidate,
					readOnlyPaths: [join(candidate, "score.txt")],
					warmups: 0,
					samples: 1,
				}),
				/must be an exact frozen evaluator path/u,
			);
		} finally {
			await rm(parent, { force: true, recursive: true });
		}
	},
);
