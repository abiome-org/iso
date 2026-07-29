import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { kernelSocketPath } from "../src/client.ts";
import { PRINCIPAL_TOOLS, principalSessionId, restrictedPrincipalArgs } from "../src/principal-policy.ts";

const exec = promisify(execFile);
const cliPath = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const PROTOCOL = "iso.kernel.v1";

interface CommandFailure extends Error {
	code?: number | string;
	stderr?: string;
}

function rejectsCapabilityFlag(error: unknown, flag: string): boolean {
	if (!(error instanceof Error)) {
		return false;
	}
	const failure = error as CommandFailure;
	return (
		failure.code === 1 &&
		typeof failure.stderr === "string" &&
		failure.stderr.includes(`iso: ${flag} is unavailable in ISO's capability-restricted principal session.`)
	);
}

function readBody(request: IncomingMessage): Promise<string> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
		});
		request.on("end", () => resolve(body));
		request.on("error", reject);
	});
}

function listen(server: Server, socketPath: string): Promise<void> {
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(socketPath, () => {
			server.removeListener("error", reject);
			resolve();
		});
	});
}

async function closeServer(server: Server): Promise<void> {
	server.closeAllConnections();
	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}
			resolve();
		});
	});
}

function sendSuccess(response: ServerResponse, id: string, result: unknown): void {
	response.writeHead(200, { "content-type": "application/json" });
	response.end(JSON.stringify({ protocol: PROTOCOL, id, ok: true, result }));
}

test("principal CLI flags cannot re-enable shell, write, or general extensions", async (context) => {
	const root = await mkdtemp(join(tmpdir(), "iso-cli-capabilities-"));
	context.after(async () => {
		await rm(root, { force: true, recursive: true });
	});
	await exec("git", ["init", "-q"], { cwd: root });

	const attempts = [
		{ name: "long tool override", flag: "--tools", args: ["--tools=bash,write,edit"] },
		{ name: "short tool override", flag: "-t", args: ["-t", "bash,write"] },
		{ name: "long extension injection", flag: "--extension", args: ["--extension=./unsafe.ts"] },
		{ name: "short extension injection", flag: "-e", args: ["-e", "./unsafe.ts"] },
	];
	for (const attempt of attempts) {
		await context.test(attempt.name, async () => {
			await assert.rejects(
				exec(process.execPath, [cliPath, "agent", ...attempt.args], {
					cwd: root,
					timeout: 5_000,
				}),
				(error: unknown) => rejectsCapabilityFlag(error, attempt.flag),
			);
		});
	}
});

test("principal exposes one durable launch surface instead of separate calibration and start tools", () => {
	const tools = new Set(PRINCIPAL_TOOLS.split(","));
	assert.equal(tools.has("iso_launch"), true);
	assert.equal(tools.has("iso_write_evaluator"), true);
	assert.equal(tools.has("iso_need_input"), true);
	assert.equal(tools.has("iso_query_evidence"), true);
	assert.equal(tools.has("iso_note"), true);
	assert.equal(tools.has("iso_champion"), true);
	assert.equal(tools.has("iso_calibrate"), false);
	assert.equal(tools.has("iso_start"), false);

	const args = restrictedPrincipalArgs([]);
	const toolsIndex = args.indexOf("--tools");
	assert.ok(toolsIndex >= 0);
	assert.equal(args[toolsIndex + 1], PRINCIPAL_TOOLS);
});

test("principal rejects pre-agent credential, export, session, package, and arbitrary file paths", () => {
	for (const args of [
		["auth", "print-api-key", "--model", "example"],
		["--export", "/tmp/session.jsonl"],
		["--session", "/tmp/session.jsonl"],
		["--session-id=attacker-session"],
		["--no-session"],
		["--mode", "rpc"],
		["--mode=rpc"],
		["--continue"],
		["update", "--self"],
		["@/etc/passwd"],
	]) {
		assert.throws(() => restrictedPrincipalArgs(args), /unavailable/u);
	}
});

test("principal session identity is stable per repository without exposing its path", () => {
	const first = principalSessionId("/private/work/product");
	assert.equal(first, principalSessionId("/private/work/product"));
	assert.notEqual(first, principalSessionId("/private/work/other"));
	assert.match(first, /^iso-principal-[a-f0-9]{32}$/u);
	assert.equal(first.includes("product"), false);
});

test("direct CLI launch opts into one exact transport retry", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-cli-launch-retry-"));
	await exec("git", ["init", "-q"], { cwd: root });
	await mkdir(join(root, ".iso"));
	let launches = 0;
	let pings = 0;
	const launchBodies: string[] = [];
	const server = createServer(async (request, response) => {
		const body = await readBody(request);
		const wire = JSON.parse(body) as { id: string; command: string };
		if (wire.command === "ping") {
			pings += 1;
			sendSuccess(response, wire.id, { pid: process.pid });
			return;
		}
		assert.equal(wire.command, "launch");
		launches += 1;
		launchBodies.push(body);
		if (launches === 1) {
			request.socket.destroy();
			return;
		}
		sendSuccess(response, wire.id, {
			mission: {
				missionId: "mission_cli_retry",
				phase: "accepted",
				accepted: true,
			},
		});
	});
	try {
		await listen(server, kernelSocketPath(root));
		const result = await exec(
			process.execPath,
			[
				cliPath,
				"launch",
				"--goal",
				"Retry the direct CLI launch",
				"--metric",
				"score",
				"--eval",
				"exec node evaluator.mjs",
				"--workers",
				"1",
				"--samples",
				"2",
				"--warmups",
				"0",
				"--score-min",
				"-100",
				"--score-max",
				"100",
				"--generations",
				"1",
				"--experiments",
				"1",
			],
			{ cwd: root, timeout: 10_000 },
		);
		assert.match(result.stdout, /Mission mission_cli_retry accepted/u);
		assert.equal(launches, 2);
		assert.equal(pings, 2);
		assert.equal(launchBodies[1], launchBodies[0]);
		const launch = JSON.parse(launchBodies[0]) as {
			payload: { config: { evaluator: { scoreBounds?: { min: number; max: number } } } };
		};
		assert.deepEqual(launch.payload.config.evaluator.scoreBounds, {
			min: -100,
			max: 100,
		});
	} finally {
		await closeServer(server);
		await rm(root, { force: true, recursive: true });
	}
});
