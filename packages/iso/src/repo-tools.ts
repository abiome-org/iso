import { spawn } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { open, opendir, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";

const MAX_PATH_LENGTH = 4_096;
const MAX_READ_SCAN_BYTES = 1024 * 1024;
const MAX_READ_OUTPUT_BYTES = 64 * 1024;
const DEFAULT_READ_LINES = 200;
const MAX_READ_LINES = 400;
const MAX_READ_OFFSET = 100_000;
const MAX_SEARCH_QUERY_LENGTH = 512;
const DEFAULT_SEARCH_RESULTS = 50;
const MAX_SEARCH_RESULTS = 100;
const MAX_SEARCH_OUTPUT_BYTES = 64 * 1024;
const MAX_SEARCH_STDERR_BYTES = 8 * 1024;
const MAX_LIST_ENTRIES = 200;
const MAX_LIST_SCAN = 1_000;
const MAX_LIST_OUTPUT_BYTES = 32 * 1024;

const PRIVATE_SEGMENTS = new Set([".git", ".iso"]);
const DEFAULT_EXCLUDED_SEGMENTS = new Set([".git", ".iso", "node_modules", "dist"]);
const SENSITIVE_NAME_PATTERNS = [
	/^\.env(?:\.|$)/iu,
	/^(?:id_rsa|id_ed25519)(?:\.|$)/iu,
	/^(?:\.npmrc|\.netrc|\.pypirc|credentials\.json)$/iu,
	/\.(?:key|p12|pfx|pem)$/iu,
];

const readSchema = Type.Object({
	path: Type.String({
		description: "Repository-relative path to a text file",
		minLength: 1,
		maxLength: MAX_PATH_LENGTH,
	}),
	offset: Type.Optional(
		Type.Integer({
			description: "First line to return, one-indexed",
			minimum: 1,
			maximum: MAX_READ_OFFSET,
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum lines to return, capped at ${MAX_READ_LINES}`,
			minimum: 1,
			maximum: MAX_READ_LINES,
		}),
	),
});

const searchSchema = Type.Object({
	query: Type.String({
		description: "Literal text to find; regular expressions are not accepted",
		minLength: 1,
		maxLength: MAX_SEARCH_QUERY_LENGTH,
	}),
	path: Type.Optional(
		Type.String({
			description: "Repository-relative file or directory to search; defaults to the repository root",
			minLength: 1,
			maxLength: MAX_PATH_LENGTH,
		}),
	),
	caseSensitive: Type.Optional(
		Type.Boolean({
			description: "Use case-sensitive matching; defaults to true",
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum matching lines to return, capped at ${MAX_SEARCH_RESULTS}`,
			minimum: 1,
			maximum: MAX_SEARCH_RESULTS,
		}),
	),
});

const listSchema = Type.Object({
	path: Type.Optional(
		Type.String({
			description: "Repository-relative directory to list; defaults to the repository root",
			minLength: 1,
			maxLength: MAX_PATH_LENGTH,
		}),
	),
	limit: Type.Optional(
		Type.Integer({
			description: `Maximum entries to return, capped at ${MAX_LIST_ENTRIES}`,
			minimum: 1,
			maximum: MAX_LIST_ENTRIES,
		}),
	),
});

export interface RepoReadDetails {
	path: string;
	startLine: number;
	endLine: number;
	fileBytes: number;
	scannedBytes: number;
	truncated: boolean;
}

export interface RepoSearchDetails {
	path: string;
	matches: number;
	truncated: boolean;
}

export interface RepoListDetails {
	path: string;
	entries: number;
	scanned: number;
	truncated: boolean;
}

export type RepoInspectionTool =
	| ToolDefinition<typeof readSchema, RepoReadDetails>
	| ToolDefinition<typeof searchSchema, RepoSearchDetails>
	| ToolDefinition<typeof listSchema, RepoListDetails>;
export type RepoInspectionTools = [
	ToolDefinition<typeof readSchema, RepoReadDetails>,
	ToolDefinition<typeof searchSchema, RepoSearchDetails>,
	ToolDefinition<typeof listSchema, RepoListDetails>,
];

interface SafeRepositoryPath {
	absolutePath: string;
	displayPath: string;
}

interface SearchResult {
	text: string;
	matches: number;
	truncated: boolean;
}

function abortError(): Error {
	const error = new Error("Repository inspection was aborted.");
	error.name = "AbortError";
	return error;
}

function assertNotAborted(signal: AbortSignal | undefined): void {
	if (signal?.aborted) {
		throw abortError();
	}
}

function pathIsContained(root: string, candidate: string): boolean {
	const relativePath = relative(root, candidate);
	return (
		relativePath === "" ||
		(relativePath !== ".." && !relativePath.startsWith(`..${sep}`) && !isAbsolute(relativePath))
	);
}

function pathSegments(relativePath: string): string[] {
	return relativePath
		.split(/[\\/]/u)
		.filter(Boolean)
		.map((segment) => segment.toLowerCase());
}

function assertNoPrivateSegments(relativePath: string): void {
	const privateSegment = pathSegments(relativePath).find((segment) => PRIVATE_SEGMENTS.has(segment));
	if (privateSegment) {
		throw new Error(`Repository-private path is not available to the principal investigator: ${privateSegment}`);
	}
}

function isSensitiveName(name: string): boolean {
	return SENSITIVE_NAME_PATTERNS.some((pattern) => pattern.test(name));
}

function assertNoSensitiveSegments(relativePath: string): void {
	const sensitive = relativePath.split(/[\\/]/u).find((segment) => isSensitiveName(segment));
	if (sensitive) {
		throw new Error(`Potentially sensitive repository path is not available to the principal: ${sensitive}`);
	}
}

function displayPath(root: string, absolutePath: string): string {
	const value = relative(root, absolutePath);
	return value === "" ? "." : value.split(sep).join("/");
}

function visibleName(name: string): string {
	return /[\u0000-\u001f\u007f]/u.test(name) ? JSON.stringify(name) : name;
}

function appendWithinByteLimit(current: string, next: string, limit: number): string | undefined {
	if (Buffer.byteLength(current) + Buffer.byteLength(next) > limit) {
		return undefined;
	}
	return current + next;
}

function withoutFinalNewline(value: string): string {
	return value.endsWith("\n") ? value.slice(0, -1) : value;
}

function boundedStderr(current: string, next: string): string {
	const combined = current + next;
	const bytes = Buffer.from(combined);
	if (bytes.byteLength <= MAX_SEARCH_STDERR_BYTES) {
		return combined;
	}
	return bytes.subarray(bytes.byteLength - MAX_SEARCH_STDERR_BYTES).toString("utf8");
}

function runLiteralSearch(options: {
	repoRoot: string;
	searchPath: string;
	query: string;
	caseSensitive: boolean;
	limit: number;
	signal?: AbortSignal;
}): Promise<SearchResult> {
	assertNotAborted(options.signal);
	const target = displayPath(options.repoRoot, options.searchPath);
	const args = [
		"--no-config",
		"--fixed-strings",
		"--line-number",
		"--column",
		"--with-filename",
		"--no-heading",
		"--color=never",
		"--hidden",
		"--path-separator=/",
		"--max-columns=500",
		"--max-columns-preview",
		"--max-filesize=2M",
		"--glob=!.git",
		"--glob=!**/.git",
		"--glob=!.git/**",
		"--glob=!**/.git/**",
		"--glob=!.iso",
		"--glob=!**/.iso",
		"--glob=!.iso/**",
		"--glob=!**/.iso/**",
		"--glob=!node_modules",
		"--glob=!**/node_modules",
		"--glob=!node_modules/**",
		"--glob=!**/node_modules/**",
		"--glob=!dist",
		"--glob=!**/dist",
		"--glob=!dist/**",
		"--glob=!**/dist/**",
		"--glob=!.env*",
		"--glob=!**/.env*",
		"--glob=!*.pem",
		"--glob=!**/*.pem",
		"--glob=!*.key",
		"--glob=!**/*.key",
		"--glob=!*.p12",
		"--glob=!**/*.p12",
		"--glob=!*.pfx",
		"--glob=!**/*.pfx",
		"--glob=!id_rsa*",
		"--glob=!**/id_rsa*",
		"--glob=!id_ed25519*",
		"--glob=!**/id_ed25519*",
	];
	if (!options.caseSensitive) {
		args.push("--ignore-case");
	}
	args.push("--", options.query, target);

	return new Promise((resolveSearch, reject) => {
		const child = spawn("rg", args, {
			cwd: options.repoRoot,
			env: {
				LANG: process.env.LANG ?? "C",
				PATH: process.env.PATH ?? "/usr/bin:/bin",
			},
			shell: false,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let output = "";
		let remainder = "";
		let stderr = "";
		let matches = 0;
		let truncated = false;
		let stoppedForLimit = false;
		let settled = false;

		const cleanup = (): void => {
			options.signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error?: Error): void => {
			if (settled) {
				return;
			}
			settled = true;
			cleanup();
			if (error) {
				reject(error);
				return;
			}
			resolveSearch({
				text: withoutFinalNewline(output) || (truncated ? "(matches exceeded output cap)" : "(no matches)"),
				matches,
				truncated,
			});
		};
		const stopAtLimit = (): void => {
			if (stoppedForLimit) {
				return;
			}
			stoppedForLimit = true;
			truncated = true;
			child.kill("SIGTERM");
		};
		const consumeLine = (line: string): void => {
			if (stoppedForLimit || line.length === 0) {
				return;
			}
			if (matches >= options.limit) {
				stopAtLimit();
				return;
			}
			const next = appendWithinByteLimit(output, `${line}\n`, MAX_SEARCH_OUTPUT_BYTES);
			if (next === undefined) {
				stopAtLimit();
				return;
			}
			output = next;
			matches += 1;
		};
		const onAbort = (): void => {
			child.kill("SIGTERM");
		};

		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.signal?.aborted) {
			onAbort();
		}
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			if (stoppedForLimit) {
				return;
			}
			const lines = `${remainder}${chunk}`.split(/\r?\n/u);
			remainder = lines.pop() ?? "";
			for (const line of lines) {
				consumeLine(line);
				if (stoppedForLimit) {
					break;
				}
			}
			if (Buffer.byteLength(remainder) > MAX_SEARCH_OUTPUT_BYTES) {
				stopAtLimit();
			}
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = boundedStderr(stderr, chunk);
		});
		child.once("error", (error) => {
			finish(error);
		});
		child.once("close", (code, closeSignal) => {
			if (options.signal?.aborted) {
				finish(abortError());
				return;
			}
			if (!stoppedForLimit && remainder) {
				consumeLine(remainder);
			}
			if (stoppedForLimit || code === 0 || code === 1) {
				finish();
				return;
			}
			const status = code === null ? `signal ${closeSignal ?? "unknown"}` : `code ${code}`;
			finish(new Error(`Repository search failed with ${status}${stderr.trim() ? `: ${stderr.trim()}` : "."}`));
		});
	});
}

export function createRepoInspectionTools(repoRoot: string): RepoInspectionTools {
	const lexicalRoot = resolve(repoRoot);
	const realRoot = realpathSync(lexicalRoot);
	if (!statSync(realRoot).isDirectory()) {
		throw new Error(`Repository root is not a directory: ${repoRoot}`);
	}

	const resolveRepositoryPath = async (requestedPath: string): Promise<SafeRepositoryPath> => {
		if (requestedPath.length === 0 || requestedPath.length > MAX_PATH_LENGTH || requestedPath.includes("\0")) {
			throw new Error("Repository path is empty or exceeds the allowed length.");
		}
		if (isAbsolute(requestedPath)) {
			throw new Error("Repository inspection paths must be relative to the repository root.");
		}
		const lexicalCandidate = resolve(lexicalRoot, requestedPath);
		if (!pathIsContained(lexicalRoot, lexicalCandidate)) {
			throw new Error("Repository path escapes the repository root.");
		}
		assertNoPrivateSegments(relative(lexicalRoot, lexicalCandidate));
		assertNoSensitiveSegments(relative(lexicalRoot, lexicalCandidate));

		let realCandidate: string;
		try {
			realCandidate = await realpath(lexicalCandidate);
		} catch {
			throw new Error(`Repository path does not exist: ${requestedPath}`);
		}
		if (!pathIsContained(realRoot, realCandidate)) {
			throw new Error("Repository symlink resolves outside the repository root.");
		}
		const canonicalRelativePath = relative(realRoot, realCandidate);
		assertNoPrivateSegments(canonicalRelativePath);
		assertNoSensitiveSegments(canonicalRelativePath);
		return {
			absolutePath: realCandidate,
			displayPath: canonicalRelativePath === "" ? "." : canonicalRelativePath.split(sep).join("/"),
		};
	};

	const readTool = defineTool({
		name: "iso_read_repo",
		label: "Read repository",
		description:
			"Read a bounded range from a UTF-8 text file in the repository. Paths are repository-relative; .git, .iso, and symlink escapes are forbidden.",
		promptSnippet: "Read bounded text from the repository without write access",
		promptGuidelines: [
			"Use iso_read_repo, iso_search_repo, and iso_list_repo for repository inspection; they cannot mutate files or access ISO private state.",
		],
		parameters: readSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			assertNotAborted(signal);
			const safePath = await resolveRepositoryPath(params.path);
			const metadata = await stat(safePath.absolutePath);
			if (!metadata.isFile()) {
				throw new Error(`Repository path is not a regular file: ${safePath.displayPath}`);
			}
			const bytesToScan = Math.min(metadata.size, MAX_READ_SCAN_BYTES);
			const buffer = Buffer.alloc(bytesToScan);
			const handle = await open(safePath.absolutePath, "r");
			let bytesRead = 0;
			try {
				bytesRead = (await handle.read(buffer, 0, bytesToScan, 0)).bytesRead;
			} finally {
				await handle.close();
			}
			assertNotAborted(signal);
			const scanned = buffer.subarray(0, bytesRead);
			if (scanned.includes(0)) {
				throw new Error(`Repository file is binary and cannot be inspected as text: ${safePath.displayPath}`);
			}
			let text: string;
			try {
				text = new TextDecoder("utf-8", { fatal: true }).decode(scanned, {
					stream: metadata.size > bytesRead,
				});
			} catch {
				throw new Error(`Repository file is not valid UTF-8 text: ${safePath.displayPath}`);
			}
			const lines = text.replace(/\r\n/gu, "\n").replace(/\r/gu, "\n").split("\n");
			if (lines.at(-1) === "") {
				lines.pop();
			}
			const startLine = params.offset ?? 1;
			const lineLimit = params.limit ?? DEFAULT_READ_LINES;
			const startIndex = startLine - 1;
			if (startIndex >= lines.length && metadata.size > bytesRead) {
				throw new Error(`Requested line is beyond the ${MAX_READ_SCAN_BYTES}-byte repository read scan limit.`);
			}
			let output = "";
			let linesReturned = 0;
			let outputTruncated = false;
			for (let index = startIndex; index < lines.length && linesReturned < lineLimit; index += 1) {
				const formatted = `${index + 1}: ${lines[index]}\n`;
				const next = appendWithinByteLimit(output, formatted, MAX_READ_OUTPUT_BYTES);
				if (next === undefined) {
					outputTruncated = true;
					break;
				}
				output = next;
				linesReturned += 1;
			}
			const endLine = linesReturned === 0 ? startLine - 1 : startLine + linesReturned - 1;
			const truncated = outputTruncated || metadata.size > bytesRead || startIndex + linesReturned < lines.length;
			return {
				content: [
					{
						type: "text",
						text: withoutFinalNewline(output) || `(no lines at or after ${startLine} in ${safePath.displayPath})`,
					},
				],
				details: {
					path: safePath.displayPath,
					startLine,
					endLine,
					fileBytes: metadata.size,
					scannedBytes: bytesRead,
					truncated,
				},
			};
		},
	});

	const searchTool = defineTool({
		name: "iso_search_repo",
		label: "Search repository",
		description:
			"Search repository text with a literal string using ripgrep. Results and bytes are capped; .git, .iso, node_modules, dist, and symlink escapes are excluded.",
		promptSnippet: "Search repository text literally without shell access",
		parameters: searchSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			if (/[\0\r\n]/u.test(params.query)) {
				throw new Error("Repository search query must be a single line without null bytes.");
			}
			const safePath = await resolveRepositoryPath(params.path ?? ".");
			const metadata = await stat(safePath.absolutePath);
			if (!metadata.isFile() && !metadata.isDirectory()) {
				throw new Error(`Repository search target is not a regular file or directory: ${safePath.displayPath}`);
			}
			const result = await runLiteralSearch({
				repoRoot: realRoot,
				searchPath: safePath.absolutePath,
				query: params.query,
				caseSensitive: params.caseSensitive ?? true,
				limit: params.limit ?? DEFAULT_SEARCH_RESULTS,
				signal,
			});
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					path: safePath.displayPath,
					matches: result.matches,
					truncated: result.truncated,
				},
			};
		},
	});

	const listTool = defineTool({
		name: "iso_list_repo",
		label: "List repository",
		description:
			"List a bounded number of entries in a repository directory. Private state, generated dependency trees, and unsafe symlinks are omitted.",
		promptSnippet: "List bounded repository directory entries without write access",
		parameters: listSchema,
		executionMode: "parallel",
		async execute(_toolCallId, params, signal) {
			assertNotAborted(signal);
			const safePath = await resolveRepositoryPath(params.path ?? ".");
			const metadata = await stat(safePath.absolutePath);
			if (!metadata.isDirectory()) {
				throw new Error(`Repository path is not a directory: ${safePath.displayPath}`);
			}
			const limit = params.limit ?? MAX_LIST_ENTRIES;
			const entries: string[] = [];
			let scanned = 0;
			let scanTruncated = false;
			const directory = await opendir(safePath.absolutePath);
			for await (const entry of directory) {
				assertNotAborted(signal);
				scanned += 1;
				if (scanned > MAX_LIST_SCAN) {
					scanTruncated = true;
					break;
				}
				if (DEFAULT_EXCLUDED_SEGMENTS.has(entry.name.toLowerCase())) {
					continue;
				}
				if (isSensitiveName(entry.name)) {
					continue;
				}
				let suffix = entry.isDirectory() ? "/" : "";
				if (entry.isSymbolicLink()) {
					try {
						const target = await resolveRepositoryPath(
							safePath.displayPath === "." ? entry.name : `${safePath.displayPath}/${entry.name}`,
						);
						suffix = (await stat(target.absolutePath)).isDirectory() ? "@/" : "@";
					} catch {
						continue;
					}
				} else if (!entry.isDirectory() && !entry.isFile()) {
					continue;
				}
				entries.push(`${visibleName(entry.name)}${suffix}`);
			}
			entries.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: "base" }));
			const selected = entries.slice(0, limit);
			let output = "";
			let outputTruncated = false;
			let entriesReturned = 0;
			for (const entry of selected) {
				const next = appendWithinByteLimit(output, `${entry}\n`, MAX_LIST_OUTPUT_BYTES);
				if (next === undefined) {
					outputTruncated = true;
					break;
				}
				output = next;
				entriesReturned += 1;
			}
			const truncated = scanTruncated || entries.length > limit || outputTruncated;
			return {
				content: [{ type: "text", text: withoutFinalNewline(output) || "(empty directory)" }],
				details: {
					path: safePath.displayPath,
					entries: entriesReturned,
					scanned,
					truncated,
				},
			};
		},
	});

	return [readTool, searchTool, listTool];
}
