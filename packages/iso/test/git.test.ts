import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, chmod, link, lstat, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runEvaluator } from "../src/evaluator.ts";
import {
	activateDependencySnapshot,
	assertCleanRepository,
	assertEvaluatorDigest,
	createDetachedWorktree,
	createEvaluatorControlWorktree,
	createExperimentWorktree,
	createGenerationWorktree,
	evaluatorDigest,
	normalizeRepositoryRelativePath,
	prepareDependencySnapshot,
	removeWorktree,
	resolveCommit,
	snapshotExperiment,
} from "../src/git.ts";

const exec = promisify(execFile);

function shellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

async function createRepository(): Promise<{ root: string; baseCommit: string }> {
	const root = await mkdtemp(join(tmpdir(), "iso-git-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
	await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
	await writeFile(join(root, ".gitignore"), ".iso/\n");
	await writeFile(join(root, "evaluator.mjs"), "export const version = 1;\n");
	await writeFile(join(root, "subject.txt"), "baseline\n");
	await exec("git", ["add", "--", ".gitignore", "evaluator.mjs", "subject.txt"], { cwd: root });
	await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });
	return { root, baseCommit: await resolveCommit(root) };
}

test("pins generation and experiment worktrees to the exact recorded base", async () => {
	const { root, baseCommit } = await createRepository();
	let generationWorktree: string | undefined;
	let experimentWorktree: string | undefined;
	try {
		await writeFile(join(root, "subject.txt"), "newer main checkout\n");
		await exec("git", ["add", "--", "subject.txt"], { cwd: root });
		await exec("git", ["commit", "-q", "-m", "move main"], { cwd: root });

		generationWorktree = await createGenerationWorktree({
			repoRoot: root,
			generationId: "generation_test",
			baseCommit,
		});
		const experiment = await createExperimentWorktree({
			repoRoot: root,
			title: "Try a branch",
			experimentId: "experiment_1234567890ab",
			baseCommit,
		});
		experimentWorktree = experiment.worktree;

		assert.equal(await resolveCommit(generationWorktree), baseCommit);
		assert.equal(await resolveCommit(experiment.worktree), baseCommit);
		assert.equal(await readFile(join(generationWorktree, "subject.txt"), "utf8"), "baseline\n");
		assert.equal(await readFile(join(experiment.worktree, "subject.txt"), "utf8"), "baseline\n");
	} finally {
		if (experimentWorktree) {
			await removeWorktree(root, experimentWorktree);
		}
		if (generationWorktree) {
			await removeWorktree(root, generationWorktree);
		}
		await rm(root, { recursive: true });
	}
});

test("freezes unstaged, staged-only, untracked, and worker-committed changes", async (context) => {
	await context.test("unstaged and untracked changes", async () => {
		const { root, baseCommit } = await createRepository();
		let worktree: string | undefined;
		try {
			const experiment = await createExperimentWorktree({
				repoRoot: root,
				title: "Dirty candidate",
				experimentId: "experiment_dirty000001",
				baseCommit,
			});
			worktree = experiment.worktree;
			await writeFile(join(worktree, "subject.txt"), "experiment\n");
			await writeFile(join(worktree, "new.txt"), "new evidence\n");
			const snapshot = await snapshotExperiment({
				repoRoot: root,
				worktree,
				baseCommit,
				title: "Dirty candidate",
				protectedPaths: ["evaluator.mjs"],
			});

			assert.notEqual(snapshot.commit, baseCommit);
			assert.deepEqual(snapshot.changedPaths, ["new.txt", "subject.txt"]);
			assert.match(snapshot.diffStat, /subject\.txt/);
			assert.equal(await readFile(join(root, "subject.txt"), "utf8"), "baseline\n");
		} finally {
			if (worktree) {
				await removeWorktree(root, worktree);
			}
			await rm(root, { recursive: true });
		}
	});

	await context.test("staged-only changes", async () => {
		const { root, baseCommit } = await createRepository();
		let worktree: string | undefined;
		try {
			const experiment = await createExperimentWorktree({
				repoRoot: root,
				title: "Staged candidate",
				experimentId: "experiment_staged00001",
				baseCommit,
			});
			worktree = experiment.worktree;
			await writeFile(join(worktree, "subject.txt"), "staged experiment\n");
			await exec("git", ["add", "--", "subject.txt"], { cwd: worktree });
			const snapshot = await snapshotExperiment({
				repoRoot: root,
				worktree,
				baseCommit,
				title: "Staged candidate",
				protectedPaths: ["evaluator.mjs"],
			});

			assert.notEqual(snapshot.commit, baseCommit);
			assert.deepEqual(snapshot.changedPaths, ["subject.txt"]);
			assert.match(snapshot.diffStat, /subject\.txt/);
		} finally {
			if (worktree) {
				await removeWorktree(root, worktree);
			}
			await rm(root, { recursive: true });
		}
	});

	await context.test("worker-authored commits", async () => {
		const { root, baseCommit } = await createRepository();
		let worktree: string | undefined;
		try {
			const experiment = await createExperimentWorktree({
				repoRoot: root,
				title: "Committed candidate",
				experimentId: "experiment_commit00001",
				baseCommit,
			});
			worktree = experiment.worktree;
			await writeFile(join(worktree, "subject.txt"), "self committed\n");
			await exec("git", ["add", "--", "subject.txt"], { cwd: worktree });
			await exec("git", ["commit", "-q", "-m", "worker commit"], { cwd: worktree });
			const authoredCommit = await resolveCommit(worktree);
			const snapshot = await snapshotExperiment({
				repoRoot: root,
				worktree,
				baseCommit,
				title: "Committed candidate",
				protectedPaths: ["evaluator.mjs"],
			});

			assert.notEqual(snapshot.commit, authoredCommit);
			const [authoredTree, snapshotTree, snapshotLineage] = await Promise.all([
				exec("git", ["rev-parse", `${authoredCommit}^{tree}`], { cwd: root }),
				exec("git", ["rev-parse", `${snapshot.commit}^{tree}`], { cwd: root }),
				exec("git", ["rev-list", "--parents", "-n", "1", snapshot.commit], { cwd: root }),
			]);
			assert.equal(snapshotTree.stdout, authoredTree.stdout);
			assert.deepEqual(snapshotLineage.stdout.trim().split(" "), [snapshot.commit, baseCommit]);
			assert.deepEqual(snapshot.changedPaths, ["subject.txt"]);
		} finally {
			if (worktree) {
				await removeWorktree(root, worktree);
			}
			await rm(root, { recursive: true });
		}
	});
});

test("freezes through a bounded quarantine and treats renames as delete plus add", async (context) => {
	await context.test("ordinary rename removes the source path", async () => {
		const { root, baseCommit } = await createRepository();
		let worktree: string | undefined;
		try {
			const experiment = await createExperimentWorktree({
				repoRoot: root,
				title: "Rename candidate",
				experimentId: "experiment_rename000001",
				baseCommit,
			});
			worktree = experiment.worktree;
			await rename(join(worktree, "subject.txt"), join(worktree, "renamed.txt"));

			const snapshot = await snapshotExperiment({
				repoRoot: root,
				worktree,
				baseCommit,
				title: "Rename candidate",
				protectedPaths: ["evaluator.mjs"],
			});

			assert.deepEqual(snapshot.changedPaths, ["renamed.txt", "subject.txt"]);
			assert.equal(
				(await exec("git", ["show", `${snapshot.commit}:renamed.txt`], { cwd: root })).stdout,
				"baseline\n",
			);
			await assert.rejects(exec("git", ["show", `${snapshot.commit}:subject.txt`], { cwd: root }));
		} finally {
			if (worktree) {
				await removeWorktree(root, worktree);
			}
			await rm(root, { force: true, recursive: true });
		}
	});

	await context.test("renaming a protected path remains protected", async () => {
		const { root, baseCommit } = await createRepository();
		let worktree: string | undefined;
		try {
			const experiment = await createExperimentWorktree({
				repoRoot: root,
				title: "Rename evaluator",
				experimentId: "experiment_rename000002",
				baseCommit,
			});
			worktree = experiment.worktree;
			await rename(join(worktree, "evaluator.mjs"), join(worktree, "copied-evaluator.mjs"));
			await assert.rejects(
				snapshotExperiment({
					repoRoot: root,
					worktree,
					baseCommit,
					title: "Rename evaluator",
					protectedPaths: ["evaluator.mjs"],
				}),
				/Candidate modified protected evaluator inputs: evaluator\.mjs/,
			);
		} finally {
			if (worktree) {
				await removeWorktree(root, worktree);
			}
			await rm(root, { force: true, recursive: true });
		}
	});

	await context.test("hard-linked outside bytes never enter the object database", async () => {
		const { root, baseCommit } = await createRepository();
		const outside = await mkdtemp(join(tmpdir(), "iso-freeze-secret-"));
		let worktree: string | undefined;
		try {
			const secret = join(outside, "outside-secret.txt");
			await writeFile(secret, "quarantine-regression-secret\n");
			const object = (await exec("git", ["hash-object", "--no-filters", "--", secret], { cwd: root })).stdout.trim();
			const experiment = await createExperimentWorktree({
				repoRoot: root,
				title: "Hard link confused deputy",
				experimentId: "experiment_hardlink0001",
				baseCommit,
			});
			worktree = experiment.worktree;
			await link(secret, join(worktree, "alias.txt"));

			await assert.rejects(
				snapshotExperiment({
					repoRoot: root,
					worktree,
					baseCommit,
					title: "Hard link confused deputy",
					protectedPaths: ["evaluator.mjs"],
				}),
				/single-link regular file|hard-link/u,
			);
			await assert.rejects(exec("git", ["cat-file", "-e", object], { cwd: root }));
		} finally {
			if (worktree) {
				await removeWorktree(root, worktree);
			}
			await Promise.all([rm(root, { force: true, recursive: true }), rm(outside, { force: true, recursive: true })]);
		}
	});

	await context.test("per-file and aggregate byte budgets fail before object creation", async () => {
		const { root, baseCommit } = await createRepository();
		let worktree: string | undefined;
		try {
			const experiment = await createExperimentWorktree({
				repoRoot: root,
				title: "Bound candidate bytes",
				experimentId: "experiment_bytecap0001",
				baseCommit,
			});
			worktree = experiment.worktree;
			const oversized = "unique-candidate-byte-cap-".repeat(100);
			await writeFile(join(worktree, "oversized.txt"), oversized);
			const object = (
				await exec("git", ["hash-object", "--no-filters", "--", join(worktree, "oversized.txt")], {
					cwd: root,
				})
			).stdout.trim();
			await assert.rejects(
				snapshotExperiment({
					repoRoot: root,
					worktree,
					baseCommit,
					title: "Bound one file",
					protectedPaths: ["evaluator.mjs"],
					maxCandidateFileBytes: 512,
					maxCandidateBytes: 1024,
				}),
				/candidate byte limit exceeded/u,
			);
			await assert.rejects(exec("git", ["cat-file", "-e", object], { cwd: root }));

			await rm(join(worktree, "oversized.txt"));
			await Promise.all([
				writeFile(join(worktree, "first.txt"), "a".repeat(700)),
				writeFile(join(worktree, "second.txt"), "b".repeat(700)),
			]);
			await assert.rejects(
				snapshotExperiment({
					repoRoot: root,
					worktree,
					baseCommit,
					title: "Bound aggregate",
					protectedPaths: ["evaluator.mjs"],
					maxCandidateFileBytes: 800,
					maxCandidateBytes: 1024,
				}),
				/candidate byte limit exceeded/u,
			);
		} finally {
			if (worktree) {
				await removeWorktree(root, worktree);
			}
			await rm(root, { force: true, recursive: true });
		}
	});

	await context.test("path count is rejected before capture", async () => {
		const { root, baseCommit } = await createRepository();
		let worktree: string | undefined;
		try {
			const experiment = await createExperimentWorktree({
				repoRoot: root,
				title: "Bound candidate paths",
				experimentId: "experiment_pathcap0001",
				baseCommit,
			});
			worktree = experiment.worktree;
			await Promise.all(
				["one.txt", "two.txt", "three.txt"].map((path) => writeFile(join(worktree ?? "", path), path)),
			);
			await assert.rejects(
				snapshotExperiment({
					repoRoot: root,
					worktree,
					baseCommit,
					title: "Bound candidate paths",
					protectedPaths: ["evaluator.mjs"],
					maxChangedPaths: 2,
				}),
				/Policy rejected 3 changed paths; limit is 2/u,
			);
		} finally {
			if (worktree) {
				await removeWorktree(root, worktree);
			}
			await rm(root, { force: true, recursive: true });
		}
	});
});

test("plumbing snapshots bypass repository hooks and clean filters", async () => {
	const { root, baseCommit } = await createRepository();
	const hooksRoot = await mkdtemp(join(tmpdir(), "iso-git-hooks-"));
	let worktree: string | undefined;
	try {
		const experiment = await createExperimentWorktree({
			repoRoot: root,
			title: "Bypass hostile Git execution",
			experimentId: "experiment_plumbing0001",
			baseCommit,
		});
		worktree = experiment.worktree;

		const hookSentinel = join(hooksRoot, "hook-ran");
		const filterSentinel = join(hooksRoot, "filter-ran");
		const referenceHook = join(hooksRoot, "reference-transaction");
		const filter = join(hooksRoot, "hostile-filter");
		await writeFile(referenceHook, `#!/bin/sh\nprintf invoked > ${shellArgument(hookSentinel)}\n`);
		await writeFile(filter, `#!/bin/sh\nprintf invoked > ${shellArgument(filterSentinel)}\ncat\n`);
		await Promise.all([chmod(referenceHook, 0o700), chmod(filter, 0o700)]);
		await exec("git", ["config", "core.hooksPath", hooksRoot], { cwd: root });
		await exec("git", ["config", "filter.hostile.clean", filter], { cwd: root });
		await writeFile(join(root, ".git", "info", "attributes"), "candidate.txt filter=hostile\n");
		await writeFile(join(worktree, "candidate.txt"), "raw candidate\n");

		const snapshot = await snapshotExperiment({
			repoRoot: root,
			worktree,
			baseCommit,
			title: "Bypass hostile Git execution",
			protectedPaths: ["evaluator.mjs"],
		});

		assert.deepEqual(snapshot.changedPaths, ["candidate.txt"]);
		const committed = await exec("git", ["show", `${snapshot.commit}:candidate.txt`], { cwd: root });
		assert.equal(committed.stdout, "raw candidate\n");
		await assert.rejects(access(hookSentinel));
		await assert.rejects(access(filterSentinel));
	} finally {
		if (worktree) {
			await removeWorktree(root, worktree);
		}
		await Promise.all([rm(root, { force: true, recursive: true }), rm(hooksRoot, { force: true, recursive: true })]);
	}
});

test("removes readonly dependency mounts before snapshotting candidates", async () => {
	const { root } = await createRepository();
	let worktree: string | undefined;
	try {
		await mkdir(join(root, "packages", "workspace"), { recursive: true });
		await writeFile(join(root, "packages", "workspace", "index.js"), "export default 'candidate workspace';\n");
		await exec("git", ["add", "--", "packages/workspace/index.js"], { cwd: root });
		await exec("git", ["commit", "-q", "-m", "add workspace fixture"], { cwd: root });
		const baseCommit = await resolveCommit(root);
		await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
		await writeFile(join(root, "node_modules", "fixture", "index.js"), "export default 1;\n");
		await symlink(join(root, "packages", "workspace"), join(root, "node_modules", "workspace"), "dir");
		const experiment = await createExperimentWorktree({
			repoRoot: root,
			title: "Ignore dependency mount",
			experimentId: "experiment_mount000001",
			baseCommit,
		});
		worktree = experiment.worktree;
		assert.equal((await lstat(join(worktree, "node_modules"))).isDirectory(), true);
		assert.equal((await lstat(join(worktree, "node_modules", "fixture"))).isSymbolicLink(), true);
		assert.equal(
			await readFile(join(worktree, "node_modules", "workspace", "index.js"), "utf8"),
			"export default 'candidate workspace';\n",
		);
		await writeFile(join(worktree, "packages", "workspace", "index.js"), "export default 'changed candidate';\n");
		assert.equal(
			await readFile(join(worktree, "node_modules", "workspace", "index.js"), "utf8"),
			"export default 'changed candidate';\n",
		);
		await writeFile(join(worktree, "candidate.txt"), "candidate\n");

		const snapshot = await snapshotExperiment({
			repoRoot: root,
			worktree,
			baseCommit,
			title: "Ignore dependency mount",
			protectedPaths: ["evaluator.mjs"],
		});

		assert.deepEqual(snapshot.changedPaths, ["candidate.txt", "packages/workspace/index.js"]);
		assert.doesNotMatch(snapshot.diffStat, /node_modules/u);
		await assert.rejects(lstat(join(worktree, "node_modules")));
	} finally {
		if (worktree) {
			await removeWorktree(root, worktree);
		}
		await rm(root, { force: true, recursive: true });
	}
});

test("freezes dependency manifests and detects installed dependency metadata drift", async () => {
	const { root, baseCommit } = await createRepository();
	let worktree: string | undefined;
	try {
		await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3}\n');
		await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
		await writeFile(join(root, "node_modules", ".package-lock.json"), '{"packages":{}}\n');
		await writeFile(join(root, "node_modules", "fixture", "index.js"), "export default 1;\n");
		const digest = await evaluatorDigest({
			repoRoot: root,
			controlCwd: root,
			command: "true",
			protectedPaths: [],
		});
		const experiment = await createExperimentWorktree({
			repoRoot: root,
			title: "Change dependency environment",
			experimentId: "experiment_deps0000001",
			baseCommit,
		});
		worktree = experiment.worktree;
		await writeFile(join(worktree, "package.json"), '{"dependencies":{"forged":"1.0.0"}}\n');
		await assert.rejects(
			snapshotExperiment({
				repoRoot: root,
				worktree,
				baseCommit,
				title: "Change dependency environment",
				protectedPaths: [],
			}),
			/Candidate modified protected evaluator inputs: package\.json/,
		);

		await writeFile(join(root, "node_modules", ".package-lock.json"), '{"packages":{"drifted":{}}}\n');
		await assert.rejects(
			assertEvaluatorDigest(digest, {
				repoRoot: root,
				controlCwd: root,
				command: "true",
				protectedPaths: [],
			}),
			/Evaluator integrity check failed/,
		);
		await writeFile(join(root, "node_modules", ".package-lock.json"), '{"packages":{}}\n');
		await writeFile(join(root, "node_modules", "fixture", "index.js"), "export default 2;\n");
		await assert.rejects(
			assertEvaluatorDigest(digest, {
				repoRoot: root,
				controlCwd: root,
				command: "true",
				protectedPaths: [],
			}),
			/Evaluator integrity check failed/,
		);
	} finally {
		if (worktree) {
			await removeWorktree(root, worktree);
		}
		await rm(root, { force: true, recursive: true });
	}
});

test("materializes a content-addressed dependency snapshot for every candidate checkout", async () => {
	const { root, baseCommit } = await createRepository();
	let worktree: string | undefined;
	try {
		await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
		await writeFile(join(root, "node_modules", "fixture", "index.js"), "export default 1;\n");
		const dependencyDigest = await prepareDependencySnapshot(root);
		const evaluator = {
			repoRoot: root,
			controlCwd: root,
			command: "true",
			protectedPaths: [] as string[],
		};
		const digest = await evaluatorDigest(evaluator);
		const frozenDependency = join(
			root,
			".iso",
			"dependencies",
			dependencyDigest,
			"node_modules",
			"fixture",
			"index.js",
		);
		assert.equal((await lstat(frozenDependency)).mode & 0o222, 0);

		await writeFile(join(root, "node_modules", "fixture", "index.js"), "export default 999;\n");
		const newerDependencyDigest = await prepareDependencySnapshot(root);
		assert.notEqual(newerDependencyDigest, dependencyDigest);
		await activateDependencySnapshot(root, dependencyDigest);
		await assert.doesNotReject(assertEvaluatorDigest(digest, evaluator));
		const experiment = await createExperimentWorktree({
			repoRoot: root,
			title: "Use frozen dependency",
			experimentId: "experiment_snapshot0001",
			baseCommit,
		});
		worktree = experiment.worktree;
		assert.equal(
			await readFile(join(worktree, "node_modules", "fixture", "index.js"), "utf8"),
			"export default 1;\n",
		);
	} finally {
		if (worktree) {
			await removeWorktree(root, worktree);
		}
		await rm(root, { force: true, recursive: true });
	}
});

test("runs the evaluator from a clean control checkout against frozen dependencies", async () => {
	const { root } = await createRepository();
	let controlWorktree: string | undefined;
	let experimentWorktree: string | undefined;
	try {
		await writeFile(
			join(root, "evaluator.mjs"),
			'import fixture from "fixture";\nconsole.log("ISO_RESULT " + JSON.stringify({score: fixture}));\n',
		);
		await writeFile(join(root, "package.json"), '{"type":"module"}\n');
		await mkdir(join(root, "node_modules", "fixture"), { recursive: true });
		await writeFile(
			join(root, "node_modules", "fixture", "package.json"),
			'{"type":"module","exports":"./index.js"}\n',
		);
		await writeFile(join(root, "node_modules", "fixture", "index.js"), "export default 1;\n");
		await exec("git", ["add", "--", "evaluator.mjs", "package.json"], { cwd: root });
		await exec("git", ["commit", "-q", "-m", "add dependency evaluator"], { cwd: root });
		const baseCommit = await resolveCommit(root);
		await prepareDependencySnapshot(root);
		controlWorktree = await createEvaluatorControlWorktree({
			repoRoot: root,
			worktreeId: "control-dependency-test",
			commit: baseCommit,
		});
		experimentWorktree = await createDetachedWorktree({
			repoRoot: root,
			worktreeId: "experiment-dependency-test",
			commit: baseCommit,
		});
		assert.equal(
			await readFile(join(controlWorktree, "node_modules", "fixture", "index.js"), "utf8"),
			"export default 1;\n",
		);

		await writeFile(join(root, "node_modules", "fixture", "index.js"), "export default 999;\n");
		const evaluation = await runEvaluator("exec node evaluator.mjs", {
			repoRoot: root,
			controlCwd: controlWorktree,
			experimentDir: experimentWorktree,
			warmups: 0,
			samples: 1,
			trialId: "frozen-dependency",
		});
		assert.equal(evaluation.score, 1);
	} finally {
		await Promise.all([
			controlWorktree === undefined ? Promise.resolve() : removeWorktree(root, controlWorktree),
			experimentWorktree === undefined ? Promise.resolve() : removeWorktree(root, experimentWorktree),
		]);
		await rm(root, { force: true, recursive: true });
	}
});

test("rejects repository-local Git execution config and credential-bearing remotes", async (context) => {
	await context.test("executable config", async () => {
		const { root } = await createRepository();
		try {
			await exec("git", ["config", "core.hooksPath", "/tmp/hostile-hooks"], { cwd: root });
			await exec("git", ["config", "filter.hostile.clean", "/tmp/hostile-filter"], { cwd: root });
			await assert.rejects(
				assertCleanRepository(root),
				(error: unknown) =>
					error instanceof Error &&
					error.message.includes("core.hookspath") &&
					error.message.includes("filter.hostile.clean"),
			);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	await context.test("worktree-scoped executable config", async () => {
		const { root } = await createRepository();
		try {
			await exec("git", ["config", "extensions.worktreeConfig", "true"], { cwd: root });
			await exec("git", ["config", "--worktree", "filter.hostile.clean", "/tmp/hostile-filter"], {
				cwd: root,
			});
			await assert.rejects(assertCleanRepository(root), /filter\.hostile\.clean/u);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	await context.test("embedded remote credentials", async () => {
		const { root } = await createRepository();
		try {
			await exec("git", ["remote", "add", "origin", "https://user:password@example.invalid/abiome/iso.git"], {
				cwd: root,
			});
			await assert.rejects(assertCleanRepository(root), /remote URLs with embedded credentials/);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});

	await context.test("replace refs and grafts", async () => {
		const { root, baseCommit } = await createRepository();
		try {
			await writeFile(join(root, "subject.txt"), "replacement\n");
			await exec("git", ["add", "--", "subject.txt"], { cwd: root });
			await exec("git", ["commit", "-q", "-m", "replacement"], { cwd: root });
			const replacement = await resolveCommit(root);
			await exec("git", ["replace", baseCommit, replacement], { cwd: root });
			await assert.rejects(assertCleanRepository(root), /replace refs and grafts/);
		} finally {
			await rm(root, { force: true, recursive: true });
		}
	});
});

test("scrubs ambient Git environment overrides", async () => {
	const { root, baseCommit } = await createRepository();
	const previous = new Map<string, string | undefined>();
	const overrides = {
		GIT_CONFIG_COUNT: "1",
		GIT_CONFIG_KEY_0: "core.hooksPath",
		GIT_CONFIG_VALUE_0: "/tmp/hostile-hooks",
		GIT_NO_REPLACE_OBJECTS: "0",
	};
	for (const [name, value] of Object.entries(overrides)) {
		previous.set(name, process.env[name]);
		process.env[name] = value;
	}
	try {
		assert.equal(await resolveCommit(root), baseCommit);
		await assertCleanRepository(root);
	} finally {
		for (const [name, value] of previous) {
			if (value === undefined) {
				delete process.env[name];
			} else {
				process.env[name] = value;
			}
		}
		await rm(root, { force: true, recursive: true });
	}
});

test("rejects protected evaluator changes and detects trusted harness drift", async () => {
	const { root, baseCommit } = await createRepository();
	let worktree: string | undefined;
	try {
		const digest = await evaluatorDigest({
			repoRoot: root,
			controlCwd: root,
			command: "node evaluator.mjs",
			protectedPaths: ["evaluator.mjs"],
		});
		const experiment = await createExperimentWorktree({
			repoRoot: root,
			title: "Game evaluator",
			experimentId: "experiment_policy00001",
			baseCommit,
		});
		worktree = experiment.worktree;
		await writeFile(join(worktree, "evaluator.mjs"), "export const version = 999;\n");

		await assert.rejects(
			snapshotExperiment({
				repoRoot: root,
				worktree,
				baseCommit,
				title: "Game evaluator",
				protectedPaths: ["evaluator.mjs"],
			}),
			/Candidate modified protected evaluator inputs: evaluator\.mjs/,
		);
		await assert.rejects(
			snapshotExperiment({
				repoRoot: root,
				worktree,
				baseCommit,
				title: "Game canonically protected evaluator",
				protectedPaths: ["bench/../evaluator.mjs"],
			}),
			/Candidate modified protected evaluator inputs: evaluator\.mjs/,
		);
		assert.equal(normalizeRepositoryRelativePath("bench//./evaluator.mjs"), "bench/evaluator.mjs");
		assert.throws(() => normalizeRepositoryRelativePath("."), /must name a path inside the repository/);

		await writeFile(join(root, "evaluator.mjs"), "export const version = 2;\n");
		await assert.rejects(
			assertEvaluatorDigest(digest, {
				repoRoot: root,
				controlCwd: root,
				command: "node evaluator.mjs",
				protectedPaths: ["evaluator.mjs"],
			}),
			/Evaluator integrity check failed/,
		);
		await assert.rejects(
			evaluatorDigest({
				repoRoot: root,
				controlCwd: root,
				command: "true",
				protectedPaths: ["../outside"],
			}),
			/must name a path inside the repository/,
		);
	} finally {
		if (worktree) {
			await removeWorktree(root, worktree);
		}
		await rm(root, { recursive: true });
	}
});

test("attests protected file modes and distinguishes empty directories from missing paths", async () => {
	const { root } = await createRepository();
	try {
		const harness = join(root, "harness");
		const executable = join(harness, "run.sh");
		await mkdir(harness);
		await writeFile(executable, "#!/bin/sh\nexit 0\n");
		await chmod(executable, 0o644);
		const dataModeDigest = await evaluatorDigest({
			repoRoot: root,
			controlCwd: root,
			command: "true",
			protectedPaths: ["harness"],
		});

		await chmod(executable, 0o755);
		const executableModeDigest = await evaluatorDigest({
			repoRoot: root,
			controlCwd: root,
			command: "true",
			protectedPaths: ["harness"],
		});
		assert.notEqual(executableModeDigest, dataModeDigest);

		await rm(executable);
		const emptyDirectoryDigest = await evaluatorDigest({
			repoRoot: root,
			controlCwd: root,
			command: "true",
			protectedPaths: ["harness"],
		});
		await rm(harness, { recursive: true });
		const missingDirectoryDigest = await evaluatorDigest({
			repoRoot: root,
			controlCwd: root,
			command: "true",
			protectedPaths: ["harness"],
		});
		assert.notEqual(emptyDirectoryDigest, missingDirectoryDigest);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("uses repository-relative protected paths and rejects an escaped control directory", async () => {
	const { root } = await createRepository();
	const outside = await mkdtemp(join(tmpdir(), "iso-evaluator-outside-"));
	try {
		const evaluatorDirectory = join(root, "bench");
		await mkdir(evaluatorDirectory);
		await writeFile(join(evaluatorDirectory, "eval.mjs"), "export const version = 1;\n");
		const digest = await evaluatorDigest({
			repoRoot: root,
			controlCwd: evaluatorDirectory,
			command: "node eval.mjs",
			protectedPaths: ["bench/eval.mjs"],
		});
		await writeFile(join(evaluatorDirectory, "eval.mjs"), "export const version = 2;\n");
		await assert.rejects(
			assertEvaluatorDigest(digest, {
				repoRoot: root,
				controlCwd: evaluatorDirectory,
				command: "node eval.mjs",
				protectedPaths: ["bench/eval.mjs"],
			}),
			/Evaluator integrity check failed/,
		);

		await symlink(outside, join(root, "escaped-control"));
		await assert.rejects(
			evaluatorDigest({
				repoRoot: root,
				controlCwd: join(root, "escaped-control"),
				command: "true",
				protectedPaths: [],
			}),
			/control directory resolves outside the repository/,
		);
	} finally {
		await rm(root, { force: true, recursive: true });
		await rm(outside, { force: true, recursive: true });
	}
});
