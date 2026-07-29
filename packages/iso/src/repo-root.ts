import { spawn } from "node:child_process";

export function findRepoRoot(cwd: string): Promise<string> {
	return new Promise((resolve, reject) => {
		const environment = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_"),
			),
		);
		const child = spawn(
			"git",
			[
				"--no-replace-objects",
				"-c",
				"core.hooksPath=/dev/null",
				"-c",
				"core.fsmonitor=false",
				"rev-parse",
				"--show-toplevel",
			],
			{
				cwd,
				env: {
					...environment,
					GIT_CONFIG_GLOBAL: "/dev/null",
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_NO_LAZY_FETCH: "1",
					GIT_NO_REPLACE_OBJECTS: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		let outputBytes = 0;
		let terminalError: Error | undefined;
		const collect = (destination: Buffer[], chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > 64 * 1024) {
				terminalError ??= new Error("Git repository discovery exceeded ISO's output limit.");
				child.kill("SIGKILL");
				return;
			}
			destination.push(chunk);
		};
		child.stdout.on("data", (chunk: Buffer) => collect(stdout, chunk));
		child.stderr.on("data", (chunk: Buffer) => collect(stderr, chunk));
		child.once("error", (error) => {
			terminalError ??= error;
		});
		const timeout = setTimeout(() => {
			terminalError ??= new Error("Git repository discovery timed out.");
			child.kill("SIGKILL");
		}, 5_000);
		timeout.unref();
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (terminalError !== undefined) {
				reject(terminalError);
				return;
			}
			const root = Buffer.concat(stdout).toString("utf8").trim();
			if (code !== 0 || root === "") {
				reject(
					new Error(
						`ISO must run inside a Git repository${stderr.length === 0 ? "." : `: ${Buffer.concat(stderr).toString("utf8").trim()}`}`,
					),
				);
				return;
			}
			resolve(root);
		});
	});
}
