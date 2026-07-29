import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { KernelClient, KernelRemoteError, kernelSocketPath } from "../src/client.ts";

const PROTOCOL = "iso.kernel.v1";

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

test("ambiguous transport retry reuses the exact launch ID and serialized body once", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-client-retry-"));
	await mkdir(join(root, ".iso"));
	const payload = { goal: "freeze this body", config: { workers: 2 } };
	const launchBodies: string[] = [];
	let launchAttempts = 0;
	let pings = 0;
	const server = createServer(async (request, response) => {
		const body = await readBody(request);
		const wire = JSON.parse(body) as { id: string; command: string };
		if (wire.command === "ping") {
			pings += 1;
			sendSuccess(response, wire.id, { pid: process.pid });
			return;
		}
		assert.equal(wire.command, "launch");
		launchAttempts += 1;
		launchBodies.push(body);
		if (launchAttempts === 1) {
			payload.goal = "mutated after the first write";
			request.socket.destroy();
			return;
		}
		sendSuccess(response, wire.id, { mission: { missionId: "mission_retry" } });
	});
	try {
		await listen(server, kernelSocketPath(root));
		const client = new KernelClient(root);
		const result = await client.request<{ mission: { missionId: string } }>("launch", payload, {
			requestId: "stable-launch-request",
			retryAmbiguousTransportOnce: true,
		});
		assert.equal(result.mission.missionId, "mission_retry");
		assert.equal(launchAttempts, 2);
		assert.equal(pings, 1);
		assert.equal(launchBodies.length, 2);
		assert.equal(launchBodies[1], launchBodies[0]);
		const replayedWire = JSON.parse(launchBodies[1]) as {
			id: string;
			payload: { goal: string };
		};
		assert.equal(replayedWire.id, "stable-launch-request");
		assert.equal(replayedWire.payload.goal, "freeze this body");
	} finally {
		await closeServer(server);
		await rm(root, { force: true, recursive: true });
	}
});

test("ambiguous transport retry never retries a valid remote error", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-client-remote-error-"));
	await mkdir(join(root, ".iso"));
	let requests = 0;
	const server = createServer(async (request, response) => {
		requests += 1;
		const wire = JSON.parse(await readBody(request)) as { id: string };
		response.writeHead(400, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				protocol: PROTOCOL,
				id: wire.id,
				ok: false,
				error: { code: "idempotency_conflict", message: "payload changed" },
			}),
		);
	});
	try {
		await listen(server, kernelSocketPath(root));
		const client = new KernelClient(root);
		await assert.rejects(
			client.request(
				"launch",
				{ goal: "conflict" },
				{
					requestId: "remote-error-request",
					retryAmbiguousTransportOnce: true,
				},
			),
			(error: unknown) =>
				error instanceof KernelRemoteError &&
				error.code === "idempotency_conflict" &&
				error.message === "payload changed",
		);
		assert.equal(requests, 1);
	} finally {
		await closeServer(server);
		await rm(root, { force: true, recursive: true });
	}
});

test("a second ambiguous transport failure is surfaced without a third attempt", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-client-second-failure-"));
	await mkdir(join(root, ".iso"));
	let launches = 0;
	let pings = 0;
	const server = createServer(async (request, response) => {
		const wire = JSON.parse(await readBody(request)) as { id: string; command: string };
		if (wire.command === "ping") {
			pings += 1;
			sendSuccess(response, wire.id, { pid: process.pid });
			return;
		}
		launches += 1;
		request.socket.destroy();
	});
	try {
		await listen(server, kernelSocketPath(root));
		const client = new KernelClient(root);
		await assert.rejects(
			client.request(
				"launch",
				{ goal: "fail twice" },
				{
					requestId: "two-attempt-request",
					retryAmbiguousTransportOnce: true,
				},
			),
		);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(launches, 2);
		assert.equal(pings, 1);
	} finally {
		await closeServer(server);
		await rm(root, { force: true, recursive: true });
	}
});

test("aborting an ambiguous request prevents its retry", async () => {
	const root = await mkdtemp(join(tmpdir(), "iso-client-abort-"));
	await mkdir(join(root, ".iso"));
	let requests = 0;
	let releaseFirstRequest = (): void => {};
	const firstRequest = new Promise<void>((resolve) => {
		releaseFirstRequest = resolve;
	});
	const server = createServer(async (request) => {
		requests += 1;
		await readBody(request);
		releaseFirstRequest();
	});
	try {
		await listen(server, kernelSocketPath(root));
		const client = new KernelClient(root);
		const controller = new AbortController();
		const reason = new Error("operator cancelled exact launch");
		const operation = client.request(
			"launch",
			{ goal: "cancel" },
			{
				requestId: "aborted-request",
				retryAmbiguousTransportOnce: true,
				signal: controller.signal,
			},
		);
		await firstRequest;
		controller.abort(reason);
		await assert.rejects(operation, (error: unknown) => error === reason);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(requests, 1);
	} finally {
		await closeServer(server);
		await rm(root, { force: true, recursive: true });
	}
});
