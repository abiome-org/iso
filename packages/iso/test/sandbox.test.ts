import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { access, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import {
	createSandboxedBashOperations,
	createSandboxedWorkerTools,
	disposeSandboxedWorkerTools,
	type SandboxedBashOperations,
} from "../src/sandbox.ts";

const SENTINEL_NAME = "ISO_SANDBOX_SENTINEL_SECRET";
const SENTINEL_VALUE = "must-not-cross-the-sandbox";

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

function shellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

function assertProcessAbsent(processId: number): void {
	assert.throws(
		() => process.kill(processId, 0),
		(error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH",
		`expected process ${processId} to be absent`,
	);
}

async function closeServer(server: Server): Promise<void> {
	await new Promise<void>((resolveClose, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
			} else {
				resolveClose();
			}
		});
	});
}

test(
	"sandboxed bash permits candidate writes while denying control, secrets, and outbound network",
	{ skip: sandboxSkipReason(), timeout: 20_000 },
	async (context) => {
		const root = await mkdtemp(join(tmpdir(), "iso-sandbox-test-"));
		const control = join(root, "control");
		const candidate = join(root, "candidate");
		await Promise.all([mkdir(control), mkdir(candidate)]);
		const controlSecret = join(control, "control-secret.txt");
		const candidateProtected = join(candidate, "worker.protected");
		const escapedWrite = join(control, "escaped.txt");
		await Promise.all([
			writeFile(controlSecret, "control secret"),
			writeFile(candidateProtected, "candidate protected secret"),
		]);

		const previousSentinel = process.env[SENTINEL_NAME];
		process.env[SENTINEL_NAME] = SENTINEL_VALUE;
		let operations: SandboxedBashOperations | undefined;
		const server = createServer((socket) => {
			socket.end("reachable");
		});
		context.after(async () => {
			if (operations) {
				await operations.dispose();
			}
			if (server.listening) {
				await closeServer(server);
			}
			if (previousSentinel === undefined) {
				delete process.env[SENTINEL_NAME];
			} else {
				process.env[SENTINEL_NAME] = previousSentinel;
			}
			await rm(root, { force: true, recursive: true });
		});

		operations = await createSandboxedBashOperations({
			cwd: candidate,
			repoRoot: control,
			writablePaths: [candidate],
			denyReadPaths: [control, join(candidate, "*.protected")],
			environment: { ISO_SANDBOX_ALLOWED_MARKER: "visible" },
		});
		const futureHostSecret = join(root, "created-after-policy.txt");
		await writeFile(futureHostSecret, "future host secret");

		async function run(command: string): Promise<{ exitCode: number | null; output: string }> {
			let output = "";
			const result = await operations?.exec(command, candidate, {
				onData(data) {
					output += data.toString("utf8");
				},
				timeout: 5,
			});
			assert.ok(result);
			return { exitCode: result.exitCode, output };
		}

		const candidateWrite = await run("printf allowed > candidate.txt");
		assert.equal(candidateWrite.exitCode, 0, candidateWrite.output);
		assert.equal(await readFile(join(candidate, "candidate.txt"), "utf8"), "allowed");

		const controlRead = await run(`cat ${shellArgument(controlSecret)}`);
		assert.notEqual(controlRead.exitCode, 0);
		assert.doesNotMatch(controlRead.output, /^control secret$/mu);

		const futureHostRead = await run(`cat ${shellArgument(futureHostSecret)}`);
		assert.notEqual(futureHostRead.exitCode, 0);
		assert.doesNotMatch(futureHostRead.output, /future host secret/u);

		const protectedCandidateRead = await run(`cat ${shellArgument(candidateProtected)}`);
		assert.notEqual(protectedCandidateRead.exitCode, 0);
		assert.doesNotMatch(protectedCandidateRead.output, /candidate protected secret/u);

		const controlWrite = await run(`printf escaped > ${shellArgument(escapedWrite)}`);
		assert.notEqual(controlWrite.exitCode, 0);
		await assert.rejects(access(escapedWrite));

		const environment = await run("sh -c 'printf \"child-process\\n\"; env'");
		assert.equal(environment.exitCode, 0);
		assert.match(environment.output, /^child-process$/mu);
		assert.match(environment.output, /^ISO_SANDBOX_ALLOWED_MARKER=visible$/mu);
		assert.doesNotMatch(environment.output, new RegExp(`^${SENTINEL_NAME}=`, "mu"));
		assert.doesNotMatch(environment.output, new RegExp(SENTINEL_VALUE, "u"));

		await new Promise<void>((resolveListen, reject) => {
			server.once("error", reject);
			server.listen(0, "127.0.0.1", resolveListen);
		});
		const address = server.address();
		assert.ok(address && typeof address === "object");
		const networkProbe = [
			'const net = require("node:net");',
			`const socket = net.connect(${address.port}, "127.0.0.1");`,
			'socket.once("connect", () => process.exit(0));',
			'socket.once("error", () => process.exit(17));',
			"socket.setTimeout(1000, () => process.exit(18));",
		].join("");
		const outbound = await run(`${shellArgument(process.execPath)} -e ${shellArgument(networkProbe)}`);
		assert.ok(outbound.exitCode === 17 || outbound.exitCode === 18, outbound.output);
	},
);

test(
	"sandbox reaps background descendants after normal completion, abort, timeout, and dispose",
	{ skip: sandboxSkipReason(), timeout: 20_000 },
	async (context) => {
		const root = await mkdtemp(join(tmpdir(), "iso-sandbox-lifecycle-"));
		const control = join(root, "control");
		const candidate = join(root, "candidate");
		await Promise.all([mkdir(control), mkdir(candidate)]);
		const operations = await createSandboxedBashOperations({
			cwd: candidate,
			repoRoot: control,
			writablePaths: [candidate],
		});
		context.after(async () => {
			await operations.dispose();
			await rm(root, { force: true, recursive: true });
		});

		let normalOutput = "";
		const normal = await operations.exec("sleep 60 >/dev/null 2>&1 & echo $!", candidate, {
			onData(data) {
				normalOutput += data.toString("utf8");
			},
			timeout: 5,
		});
		assert.equal(normal.exitCode, 0, normalOutput);
		const normalProcessId = Number.parseInt(normalOutput.trim(), 10);
		assert.ok(Number.isSafeInteger(normalProcessId) && normalProcessId > 0, normalOutput);
		assertProcessAbsent(normalProcessId);

		let largeOutput = "";
		const outputProbe = [
			'process.stdout.write("x".repeat(1024 * 1024));',
			'process.stdout.write("\\nISO_RESULT:{\\"score\\":1}\\n");',
		].join("");
		const largeOutputResult = await operations.exec(
			`${shellArgument(process.execPath)} -e ${shellArgument(outputProbe)}`,
			candidate,
			{
				onData(data) {
					largeOutput += data.toString("utf8");
				},
				timeout: 5,
			},
		);
		assert.equal(largeOutputResult.exitCode, 0);
		assert.equal(largeOutput.length, 1_048_600);
		assert.ok(largeOutput.endsWith('\nISO_RESULT:{"score":1}\n'));

		const runUntilInterrupted = (
			signal?: AbortSignal,
			timeout?: number,
		): {
			execution: Promise<{ exitCode: number | null }>;
			processId: Promise<number>;
		} => {
			let output = "";
			let resolveProcessId: ((processId: number) => void) | undefined;
			const processId = new Promise<number>((resolveId) => {
				resolveProcessId = resolveId;
			});
			const execution = operations.exec("sleep 60 >/dev/null 2>&1 & echo $!; wait", candidate, {
				onData(data) {
					output += data.toString("utf8");
					const parsed = Number.parseInt(output.trim(), 10);
					if (Number.isSafeInteger(parsed) && parsed > 0) {
						resolveProcessId?.(parsed);
						resolveProcessId = undefined;
					}
				},
				signal,
				timeout,
			});
			return { execution, processId };
		};

		const timed = runUntilInterrupted(undefined, 0.25);
		const timedProcessId = await timed.processId;
		await assert.rejects(timed.execution, /timeout:0\.25/u);
		assertProcessAbsent(timedProcessId);

		const abortController = new AbortController();
		const aborted = runUntilInterrupted(abortController.signal);
		const abortedProcessId = await aborted.processId;
		abortController.abort();
		await assert.rejects(aborted.execution, /aborted/u);
		assertProcessAbsent(abortedProcessId);

		const disposed = runUntilInterrupted();
		const disposedProcessId = await disposed.processId;
		await operations.dispose();
		await assert.rejects(disposed.execution, /aborted/u);
		assertProcessAbsent(disposedProcessId);
	},
);

test(
	"a detached macOS child cannot write a quarantine created after its policy",
	{
		skip:
			process.platform === "darwin"
				? sandboxSkipReason()
				: "Detached-session quarantine regression is specific to macOS Seatbelt",
		timeout: 15_000,
	},
	async () => {
		const root = await mkdtemp(join(tmpdir(), "iso-sandbox-quarantine-"));
		const control = join(root, "control");
		const candidate = join(root, "candidate");
		const targetFile = join(candidate, "capture-target.txt");
		const processIdFile = join(candidate, "detached.pid");
		await Promise.all([mkdir(control), mkdir(candidate)]);
		let processId: number | undefined;
		let operations: SandboxedBashOperations | undefined;
		try {
			operations = await createSandboxedBashOperations({
				cwd: candidate,
				repoRoot: control,
				writablePaths: [candidate],
			});
			const daemonSource = [
				'const fs=require("node:fs"),path=require("node:path");',
				`const targetFile=${JSON.stringify(targetFile)};`,
				"const deadline=Date.now()+8000;",
				"const timer=setInterval(()=>{",
				'try{const target=fs.readFileSync(targetFile,"utf8").trim();',
				'if(target)fs.writeFileSync(path.join(target,"forged-by-detached-child"),"forged");}catch{}',
				"if(Date.now()>=deadline){clearInterval(timer);process.exit(0);}",
				"},5);",
			].join("");
			const spawnerSource = [
				'const fs=require("node:fs"),{spawn}=require("node:child_process");',
				`const child=spawn(process.execPath,["-e",${JSON.stringify(daemonSource)}],`,
				'{detached:true,stdio:"ignore"});',
				`fs.writeFileSync(${JSON.stringify(processIdFile)},String(child.pid));`,
				"child.unref();",
			].join("");
			const result = await operations.exec(
				`exec ${shellArgument(process.execPath)} -e ${shellArgument(spawnerSource)}`,
				candidate,
				{ onData() {}, timeout: 5 },
			);
			assert.equal(result.exitCode, 0);
			processId = Number.parseInt(await readFile(processIdFile, "utf8"), 10);
			assert.ok(Number.isSafeInteger(processId) && processId > 0);
			await operations.dispose();
			operations = undefined;

			const quarantine = await mkdtemp(join(root, "capture-"));
			await writeFile(targetFile, quarantine);
			await delay(500);
			await assert.rejects(access(join(quarantine, "forged-by-detached-child")));
		} finally {
			if (operations) {
				await operations.dispose().catch(() => undefined);
			}
			if (processId !== undefined) {
				try {
					process.kill(processId, "SIGKILL");
				} catch {
					// The detached probe either exited on its own or is already unavailable.
				}
			}
			await rm(root, { force: true, recursive: true });
		}
	},
);

test(
	"worker direct file tools reject parent and symbolic-link escapes",
	{ skip: sandboxSkipReason(), timeout: 10_000 },
	async (context) => {
		const root = await mkdtemp(join(tmpdir(), "iso-sandbox-tools-"));
		const control = join(root, "control");
		const worker = join(root, "worker");
		const external = join(root, "external");
		const dependencyDigest = "a".repeat(64);
		const otherDependencyDigest = "b".repeat(64);
		const dependencyStore = join(control, ".iso", "dependencies");
		const dependencySnapshot = join(dependencyStore, dependencyDigest, "node_modules");
		const controlDependency = join(dependencySnapshot, "third-party");
		const otherDependencySnapshot = join(dependencyStore, otherDependencyDigest, "node_modules");
		const otherDependencySecret = join(otherDependencySnapshot, "other-secret.txt");
		const legacyDependencySecret = join(control, "node_modules", "legacy-secret.txt");
		await Promise.all([mkdir(control), mkdir(worker)]);
		const outside = join(control, "outside.txt");
		await Promise.all([
			mkdir(join(control, ".git")),
			mkdir(controlDependency, { recursive: true }),
			mkdir(otherDependencySnapshot, { recursive: true }),
			mkdir(join(control, "node_modules"), { recursive: true }),
			mkdir(join(worker, ".git")),
			mkdir(join(worker, "node_modules")),
			mkdir(external),
		]);
		await writeFile(outside, "outside");
		await writeFile(join(external, "secret.txt"), "external secret");
		await writeFile(join(control, ".git", "config"), "control git config");
		await writeFile(join(worker, ".git", "config"), "worker git config");
		await writeFile(join(controlDependency, "dependency.txt"), "dependency data");
		await writeFile(join(controlDependency, "dependency.js"), 'process.stdout.write("dependency executed");\n');
		await writeFile(join(dependencyStore, "active"), `${dependencyDigest}\n`);
		await writeFile(otherDependencySecret, "other snapshot secret");
		await writeFile(legacyDependencySecret, "legacy dependency secret");
		await Promise.all([
			symlink(outside, join(worker, "link.txt")),
			symlink(dependencySnapshot, join(worker, "node_modules", ".iso-readonly-view")),
			symlink(controlDependency, join(worker, "node_modules", "third-party")),
			symlink(control, join(worker, "node_modules", "control-source")),
			symlink(external, join(worker, "node_modules", "external-link")),
		]);
		const tools = await createSandboxedWorkerTools({
			cwd: worker,
			repoRoot: control,
			protectedPaths: [],
		});
		const lateTopLevelFile = join(control, "late-top-level-secret.txt");
		const lateTopLevelDirectory = join(control, "late-top-level-directory");
		const lateDirectorySecret = join(lateTopLevelDirectory, "secret.txt");
		const lateIsoSecret = join(control, ".iso", "late-control-secret.txt");
		const lateRepositoryLink = join(worker, "node_modules", "late-live-repository-link");
		await mkdir(lateTopLevelDirectory);
		await Promise.all([
			writeFile(lateTopLevelFile, "late top-level secret"),
			writeFile(lateDirectorySecret, "late directory secret"),
			writeFile(lateIsoSecret, "late iso secret"),
			symlink(lateTopLevelDirectory, lateRepositoryLink),
		]);
		context.after(async () => {
			await disposeSandboxedWorkerTools(tools);
			await rm(root, { force: true, recursive: true });
		});

		await assert.rejects(
			tools[0].execute("read-parent", { path: "../control/outside.txt" }, undefined, undefined, undefined as never),
			/cannot access paths outside the worker checkout/,
		);
		await assert.rejects(
			tools[0].execute("read-link", { path: "link.txt" }, undefined, undefined, undefined as never),
			/cannot traverse symbolic links/,
		);
		await assert.rejects(
			tools[0].execute("read-git", { path: ".git/config" }, undefined, undefined, undefined as never),
			/cannot read a protected path/,
		);
		await assert.rejects(
			tools[1].execute(
				"read-git-with-shell",
				{ command: "cat .git/config" },
				undefined,
				undefined,
				undefined as never,
			),
			/Operation not permitted|not permitted/u,
		);
		const dependencyRead = await tools[0].execute(
			"read-dependency",
			{ path: "node_modules/third-party/dependency.txt" },
			undefined,
			undefined,
			undefined as never,
		);
		assert.match(
			dependencyRead.content[0]?.type === "text" ? dependencyRead.content[0].text : "",
			/dependency data/u,
		);
		const dependencyExecution = await tools[1].execute(
			"execute-dependency",
			{ command: `${shellArgument(process.execPath)} node_modules/third-party/dependency.js` },
			undefined,
			undefined,
			undefined as never,
		);
		assert.match(
			dependencyExecution.content[0]?.type === "text" ? dependencyExecution.content[0].text : "",
			/dependency executed/u,
		);
		await assert.rejects(
			tools[1].execute(
				"read-active-dependency-pointer",
				{ command: `cat ${shellArgument(join(dependencyStore, "active"))}` },
				undefined,
				undefined,
				undefined as never,
			),
			/Operation not permitted|not permitted/u,
		);
		await assert.rejects(
			tools[1].execute(
				"read-other-dependency-snapshot",
				{ command: `cat ${shellArgument(otherDependencySecret)}` },
				undefined,
				undefined,
				undefined as never,
			),
			/Operation not permitted|not permitted/u,
		);
		await assert.rejects(
			tools[1].execute(
				"read-legacy-live-dependency",
				{ command: `cat ${shellArgument(legacyDependencySecret)}` },
				undefined,
				undefined,
				undefined as never,
			),
			/Operation not permitted|not permitted/u,
		);
		for (const [name, path] of [
			["late-live-top-level-file", lateTopLevelFile],
			["late-live-top-level-directory", lateDirectorySecret],
			["late-live-iso-file", lateIsoSecret],
		] as const) {
			await assert.rejects(
				tools[1].execute(
					`bash-${name}`,
					{ command: `cat ${shellArgument(path)}` },
					undefined,
					undefined,
					undefined as never,
				),
				/Operation not permitted|not permitted/u,
			);
			await assert.rejects(
				tools[0].execute(`direct-${name}`, { path }, undefined, undefined, undefined as never),
				/cannot access paths outside the worker checkout/u,
			);
		}
		await assert.rejects(
			tools[1].execute(
				"bash-late-live-repository-link",
				{ command: "cat node_modules/late-live-repository-link/secret.txt" },
				undefined,
				undefined,
				undefined as never,
			),
			/Operation not permitted|not permitted/u,
		);
		await assert.rejects(
			tools[0].execute(
				"direct-late-live-repository-link",
				{ path: "node_modules/late-live-repository-link/secret.txt" },
				undefined,
				undefined,
				undefined as never,
			),
			/outside approved read roots/u,
		);
		await assert.rejects(
			tools[1].execute(
				"write-dependency-with-shell",
				{ command: "printf changed > node_modules/third-party/dependency.txt" },
				undefined,
				undefined,
				undefined as never,
			),
			/Operation not permitted|not permitted/u,
		);
		await assert.rejects(
			tools[3].execute(
				"write-dependency-directly",
				{ path: "node_modules/third-party/dependency.txt", content: "changed" },
				undefined,
				undefined,
				undefined as never,
			),
			/cannot modify worker control paths/,
		);
		await assert.rejects(
			tools[0].execute(
				"read-control-source-link",
				{ path: "node_modules/control-source/outside.txt" },
				undefined,
				undefined,
				undefined as never,
			),
			/outside approved read roots/,
		);
		await assert.rejects(
			tools[0].execute(
				"read-external-link",
				{ path: "node_modules/external-link/secret.txt" },
				undefined,
				undefined,
				undefined as never,
			),
			/outside approved read roots/,
		);
		assert.equal(await readFile(join(controlDependency, "dependency.txt"), "utf8"), "dependency data");
		await assert.rejects(
			tools[3].execute(
				"write-parent",
				{ path: "../escaped.txt", content: "escaped" },
				undefined,
				undefined,
				undefined as never,
			),
			/cannot access paths outside the worker checkout/,
		);
	},
);

test(
	"worker sandbox fails closed on untrusted dependency views and Python virtual environments",
	{ skip: sandboxSkipReason(), timeout: 10_000 },
	async (context) => {
		const root = await mkdtemp(join(tmpdir(), "iso-sandbox-dependency-policy-"));
		const control = join(root, "control");
		const worker = join(root, "worker");
		await Promise.all([mkdir(control), mkdir(worker)]);
		await mkdir(join(worker, "node_modules"));
		context.after(async () => {
			await rm(root, { force: true, recursive: true });
		});

		await assert.rejects(
			createSandboxedWorkerTools({ cwd: worker, repoRoot: control, protectedPaths: [] }),
			/missing its trusted dependency snapshot marker/u,
		);
		await rm(join(worker, "node_modules"), { recursive: true });
		await mkdir(join(control, ".venv"));
		await assert.rejects(
			createSandboxedWorkerTools({ cwd: worker, repoRoot: control, protectedPaths: [] }),
			/Node-only.*cannot admit Python virtual environments/u,
		);
	},
);

test(
	"macOS sandbox externalizes large privacy policies instead of exceeding argv limits",
	{
		skip: process.platform === "darwin" ? sandboxSkipReason() : "macOS-specific sandbox argv regression",
		timeout: 30_000,
	},
	async (context) => {
		const root = await mkdtemp(join(tmpdir(), "iso-sandbox-large-policy-"));
		const control = join(root, "control");
		const candidate = join(root, "candidate");
		const privacy = join(root, "privacy");
		await Promise.all([mkdir(control), mkdir(candidate), mkdir(privacy)]);
		const largePrivacyPolicy = Array.from({ length: 200 }, (_, index) =>
			join(privacy, `private-${index.toString().padStart(4, "0")}`),
		);
		const operations = await createSandboxedBashOperations({
			cwd: candidate,
			repoRoot: control,
			writablePaths: [candidate],
			denyReadPaths: largePrivacyPolicy,
		});
		context.after(async () => {
			await operations.dispose();
			await rm(root, { force: true, recursive: true });
		});

		const commandPadding = `# ${"externalized-command-padding ".repeat(40_000)}\n`;
		let output = "";
		const result = await operations.exec(`${commandPadding}printf 'large policy passed' > result.txt`, candidate, {
			onData(data) {
				output += data.toString("utf8");
			},
			timeout: 20,
		});
		assert.equal(result.exitCode, 0, output);
		assert.equal(await readFile(join(candidate, "result.txt"), "utf8"), "large policy passed");
		assert.deepEqual((await readdir(operations.privateDirectory)).sort(), ["home", "tmp"]);
	},
);
