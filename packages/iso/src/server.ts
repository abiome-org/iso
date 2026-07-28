import { randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type ServerResponse } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { IsoRuntime } from "./runtime.ts";

interface ServeOptions {
	host: string;
	port: number;
	startResearch?: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
	response.writeHead(status, {
		"cache-control": "no-store",
		"content-type": "application/json; charset=utf-8",
	});
	response.end(`${JSON.stringify(value)}\n`);
}

function readBody(request: NodeJS.ReadableStream): Promise<unknown> {
	return new Promise((resolve, reject) => {
		let body = "";
		request.setEncoding("utf8");
		request.on("data", (chunk: string) => {
			body += chunk;
			if (body.length > 1_000_000) {
				reject(new Error("Request body is too large."));
			}
		});
		request.on("end", () => {
			try {
				resolve(body ? JSON.parse(body) : {});
			} catch {
				reject(new Error("Request body must be JSON."));
			}
		});
		request.on("error", reject);
	});
}

function contentType(path: string): string {
	switch (extname(path)) {
		case ".css":
			return "text/css; charset=utf-8";
		case ".js":
			return "text/javascript; charset=utf-8";
		case ".html":
			return "text/html; charset=utf-8";
		default:
			return "application/octet-stream";
	}
}

export async function serveDashboard(runtime: IsoRuntime, options: ServeOptions): Promise<void> {
	const token = randomBytes(24).toString("base64url");
	const assetRoot = join(dirname(dirname(fileURLToPath(import.meta.url))), "public");
	const eventClients = new Set<ServerResponse>();
	let changeVersion = 0;
	runtime.onChange(() => {
		changeVersion += 1;
		for (const client of eventClients) {
			client.write(`event: change\ndata: ${changeVersion}\n\n`);
		}
	});

	const server = createServer(async (request, response) => {
		try {
			const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "localhost"}`);
			if (request.method === "GET" && url.pathname === "/api/snapshot") {
				sendJson(response, 200, await runtime.snapshot());
				return;
			}
			if (request.method === "GET" && url.pathname === "/api/events") {
				response.writeHead(200, {
					"cache-control": "no-cache",
					connection: "keep-alive",
					"content-type": "text/event-stream",
				});
				response.write("event: ready\ndata: 1\n\n");
				eventClients.add(response);
				request.once("close", () => eventClients.delete(response));
				return;
			}
			if (request.method === "POST" && url.pathname.startsWith("/api/")) {
				if (request.headers["x-iso-control-token"] !== token) {
					sendJson(response, 403, { error: "Invalid control token." });
					return;
				}
				const body = await readBody(request);
				if (url.pathname === "/api/ideas" && isRecord(body)) {
					if (
						typeof body.title !== "string" ||
						typeof body.hypothesis !== "string" ||
						typeof body.implementationPlan !== "string"
					) {
						sendJson(response, 400, { error: "title, hypothesis, and implementationPlan are required." });
						return;
					}
					sendJson(response, 201, {
						idea: await runtime.addIdea({
							title: body.title,
							hypothesis: body.hypothesis,
							implementationPlan: body.implementationPlan,
						}),
					});
					return;
				}
				if (url.pathname === "/api/research/start" && isRecord(body)) {
					const iterations = typeof body.iterations === "number" ? body.iterations : undefined;
					const workers = typeof body.workers === "number" ? body.workers : undefined;
					void runtime.startResearch({ iterations, workers }).catch((error: unknown) => {
						console.error(error);
					});
					sendJson(response, 202, { started: true });
					return;
				}
				if (url.pathname === "/api/research/pause") {
					await runtime.pause();
					sendJson(response, 200, { paused: true });
					return;
				}
				const steerMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/steer$/);
				if (steerMatch && isRecord(body) && typeof body.message === "string") {
					await runtime.steer(steerMatch[1], body.message);
					sendJson(response, 200, { steered: true });
					return;
				}
				const abortMatch = url.pathname.match(/^\/api\/workers\/([^/]+)\/abort$/);
				if (abortMatch) {
					await runtime.abort(abortMatch[1]);
					sendJson(response, 200, { aborted: true });
					return;
				}
				sendJson(response, 404, { error: "Unknown API route." });
				return;
			}

			const requestedAsset =
				url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "").replaceAll("..", "");
			const assetPath = join(assetRoot, requestedAsset);
			let content = await readFile(assetPath);
			if (requestedAsset === "index.html") {
				content = Buffer.from(
					content.toString("utf8").replace("__ISO_CONTROL_TOKEN_JSON__", JSON.stringify(token)),
				);
			}
			response.writeHead(200, {
				"cache-control": requestedAsset === "index.html" ? "no-store" : "public, max-age=300",
				"content-type": contentType(assetPath),
				"x-content-type-options": "nosniff",
			});
			response.end(content);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			sendJson(response, message.includes("ENOENT") ? 404 : 500, { error: message });
		}
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, options.host, () => resolve());
	});
	console.log(`ISO dashboard: http://${options.host}:${options.port}`);
	if (options.host !== "127.0.0.1" && options.host !== "localhost" && options.host !== "::1") {
		console.log(`Control token: ${token}`);
		console.warn("This is a local control plane. Put an authenticated relay in front of it before remote use.");
	}
	if (options.startResearch) {
		void runtime.startResearch().catch((error: unknown) => {
			console.error(error);
		});
	}
	await new Promise<void>((resolve) => {
		const close = () => {
			for (const client of eventClients) {
				client.end();
			}
			server.close(() => resolve());
		};
		process.once("SIGINT", close);
		process.once("SIGTERM", close);
	});
}
