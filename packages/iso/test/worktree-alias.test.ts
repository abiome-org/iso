import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
	createEvaluatorControlWorktree,
	createGenerationWorktree,
	removeIsoWorktrees,
	removeWorktree,
	resolveCommit,
} from "../src/git.ts";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
	return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout;
}

async function registeredWorktrees(root: string): Promise<string[]> {
	return (await git(root, ["worktree", "list", "--porcelain"]))
		.split(/\r?\n/u)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
}

test("worktree removal canonicalizes filesystem aliases and missing leaf paths", async () => {
	const parent = await mkdtemp(join(tmpdir(), "iso-worktree-alias-"));
	const repo = join(parent, "repo");
	const actualTemporaryRoot = join(parent, "actual-tmp");
	const aliasedTemporaryRoot = join(parent, "alias-tmp");
	await Promise.all([mkdir(repo), mkdir(actualTemporaryRoot)]);
	await symlink(actualTemporaryRoot, aliasedTemporaryRoot, "dir");
	await git(repo, ["init", "-q"]);
	await git(repo, ["config", "user.name", "ISO Alias Test"]);
	await git(repo, ["config", "user.email", "iso-alias@example.invalid"]);
	await writeFile(join(repo, "subject.txt"), "baseline\n");
	await git(repo, ["add", "--", "subject.txt"]);
	await git(repo, ["commit", "-q", "-m", "baseline"]);
	const baseCommit = await resolveCommit(repo);
	const previousTmpdir = process.env.TMPDIR;
	process.env.TMPDIR = aliasedTemporaryRoot;
	try {
		const specific = await createGenerationWorktree({
			repoRoot: repo,
			generationId: "generation_alias_specific",
			baseCommit,
		});
		const canonicalSpecific = await realpath(specific);
		assert.notEqual(resolve(specific), canonicalSpecific);
		assert.ok((await registeredWorktrees(repo)).includes(canonicalSpecific));
		await removeWorktree(repo, specific);
		assert.equal((await registeredWorktrees(repo)).includes(canonicalSpecific), false);

		const generation = await createGenerationWorktree({
			repoRoot: repo,
			generationId: "generation_alias_bulk",
			baseCommit,
		});
		const evaluator = await createEvaluatorControlWorktree({
			repoRoot: repo,
			worktreeId: "evaluator_alias_bulk",
			commit: baseCommit,
		});
		const canonicalGeneration = await realpath(generation);
		const canonicalEvaluator = await realpath(evaluator);
		assert.ok((await registeredWorktrees(repo)).includes(canonicalGeneration));
		assert.ok((await registeredWorktrees(repo)).includes(canonicalEvaluator));

		assert.equal(await removeIsoWorktrees(repo), 2);
		const after = await registeredWorktrees(repo);
		assert.equal(after.includes(canonicalGeneration), false);
		assert.equal(after.includes(canonicalEvaluator), false);
		assert.equal(await removeIsoWorktrees(repo), 0);
	} finally {
		await removeIsoWorktrees(repo).catch(() => undefined);
		if (previousTmpdir === undefined) {
			delete process.env.TMPDIR;
		} else {
			process.env.TMPDIR = previousTmpdir;
		}
		await rm(parent, { force: true, recursive: true });
	}
});
