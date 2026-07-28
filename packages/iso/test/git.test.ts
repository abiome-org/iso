import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createExperimentWorktree, snapshotExperiment } from "../src/git.ts";

const exec = promisify(execFile);

test("creates and commits an isolated experiment branch", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-git-"));
	try {
		await exec("git", ["init", "-q"], { cwd: root });
		await exec("git", ["config", "user.name", "ISO Test"], { cwd: root });
		await exec("git", ["config", "user.email", "iso@example.invalid"], { cwd: root });
		await writeFile(join(root, "subject.txt"), "baseline\n");
		await exec("git", ["add", "--", "subject.txt"], { cwd: root });
		await exec("git", ["commit", "-q", "-m", "baseline"], { cwd: root });

		const worktree = await createExperimentWorktree({
			repoRoot: root,
			campaignId: "campaign_test",
			ideaId: "idea_test",
			title: "Try a branch",
			experimentId: "experiment_1234567890ab",
		});
		await writeFile(join(worktree.worktree, "subject.txt"), "experiment\n");
		const snapshot = await snapshotExperiment(worktree.worktree, "Try a branch");

		assert.ok(snapshot.commit);
		assert.match(snapshot.diffStat, /subject\.txt/);
		assert.equal(await readFile(join(root, "subject.txt"), "utf8"), "baseline\n");
		assert.equal(await readFile(join(worktree.worktree, "subject.txt"), "utf8"), "experiment\n");
	} finally {
		await rm(root, { recursive: true });
	}
});
