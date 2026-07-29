import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { dirname, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { KernelCommand, KernelResponse } from "./kernel.ts";
import type {
	PreflightBeginInput,
	PreflightClaimInput,
	PreflightContinuation,
	PreflightContinuationLookup,
	PreflightCorrectInput,
	PreflightDeferInput,
	PreflightFailInput,
	PreflightLookup,
	PreflightOpenInput,
	PreflightReceipt,
	PreflightRenewInput,
	PreflightResolveInput,
	PreflightResumeInput,
} from "./preflight.ts";

const PROTOCOL = "iso.kernel.v1";
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const STARTUP_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const KERNEL_ENVIRONMENT_KEYS = [
	"PATH",
	"HOME",
	"USER",
	"LOGNAME",
	"SHELL",
	"TMPDIR",
	"LANG",
	"LC_ALL",
	"LC_CTYPE",
	"HTTP_PROXY",
	"HTTPS_PROXY",
	"NO_PROXY",
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_AUTH_TOKEN",
	"ANTHROPIC_OAUTH_TOKEN",
	"ANT_LING_API_KEY",
	"OPENAI_API_KEY",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_API_VERSION",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
	"AZURE_OPENAI_RESOURCE_NAME",
	"GEMINI_API_KEY",
	"GOOGLE_CLOUD_API_KEY",
	"GOOGLE_CLOUD_LOCATION",
	"GOOGLE_CLOUD_PROJECT",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GCLOUD_PROJECT",
	"AI_GATEWAY_API_KEY",
	"CLOUDFLARE_ACCOUNT_ID",
	"CLOUDFLARE_GATEWAY_ID",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AWS_PROFILE",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"CEREBRAS_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"DEEPSEEK_API_KEY",
	"FIREWORKS_API_KEY",
	"GROQ_API_KEY",
	"HF_TOKEN",
	"KIMI_API_KEY",
	"MINIMAX_API_KEY",
	"MISTRAL_API_KEY",
	"NVIDIA_API_KEY",
	"OPENCODE_API_KEY",
	"OPENROUTER_API_KEY",
	"QWEN_TOKEN_PLAN_API_KEY",
	"QWEN_TOKEN_PLAN_CN_API_KEY",
	"TOGETHER_API_KEY",
	"XAI_API_KEY",
	"XIAOMI_API_KEY",
	"XIAOMI_TOKEN_PLAN_AMS_API_KEY",
	"XIAOMI_TOKEN_PLAN_CN_API_KEY",
	"XIAOMI_TOKEN_PLAN_SGP_API_KEY",
	"ZAI_API_KEY",
	"ZAI_CODING_CN_API_KEY",
] as const;

export interface KernelRequestOptions {
	requestId?: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	retryAmbiguousTransportOnce?: boolean;
}

export interface KernelClientOptions {
	kernelEntryPath?: string;
}

export class KernelUnavailableError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "KernelUnavailableError";
	}
}

export class KernelRemoteError extends Error {
	readonly code: string;

	constructor(code: string, message: string) {
		super(message);
		this.name = "KernelRemoteError";
		this.code = code;
	}
}

interface WireRequest {
	protocol: typeof PROTOCOL;
	id: string;
	command: KernelCommand;
	payload?: unknown;
}

const AMBIGUOUS_TRANSPORT = Symbol("iso.ambiguous-transport");

type AmbiguousTransportError = Error & {
	[AMBIGUOUS_TRANSPORT]: true;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function errorCode(error: unknown): string | undefined {
	return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function delay(milliseconds: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function abortReason(signal: AbortSignal): unknown {
	return signal.reason ?? new Error("Request aborted.");
}

function markAmbiguousTransport<T extends Error>(error: T): T & AmbiguousTransportError {
	Object.defineProperty(error, AMBIGUOUS_TRANSPORT, { value: true });
	return error as T & AmbiguousTransportError;
}

function isAmbiguousTransportError(error: unknown): error is AmbiguousTransportError {
	return error instanceof Error && AMBIGUOUS_TRANSPORT in error;
}

function waitForPromiseWithSignal<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
	if (!signal) {
		return promise;
	}
	if (signal.aborted) {
		return Promise.reject(abortReason(signal));
	}
	return new Promise<T>((resolve, reject) => {
		const abort = (): void => {
			reject(abortReason(signal));
		};
		signal.addEventListener("abort", abort, { once: true });
		void promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				resolve(value);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

function kernelEnvironment(): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = { ISO_KERNEL_CHILD: "1" };
	for (const key of KERNEL_ENVIRONMENT_KEYS) {
		const value = process.env[key];
		if (value !== undefined) {
			environment[key] = value;
		}
	}
	return environment;
}

export function kernelSocketPath(repoRoot: string): string {
	return join(repoRoot, ".iso", "kernel.sock");
}

export class KernelClient {
	readonly repoRoot: string;
	readonly socketPath: string;
	private readonly kernelEntryPath: string;
	private ensurePromise?: Promise<void>;

	constructor(repoRoot: string, options: KernelClientOptions = {}) {
		this.repoRoot = repoRoot;
		this.socketPath = kernelSocketPath(repoRoot);
		const modulePath = fileURLToPath(import.meta.url);
		const defaultKernelEntryPath = join(dirname(modulePath), `kernel-entry${extname(modulePath)}`);
		this.kernelEntryPath = realpathSync(options.kernelEntryPath ?? defaultKernelEntryPath);
	}

	async ensure(): Promise<void> {
		if (this.ensurePromise) {
			return this.ensurePromise;
		}
		this.ensurePromise = this.ensureKernel().finally(() => {
			this.ensurePromise = undefined;
		});
		return this.ensurePromise;
	}

	async request<TResult>(
		command: KernelCommand,
		payload?: unknown,
		options: KernelRequestOptions = {},
	): Promise<TResult> {
		if (options.signal?.aborted) {
			throw abortReason(options.signal);
		}
		const wireRequest: Readonly<WireRequest> = Object.freeze({
			protocol: PROTOCOL,
			id: options.requestId ?? randomUUID(),
			command,
			payload,
		});
		const timeoutMs = options.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
		const body = JSON.stringify(wireRequest);
		try {
			return await this.sendOnce<TResult>(wireRequest, body, timeoutMs, options.signal);
		} catch (error) {
			if (
				options.retryAmbiguousTransportOnce !== true ||
				options.signal?.aborted ||
				!isAmbiguousTransportError(error)
			) {
				throw options.signal?.aborted ? abortReason(options.signal) : error;
			}
			await waitForPromiseWithSignal(this.ensure(), options.signal);
			if (options.signal?.aborted) {
				throw abortReason(options.signal);
			}
			return this.sendOnce<TResult>(wireRequest, body, timeoutMs, options.signal);
		}
	}

	private sendOnce<TResult>(
		wireRequest: Readonly<WireRequest>,
		body: string,
		timeoutMs: number,
		signal?: AbortSignal,
	): Promise<TResult> {
		return new Promise<TResult>((resolve, reject) => {
			let settled = false;
			let responseEnded = false;
			const finish = (callback: () => void): void => {
				if (settled) {
					return;
				}
				settled = true;
				signal?.removeEventListener("abort", abort);
				callback();
			};
			const request = httpRequest(
				{
					socketPath: this.socketPath,
					path: "/v1/command",
					method: "POST",
					headers: {
						"content-length": Buffer.byteLength(body),
						"content-type": "application/json",
					},
				},
				(response) => {
					response.setEncoding("utf8");
					let responseBody = "";
					let responseBytes = 0;
					response.on("data", (chunk: string) => {
						responseBody += chunk;
						responseBytes += Buffer.byteLength(chunk);
						if (responseBytes > MAX_RESPONSE_BYTES) {
							request.destroy(markAmbiguousTransport(new Error("ISO kernel response exceeded the size limit.")));
						}
					});
					response.on("end", () => {
						responseEnded = true;
						try {
							const parsed: unknown = JSON.parse(responseBody);
							if (!isRecord(parsed) || parsed.protocol !== PROTOCOL || parsed.id !== wireRequest.id) {
								throw new Error("ISO kernel returned an invalid response envelope.");
							}
							const kernelResponse = parsed as unknown as KernelResponse<unknown>;
							if (!kernelResponse.ok) {
								throw new KernelRemoteError(kernelResponse.error.code, kernelResponse.error.message);
							}
							finish(() => resolve(kernelResponse.result as TResult));
						} catch (error) {
							const responseError =
								error instanceof KernelRemoteError
									? error
									: markAmbiguousTransport(
											error instanceof Error ? error : new Error("ISO kernel returned an invalid response."),
										);
							finish(() => reject(responseError));
						}
					});
					response.on("aborted", () => {
						finish(() =>
							reject(markAmbiguousTransport(new Error("ISO kernel response ended before completion."))),
						);
					});
					response.on("error", (error) => {
						finish(() => reject(markAmbiguousTransport(error)));
					});
					response.on("close", () => {
						if (!responseEnded) {
							finish(() =>
								reject(markAmbiguousTransport(new Error("ISO kernel response connection closed early."))),
							);
						}
					});
				},
			);
			const abort = (): void => {
				const reason = signal ? abortReason(signal) : new Error("Request aborted.");
				request.destroy(reason instanceof Error ? reason : new Error("Request aborted."));
				finish(() => reject(reason));
			};
			request.setTimeout(timeoutMs, () => {
				request.destroy(markAmbiguousTransport(new Error(`ISO kernel request timed out after ${timeoutMs}ms.`)));
			});
			request.on("error", (error) => {
				const code = errorCode(error);
				const wrapped =
					code === "ENOENT" || code === "ECONNREFUSED"
						? new KernelUnavailableError(`ISO kernel is unavailable at ${this.socketPath}.`, { cause: error })
						: error;
				finish(() => reject(isAmbiguousTransportError(wrapped) ? wrapped : markAmbiguousTransport(wrapped)));
			});
			if (signal?.aborted) {
				abort();
				return;
			}
			signal?.addEventListener("abort", abort, { once: true });
			request.end(body);
		});
	}

	async openPreflight(input: PreflightOpenInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/open", input, options);
		return result.receipt;
	}

	async beginPreflight(input: PreflightBeginInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/begin", input, options);
		return result.receipt;
	}

	async claimPreflight(input: PreflightClaimInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/claim", input, options);
		return result.receipt;
	}

	async renewPreflight(input: PreflightRenewInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/renew", input, options);
		return result.receipt;
	}

	async resumePreflight(input: PreflightResumeInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/resume", input, options);
		return result.receipt;
	}

	async getPreflightContinuation(
		lookup: PreflightContinuationLookup,
		options: KernelRequestOptions = {},
	): Promise<PreflightContinuation | undefined> {
		const result = await this.request<{ continuation?: PreflightContinuation }>(
			"preflight/continuation",
			lookup,
			options,
		);
		return result.continuation;
	}

	async getPreflight(lookup: PreflightLookup, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/status", lookup, options);
		return result.receipt;
	}

	async deferPreflight(input: PreflightDeferInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/defer", input, options);
		return result.receipt;
	}

	async correctPreflight(input: PreflightCorrectInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/correct", input, options);
		return result.receipt;
	}

	async resolvePreflight(input: PreflightResolveInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/resolve", input, options);
		return result.receipt;
	}

	async failPreflight(input: PreflightFailInput, options: KernelRequestOptions = {}): Promise<PreflightReceipt> {
		const result = await this.request<{ receipt: PreflightReceipt }>("preflight/fail", input, options);
		return result.receipt;
	}

	private async ensureKernel(): Promise<void> {
		try {
			await this.pingOnce();
			return;
		} catch (error) {
			if (!(error instanceof KernelUnavailableError) && errorCode(error) !== "ETIMEDOUT") {
				const message = error instanceof Error ? error.message : String(error);
				if (!message.includes("timed out")) {
					throw error;
				}
			}
		}

		const isoDirectory = join(this.repoRoot, ".iso");
		mkdirSync(isoDirectory, { recursive: true, mode: 0o700 });
		const directoryStat = lstatSync(isoDirectory);
		if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
			throw new KernelUnavailableError(
				`ISO state directory must be a real directory, not a symlink: ${isoDirectory}`,
			);
		}
		chmodSync(isoDirectory, 0o700);
		const logPath = join(isoDirectory, "kernel.log");
		if (existsSync(logPath)) {
			const logStat = lstatSync(logPath);
			if (logStat.isSymbolicLink() || !logStat.isFile()) {
				throw new KernelUnavailableError(`ISO kernel log must be a regular file, not a symlink: ${logPath}`);
			}
		}
		const logDescriptor = openSync(logPath, "a", 0o600);
		chmodSync(logPath, 0o600);
		const child = spawn(process.execPath, [this.kernelEntryPath, this.repoRoot], {
			cwd: this.repoRoot,
			detached: true,
			env: kernelEnvironment(),
			stdio: ["ignore", logDescriptor, logDescriptor],
		});
		let spawnError: unknown;
		child.once("error", (error) => {
			spawnError = error;
		});
		closeSync(logDescriptor);
		child.unref();

		const deadline = Date.now() + STARTUP_TIMEOUT_MS;
		let lastError: unknown;
		while (Date.now() < deadline) {
			if (spawnError) {
				throw new KernelUnavailableError("Failed to launch the ISO kernel process.", { cause: spawnError });
			}
			try {
				await this.pingOnce();
				return;
			} catch (error) {
				lastError = error;
				await delay(100);
			}
		}
		throw new KernelUnavailableError(
			`ISO kernel did not become ready within ${STARTUP_TIMEOUT_MS}ms. See ${join(isoDirectory, "kernel.log")}.`,
			{ cause: lastError },
		);
	}

	private pingOnce(): Promise<void> {
		const wireRequest: Readonly<WireRequest> = Object.freeze({
			protocol: PROTOCOL,
			id: randomUUID(),
			command: "ping",
		});
		const body = JSON.stringify(wireRequest);
		return this.sendOnce(wireRequest, body, 500);
	}
}
