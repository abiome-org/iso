import { spawn } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";

interface CommandResult {
	stdout: string;
	stderr: string;
}

function run(command: string, args: string[], cwd: string): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`));
		});
	});
}

export async function findRepoRoot(cwd: string): Promise<string> {
	const result = await run("git", ["rev-parse", "--show-toplevel"], cwd);
	return result.stdout.trim();
}

function slug(value: string): string {
	return (
		value
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-|-$/g, "")
			.slice(0, 36) || "idea"
	);
}

export async function createExperimentWorktree(options: {
	repoRoot: string;
	campaignId: string;
	ideaId: string;
	title: string;
	experimentId: string;
	baseRef?: string;
}): Promise<{ branch: string; worktree: string; baseCommit: string }> {
	const worktreeRoot = join(options.repoRoot, ".iso", "worktrees");
	await mkdir(worktreeRoot, { recursive: true });
	const suffix = options.experimentId.replace("experiment_", "").slice(0, 8);
	const branch = `iso/${slug(options.title)}-${suffix}`;
	const worktree = join(worktreeRoot, options.experimentId);
	const baseRef = options.baseRef ?? "HEAD";
	const baseCommit = (await run("git", ["rev-parse", baseRef], options.repoRoot)).stdout.trim();
	await run("git", ["worktree", "add", "-b", branch, worktree, baseCommit], options.repoRoot);
	return { branch, worktree, baseCommit };
}

export async function snapshotExperiment(
	worktree: string,
	title: string,
): Promise<{
	commit?: string;
	diffStat: string;
}> {
	const changed = await run(
		"git",
		["ls-files", "--modified", "--deleted", "--others", "--exclude-standard", "-z"],
		worktree,
	);
	const paths = changed.stdout.split("\0").filter(Boolean);
	if (paths.length === 0) {
		return { diffStat: "No code changes" };
	}
	await run("git", ["add", "--", ...paths], worktree);
	const diffStat = (await run("git", ["diff", "--cached", "--stat"], worktree)).stdout.trim();
	await run("git", ["commit", "-m", `experiment: ${title}`], worktree);
	const commit = (await run("git", ["rev-parse", "HEAD"], worktree)).stdout.trim();
	return { commit, diffStat };
}

export async function currentBranch(repoRoot: string): Promise<string> {
	const result = await run("git", ["branch", "--show-current"], repoRoot);
	return result.stdout.trim() || basename(repoRoot);
}
