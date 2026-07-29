import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { resolveCommit, snapshotCurrentWorktree } from "../src/git.ts";

const exec = promisify(execFile);

async function git(root: string, args: string[]): Promise<string> {
	return (await exec("git", args, { cwd: root, encoding: "utf8" })).stdout;
}

async function createSourceRepository(): Promise<{ baseCommit: string; root: string }> {
	const root = await mkdtemp(join(tmpdir(), "iso-source-snapshot-"));
	await git(root, ["init", "-q"]);
	await git(root, ["config", "user.name", "ISO Source Test"]);
	await git(root, ["config", "user.email", "iso-source@example.invalid"]);
	await Promise.all([
		writeFile(join(root, ".gitignore"), ".iso/\nnode_modules/\n*.ignored\n"),
		writeFile(join(root, "delete.txt"), "delete baseline\n"),
		writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{}}\n'),
		writeFile(join(root, "package.json"), '{"name":"source-fixture","version":"1.0.0"}\n'),
		writeFile(join(root, "staged.txt"), "staged baseline\n"),
		writeFile(join(root, "unstaged.txt"), "unstaged baseline\n"),
	]);
	await Promise.all([
		mkdir(join(root, ".iso"), { recursive: true }),
		mkdir(join(root, "node_modules", "fixture"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(join(root, ".iso", "tracked-control.txt"), "control baseline\n"),
		writeFile(join(root, "node_modules", "fixture", "tracked-dependency.js"), "dependency baseline\n"),
	]);
	await git(root, [
		"add",
		"--",
		".gitignore",
		"delete.txt",
		"package-lock.json",
		"package.json",
		"staged.txt",
		"unstaged.txt",
	]);
	await git(root, ["add", "-f", "--", ".iso/tracked-control.txt", "node_modules/fixture/tracked-dependency.js"]);
	await git(root, ["commit", "-q", "-m", "source baseline"]);
	return { root, baseCommit: await resolveCommit(root) };
}

test("freezes exact staged, unstaged and untracked worktree bytes without touching branch, index or checkout", async () => {
	const { root, baseCommit } = await createSourceRepository();
	try {
		await writeFile(join(root, "staged.txt"), "index-only version\n");
		await git(root, ["add", "--", "staged.txt"]);
		await writeFile(join(root, "staged.txt"), "actual worktree version\n");
		await writeFile(join(root, "unstaged.txt"), "unstaged worktree version\n");
		await rm(join(root, "delete.txt"));
		await writeFile(join(root, "untracked.txt"), "nonignored untracked\n");
		await writeFile(join(root, "executable.sh"), "#!/bin/sh\nexit 0\n");
		await chmod(join(root, "executable.sh"), 0o755);
		await symlink("untracked.txt", join(root, "source-link"));
		await writeFile(join(root, "package.json"), '{"name":"source-fixture","version":"2.0.0"}\n');
		await git(root, ["add", "--", "package.json"]);
		await writeFile(join(root, "package-lock.json"), '{"lockfileVersion":3,"packages":{"":{"version":"2.0.0"}}}\n');
		await Promise.all([
			writeFile(join(root, ".iso", "live-control.txt"), "must stay outside snapshot\n"),
			writeFile(join(root, "node_modules", "fixture", "live.js"), "must stay outside snapshot\n"),
			writeFile(join(root, "scratch.ignored"), "ignored\n"),
		]);

		const statusBefore = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
		const branchBefore = (await git(root, ["symbolic-ref", "HEAD"])).trim();
		const indexBefore = await readFile(join(root, ".git", "index"));
		const snapshot = await snapshotCurrentWorktree({ repoRoot: root });
		const indexAfter = await readFile(join(root, ".git", "index"));
		const branchAfter = (await git(root, ["symbolic-ref", "HEAD"])).trim();
		const statusAfter = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);

		assert.equal(await resolveCommit(root), baseCommit);
		assert.equal(branchAfter, branchBefore);
		assert.deepEqual(indexAfter, indexBefore);
		assert.equal(statusAfter, statusBefore);
		assert.equal((await git(root, ["rev-parse", `${snapshot.ref}^{commit}`])).trim(), snapshot.commit);
		assert.equal((await git(root, ["rev-parse", `${snapshot.commit}^{tree}`])).trim(), snapshot.tree);
		assert.deepEqual((await git(root, ["rev-list", "--parents", "-n", "1", snapshot.commit])).trim().split(" "), [
			snapshot.commit,
			baseCommit,
		]);

		assert.equal(await git(root, ["show", `${snapshot.commit}:staged.txt`]), "actual worktree version\n");
		assert.equal(await git(root, ["show", `${snapshot.commit}:unstaged.txt`]), "unstaged worktree version\n");
		assert.equal(await git(root, ["show", `${snapshot.commit}:untracked.txt`]), "nonignored untracked\n");
		assert.equal(
			await git(root, ["show", `${snapshot.commit}:package.json`]),
			'{"name":"source-fixture","version":"2.0.0"}\n',
		);
		assert.equal(
			await git(root, ["show", `${snapshot.commit}:package-lock.json`]),
			'{"lockfileVersion":3,"packages":{"":{"version":"2.0.0"}}}\n',
		);
		assert.equal(await git(root, ["cat-file", "blob", `${snapshot.commit}:source-link`]), "untracked.txt");
		assert.match(await git(root, ["ls-tree", snapshot.commit, "--", "source-link"]), /^120000 blob/u);
		assert.match(await git(root, ["ls-tree", snapshot.commit, "--", "executable.sh"]), /^100755 blob/u);
		await assert.rejects(git(root, ["cat-file", "-e", `${snapshot.commit}:delete.txt`]));
		await assert.rejects(git(root, ["cat-file", "-e", `${snapshot.commit}:.iso/tracked-control.txt`]));
		await assert.rejects(
			git(root, ["cat-file", "-e", `${snapshot.commit}:node_modules/fixture/tracked-dependency.js`]),
		);
		await assert.rejects(git(root, ["cat-file", "-e", `${snapshot.commit}:scratch.ignored`]));

		assert.deepEqual(snapshot.changedPaths, [
			"delete.txt",
			"executable.sh",
			"package-lock.json",
			"package.json",
			"source-link",
			"staged.txt",
			"unstaged.txt",
			"untracked.txt",
		]);
		assert.deepEqual(snapshot.excludedPaths, [
			".iso/tracked-control.txt",
			"node_modules/fixture/tracked-dependency.js",
		]);
		assert.ok(snapshot.totalBytes > 0);

		assert.equal(await readFile(join(root, "staged.txt"), "utf8"), "actual worktree version\n");
		assert.equal(await readlink(join(root, "source-link")), "untracked.txt");
		assert.equal(await readFile(join(root, ".iso", "live-control.txt"), "utf8"), "must stay outside snapshot\n");
		assert.equal(
			await readFile(join(root, "node_modules", "fixture", "live.js"), "utf8"),
			"must stay outside snapshot\n",
		);
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("fails byte policy before publishing a source ref and still leaves the caller index untouched", async () => {
	const { root } = await createSourceRepository();
	try {
		await writeFile(join(root, "too-large.txt"), "bounded-source-content-".repeat(100));
		const branchBefore = (await git(root, ["symbolic-ref", "HEAD"])).trim();
		const indexBefore = await readFile(join(root, ".git", "index"));
		await assert.rejects(
			snapshotCurrentWorktree({
				repoRoot: root,
				maxSourceBytes: 1024,
				maxSourceFileBytes: 512,
			}),
			/candidate byte limit exceeded/u,
		);
		assert.equal((await git(root, ["symbolic-ref", "HEAD"])).trim(), branchBefore);
		assert.deepEqual(await readFile(join(root, ".git", "index")), indexBefore);
		assert.equal(await git(root, ["for-each-ref", "--format=%(refname)", "refs/iso/source-snapshots/"]), "");
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});

test("supports ephemeral source validation without publishing a private ref", async () => {
	const { root } = await createSourceRepository();
	try {
		await writeFile(join(root, "unstaged.txt"), "ephemeral validation bytes\n");
		const snapshot = await snapshotCurrentWorktree({ repoRoot: root, publishRef: false });
		assert.equal(snapshot.ref, undefined);
		assert.equal(await git(root, ["for-each-ref", "--format=%(refname)", "refs/iso/source-snapshots/"]), "");
		assert.equal(await git(root, ["show", `${snapshot.commit}:unstaged.txt`]), "ephemeral validation bytes\n");
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
