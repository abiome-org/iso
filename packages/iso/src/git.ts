import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import {
	chmod,
	cp,
	lstat,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	symlink,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { createSandboxedBashOperations } from "./sandbox.ts";

export { findRepoRoot } from "./repo-root.ts";

interface CommandResult {
	stdout: string;
	stderr: string;
}

interface CommandOptions {
	outputLimitBytes?: number;
	timeoutMs?: number;
}

export interface CandidateSnapshot {
	commit: string;
	diffStat: string;
	changedPaths: string[];
}

interface SourceSnapshotDetails {
	/** Commit that was at HEAD when capture began. */
	baseCommit: string;
	/** Immutable commit containing the admitted worktree bytes. */
	commit: string;
	/** Tree written for the source snapshot. */
	tree: string;
	/** Source paths whose snapshot content differs from baseCommit. */
	changedPaths: string[];
	/** Control/dependency paths deliberately absent from the source snapshot. */
	excludedPaths: string[];
	/** Number of changed worktree bytes copied through the trusted quarantine. */
	totalBytes: number;
}

export interface SourceSnapshot extends SourceSnapshotDetails {
	/** Create-only private ref keeping the snapshot reachable for the campaign lifetime. */
	ref: string;
}

export interface EphemeralSourceSnapshot extends SourceSnapshotDetails {
	/** Ephemeral validation captures deliberately do not publish a durable Git ref. */
	ref?: never;
}

export class CandidatePolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "CandidatePolicyError";
	}
}

export class SourceSnapshotPolicyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "SourceSnapshotPolicyError";
	}
}

export class EvaluatorIntegrityError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "EvaluatorIntegrityError";
	}
}

const SENSITIVE_PATH_PATTERNS = [
	/(^|\/)\.env(?:\.|$)/i,
	/(^|\/)(?:id_rsa|id_ed25519)(?:\.|$)/i,
	/\.(?:pem|p12|pfx|key)$/i,
	/(^|\/)(?:credentials|secrets?)(?:\.|\/|$)/i,
];

const CONTROL_PLANE_PATH_PATTERNS = [
	/(^|\/)\.pi(?:\/|$)/i,
	/(^|\/)\.agents?(?:\/|$)/i,
	/(^|\/)(?:agents|claude)\.md$/i,
	/(^|\/)\.mcp\.json$/i,
	/(^|\/)\.gitattributes$/i,
	/(^|\/)\.gitmodules$/i,
];

const DEPENDENCY_ROOT = "node_modules";
const DEPENDENCY_VIEW_MARKER = ".iso-readonly-view";
const DEPENDENCY_STORE = join(".iso", "dependencies");
const ACTIVE_DEPENDENCY_SNAPSHOT = "active";
const MISSING_DEPENDENCY_DIGEST = createHash("sha256").update("installed-dependencies:missing\0").digest("hex");
const FROZEN_DEPENDENCY_PATHS = [
	"package.json",
	"package-lock.json",
	"npm-shrinkwrap.json",
	"pnpm-lock.yaml",
	"pnpm-workspace.yaml",
	"yarn.lock",
	"bun.lock",
	"bun.lockb",
] as const;
const DEPENDENCY_DIGEST_PATHS = FROZEN_DEPENDENCY_PATHS;
const verifiedDependencySnapshots = new Map<string, string>();

interface DependencyDigestEntry {
	descriptor: string;
	file?: string;
}

function isContainedPath(root: string, candidate: string): boolean {
	const fromRoot = relative(root, candidate);
	return fromRoot === "" || (!fromRoot.startsWith(`..${sep}`) && fromRoot !== ".." && !isAbsolute(fromRoot));
}

async function canonicalPathForComparison(path: string): Promise<string> {
	let cursor = resolve(path);
	const missingSegments: string[] = [];
	for (;;) {
		try {
			return resolve(await realpath(cursor), ...missingSegments);
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
			const parent = dirname(cursor);
			if (parent === cursor) {
				throw error;
			}
			missingSegments.unshift(basename(cursor));
			cursor = parent;
		}
	}
}

export function normalizeRepositoryRelativePath(value: string, label = "Repository path"): string {
	if (value.includes("\0") || value.includes("\\")) {
		throw new Error(`${label} must use repository-relative POSIX path separators.`);
	}
	const normalized = posix.normalize(value);
	if (
		value.trim() === "" ||
		normalized === "." ||
		posix.isAbsolute(normalized) ||
		normalized === ".." ||
		normalized.startsWith("../")
	) {
		throw new Error(`${label} must name a path inside the repository.`);
	}
	return normalized.replace(/\/+$/u, "");
}

function run(
	command: string,
	args: string[],
	cwd: string,
	environment: Readonly<Record<string, string>> = {},
	options: CommandOptions = {},
): Promise<CommandResult> {
	return new Promise((resolveCommand, reject) => {
		if (
			command === "git" &&
			Object.keys(environment).some(
				(name) =>
					name.startsWith("GIT_") &&
					![
						"GIT_AUTHOR_EMAIL",
						"GIT_AUTHOR_NAME",
						"GIT_COMMITTER_EMAIL",
						"GIT_COMMITTER_NAME",
						"GIT_INDEX_FILE",
					].includes(name),
			)
		) {
			reject(new Error("ISO rejected an unexpected Git environment override."));
			return;
		}
		const inheritedEnvironment = Object.fromEntries(
			Object.entries(process.env).filter(
				(entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("GIT_"),
			),
		);
		const commandArgs =
			command === "git"
				? [
						"--no-replace-objects",
						"-c",
						"core.hooksPath=/dev/null",
						"-c",
						"core.fsmonitor=false",
						"-c",
						"core.useReplaceRefs=false",
						...args,
					]
				: args;
		const child = spawn(command, commandArgs, {
			cwd,
			env: {
				...inheritedEnvironment,
				...(command === "git"
					? {
							GIT_CONFIG_GLOBAL: "/dev/null",
							GIT_CONFIG_NOSYSTEM: "1",
							GIT_NO_LAZY_FETCH: "1",
							GIT_OPTIONAL_LOCKS: "0",
							GIT_NO_REPLACE_OBJECTS: "1",
						}
					: {}),
				...environment,
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const outputLimitBytes = options.outputLimitBytes ?? 16 * 1024 * 1024;
		const timeoutMs = options.timeoutMs ?? 5 * 60_000;
		let outputBytes = 0;
		let terminalError: Error | undefined;
		const stop = (error: Error): void => {
			if (terminalError !== undefined) {
				return;
			}
			terminalError = error;
			child.kill("SIGKILL");
		};
		const collect = (destination: Buffer[], chunk: Buffer): void => {
			outputBytes += chunk.byteLength;
			if (outputBytes > outputLimitBytes) {
				stop(new Error(`${command} output exceeded ISO's ${outputLimitBytes}-byte control-plane limit.`));
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
			stop(new Error(`${command} ${args.join(" ")} exceeded ISO's ${timeoutMs}ms control-plane timeout.`));
		}, timeoutMs);
		timeout.unref();
		child.once("close", (code) => {
			clearTimeout(timeout);
			if (terminalError !== undefined) {
				reject(terminalError);
				return;
			}
			const stdoutValue = Buffer.concat(stdout).toString("utf8");
			const stderrValue = Buffer.concat(stderr).toString("utf8");
			if (code === 0) {
				resolveCommand({ stdout: stdoutValue, stderr: stderrValue });
				return;
			}
			reject(new Error(`${command} ${args.join(" ")} failed (${code}): ${stderrValue.trim()}`));
		});
	});
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

function matchesProtectedPath(path: string, protectedPath: string): boolean {
	const normalized = normalizeRepositoryRelativePath(protectedPath, "Protected evaluator path");
	return path === normalized || path.startsWith(`${normalized}/`);
}

interface IntegrityTreeEntry {
	path: string;
	type: "directory" | "file";
	mode: number;
}

async function collectIntegrityTree(path: string): Promise<IntegrityTreeEntry[]> {
	try {
		const metadata = await lstat(path);
		if (metadata.isSymbolicLink()) {
			throw new EvaluatorIntegrityError(`Protected evaluator inputs may not contain symbolic links: ${path}`);
		}
		if (metadata.isFile()) {
			return [{ path, type: "file", mode: metadata.mode & 0o7777 }];
		}
		if (!metadata.isDirectory()) {
			throw new EvaluatorIntegrityError(`Protected evaluator input is not a regular file or directory: ${path}`);
		}
		const entries = await readdir(path);
		const nested = await Promise.all(entries.sort().map((entry) => collectIntegrityTree(join(path, entry))));
		return [{ path, type: "directory", mode: metadata.mode & 0o7777 }, ...nested.flat()];
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return [];
		}
		throw error;
	}
}

function hashField(hash: ReturnType<typeof createHash>, label: string, value: string | Buffer): void {
	const content = typeof value === "string" ? Buffer.from(value) : value;
	hash.update(`${label}:${content.byteLength}:`);
	hash.update(content);
	hash.update("\0");
}

async function hashIntegrityTree(
	hash: ReturnType<typeof createHash>,
	label: string,
	repositoryRoot: string,
	entries: IntegrityTreeEntry[],
): Promise<void> {
	for (const entry of entries.sort((left, right) => left.path.localeCompare(right.path))) {
		hashField(hash, `${label}-path`, relative(repositoryRoot, entry.path));
		hashField(hash, `${label}-type`, entry.type);
		hashField(hash, `${label}-mode`, entry.mode.toString(8));
		if (entry.type === "file") {
			hashField(hash, `${label}-content`, await readFile(entry.path));
		}
	}
}

function collectDependencyEntries(options: {
	entries: DependencyDigestEntry[];
	path: string;
	logicalPath: string;
	repositoryRoot: string;
	dependencyRoot: string;
	ancestors: ReadonlySet<string>;
	visited: Set<string>;
}): void {
	const metadata = lstatSync(options.path);
	if (metadata.isSymbolicLink()) {
		const canonicalTarget = realpathSync(options.path);
		if (!isContainedPath(options.repositoryRoot, canonicalTarget)) {
			throw new EvaluatorIntegrityError(
				`Installed dependency link resolves outside the repository: ${options.logicalPath}`,
			);
		}
		if (!isContainedPath(options.dependencyRoot, canonicalTarget)) {
			options.entries.push({
				descriptor: `workspace-link:${options.logicalPath}:${relative(options.repositoryRoot, canonicalTarget)}\0`,
			});
			return;
		}
		options.entries.push({
			descriptor: `dependency-link:${options.logicalPath}:${relative(options.dependencyRoot, canonicalTarget)}\0`,
		});
		if (options.visited.has(canonicalTarget)) {
			options.entries.push({
				descriptor: `dependency-reference:${options.logicalPath}:${relative(options.dependencyRoot, canonicalTarget)}\0`,
			});
			return;
		}
		if (options.ancestors.has(canonicalTarget)) {
			options.entries.push({ descriptor: `dependency-cycle:${options.logicalPath}\0` });
			return;
		}
		collectDependencyEntries({
			...options,
			path: canonicalTarget,
			ancestors: new Set([...options.ancestors, canonicalTarget]),
		});
		return;
	}
	if (metadata.isDirectory()) {
		const canonicalDirectory = resolve(options.path);
		if (options.visited.has(canonicalDirectory)) {
			options.entries.push({
				descriptor: `dependency-reference:${options.logicalPath}:${relative(options.dependencyRoot, canonicalDirectory)}\0`,
			});
			return;
		}
		options.visited.add(canonicalDirectory);
		options.entries.push({ descriptor: `dependency-directory:${options.logicalPath}\0` });
		const ancestors = new Set([...options.ancestors, canonicalDirectory]);
		for (const entry of readdirSync(options.path).sort()) {
			collectDependencyEntries({
				...options,
				path: join(options.path, entry),
				logicalPath: options.logicalPath === "." ? entry : `${options.logicalPath}/${entry}`,
				ancestors,
			});
		}
		return;
	}
	if (metadata.isFile()) {
		const canonicalFile = resolve(options.path);
		if (options.visited.has(canonicalFile)) {
			options.entries.push({
				descriptor: `dependency-reference:${options.logicalPath}:${relative(options.dependencyRoot, canonicalFile)}\0`,
			});
			return;
		}
		options.visited.add(canonicalFile);
		options.entries.push({
			descriptor: `dependency-file:${options.logicalPath}:${(metadata.mode & 0o111) === 0 ? "data" : "executable"}\0`,
			file: options.path,
		});
		return;
	}
	throw new EvaluatorIntegrityError(`Installed dependency is not a regular file or directory: ${options.logicalPath}`);
}

async function computeInstalledDependenciesDigest(repositoryRoot: string, dependencyPath: string): Promise<string> {
	try {
		if (!(await lstat(dependencyPath)).isDirectory()) {
			throw new EvaluatorIntegrityError("Installed node_modules dependency root is not a directory.");
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return MISSING_DEPENDENCY_DIGEST;
		}
		throw error;
	}
	const dependencyRoot = await realpath(dependencyPath);
	const entries: DependencyDigestEntry[] = [];
	collectDependencyEntries({
		entries,
		path: dependencyRoot,
		logicalPath: ".",
		repositoryRoot,
		dependencyRoot,
		ancestors: new Set([dependencyRoot]),
		visited: new Set(),
	});
	const hash = createHash("sha256");
	const batchSize = 128;
	for (let offset = 0; offset < entries.length; offset += batchSize) {
		const batch = entries.slice(offset, offset + batchSize);
		const entryDigests = await Promise.all(
			batch.map(async (entry) => {
				const entryHash = createHash("sha256").update(entry.descriptor);
				if (entry.file) {
					entryHash.update(await readFile(entry.file));
				}
				return entryHash.digest();
			}),
		);
		for (const entryDigest of entryDigests) {
			hash.update(entryDigest);
		}
	}
	return hash.digest("hex");
}

async function activeDependencySnapshot(
	repositoryRoot: string,
): Promise<{ dependencyRoot: string; digest: string } | undefined> {
	try {
		const digest = (
			await readFile(join(repositoryRoot, DEPENDENCY_STORE, ACTIVE_DEPENDENCY_SNAPSHOT), "utf8")
		).trim();
		if (!/^[a-f0-9]{64}$/u.test(digest)) {
			throw new EvaluatorIntegrityError("ISO dependency snapshot pointer is malformed.");
		}
		return {
			dependencyRoot: join(repositoryRoot, DEPENDENCY_STORE, digest, DEPENDENCY_ROOT),
			digest,
		};
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
}

async function installedDependenciesDigest(repositoryRoot: string): Promise<string> {
	const active = await activeDependencySnapshot(repositoryRoot);
	if (!active) {
		return computeInstalledDependenciesDigest(repositoryRoot, join(repositoryRoot, DEPENDENCY_ROOT));
	}
	let canonicalSnapshot: string;
	try {
		canonicalSnapshot = await realpath(active.dependencyRoot);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
		const actual = await computeInstalledDependenciesDigest(repositoryRoot, active.dependencyRoot);
		if (actual !== active.digest) {
			throw new EvaluatorIntegrityError("ISO's content-addressed dependency snapshot is missing.");
		}
		return actual;
	}
	if (verifiedDependencySnapshots.get(canonicalSnapshot) === active.digest) {
		return active.digest;
	}
	const actual = await computeInstalledDependenciesDigest(repositoryRoot, canonicalSnapshot);
	if (actual !== active.digest) {
		throw new EvaluatorIntegrityError("ISO's content-addressed dependency snapshot failed integrity verification.");
	}
	verifiedDependencySnapshots.set(canonicalSnapshot, actual);
	return actual;
}

async function dependencySource(repositoryRoot: string): Promise<string> {
	const active = await activeDependencySnapshot(repositoryRoot);
	if (!active) {
		return join(repositoryRoot, DEPENDENCY_ROOT);
	}
	await installedDependenciesDigest(repositoryRoot);
	return active.dependencyRoot;
}

async function writeActiveDependencyPointer(repositoryRoot: string, digest: string): Promise<void> {
	const storeRoot = join(repositoryRoot, DEPENDENCY_STORE);
	await mkdir(storeRoot, { recursive: true, mode: 0o700 });
	const pointerStaging = join(storeRoot, `active-${process.pid}-${randomUUID()}`);
	try {
		await writeFile(pointerStaging, `${digest}\n`, { flag: "wx", mode: 0o600 });
		await rename(pointerStaging, join(storeRoot, ACTIVE_DEPENDENCY_SNAPSHOT));
	} finally {
		await rm(pointerStaging, { force: true });
	}
}

/**
 * Select an already-frozen dependency tree by content address.
 *
 * This never reads or recopies the live node_modules tree. The content-addressed
 * snapshot is verified before the active pointer is replaced atomically.
 */
export async function activateDependencySnapshot(repositoryRoot: string, expectedDigest: string): Promise<void> {
	repositoryRoot = await realpath(resolve(repositoryRoot));
	if (!/^[a-f0-9]{64}$/u.test(expectedDigest)) {
		throw new EvaluatorIntegrityError("Dependency snapshot digest must be 64 lowercase hexadecimal characters.");
	}
	const storeRoot = join(repositoryRoot, DEPENDENCY_STORE);
	const snapshotRoot = join(storeRoot, expectedDigest);
	let snapshotMetadata: Awaited<ReturnType<typeof lstat>>;
	try {
		snapshotMetadata = await lstat(snapshotRoot);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			throw new EvaluatorIntegrityError(`Dependency snapshot is unavailable: ${expectedDigest}`);
		}
		throw error;
	}
	if (!snapshotMetadata.isDirectory() || snapshotMetadata.isSymbolicLink()) {
		throw new EvaluatorIntegrityError("Dependency snapshot root must be a real directory.");
	}
	const canonicalStore = await realpath(storeRoot);
	const canonicalSnapshot = await realpath(snapshotRoot);
	if (
		canonicalStore !== resolve(storeRoot) ||
		canonicalSnapshot !== resolve(snapshotRoot) ||
		!isContainedPath(canonicalStore, canonicalSnapshot)
	) {
		throw new EvaluatorIntegrityError("Dependency snapshot escaped ISO's content-addressed store.");
	}
	const dependencyRoot = join(snapshotRoot, DEPENDENCY_ROOT);
	const actualDigest = await computeInstalledDependenciesDigest(repositoryRoot, dependencyRoot);
	if (actualDigest !== expectedDigest) {
		throw new EvaluatorIntegrityError("Dependency snapshot failed content-address verification.");
	}
	if (expectedDigest !== MISSING_DEPENDENCY_DIGEST) {
		const dependencyMetadata = await lstat(dependencyRoot);
		if (!dependencyMetadata.isDirectory() || dependencyMetadata.isSymbolicLink()) {
			throw new EvaluatorIntegrityError("Dependency snapshot node_modules must be a real directory.");
		}
		verifiedDependencySnapshots.set(await realpath(dependencyRoot), actualDigest);
	}
	await writeActiveDependencyPointer(repositoryRoot, expectedDigest);
}

function rewriteDependencySnapshotLinks(
	sourceRoot: string,
	targetRoot: string,
	repositoryRoot: string,
	sourcePath = sourceRoot,
): void {
	for (const entry of readdirSync(sourcePath).sort()) {
		const sourceEntry = join(sourcePath, entry);
		const targetEntry = join(targetRoot, relative(sourceRoot, sourceEntry));
		const metadata = lstatSync(sourceEntry);
		if (metadata.isSymbolicLink()) {
			const canonicalTarget = realpathSync(sourceEntry);
			if (!isContainedPath(repositoryRoot, canonicalTarget)) {
				throw new EvaluatorIntegrityError(
					`Installed dependency link resolves outside the repository: ${relative(sourceRoot, sourceEntry)}`,
				);
			}
			const mappedTarget = isContainedPath(sourceRoot, canonicalTarget)
				? relative(dirname(targetEntry), join(targetRoot, relative(sourceRoot, canonicalTarget)))
				: canonicalTarget;
			rmSync(targetEntry, { force: true });
			symlinkSync(mappedTarget || ".", targetEntry);
		} else if (metadata.isDirectory()) {
			rewriteDependencySnapshotLinks(sourceRoot, targetRoot, repositoryRoot, sourceEntry);
		}
	}
}

export async function prepareDependencySnapshot(repositoryRoot: string): Promise<string> {
	repositoryRoot = await realpath(resolve(repositoryRoot));
	const source = join(repositoryRoot, DEPENDENCY_ROOT);
	const digest = await computeInstalledDependenciesDigest(repositoryRoot, source);
	try {
		if (!(await lstat(source)).isDirectory()) {
			return digest;
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			await mkdir(join(repositoryRoot, DEPENDENCY_STORE, digest), { recursive: true, mode: 0o700 });
			await activateDependencySnapshot(repositoryRoot, digest);
			return digest;
		}
		throw error;
	}

	const storeRoot = join(repositoryRoot, DEPENDENCY_STORE);
	const snapshotRoot = join(storeRoot, digest);
	const snapshotDependencies = join(snapshotRoot, DEPENDENCY_ROOT);
	await mkdir(storeRoot, { recursive: true, mode: 0o700 });
	let snapshotExists = false;
	try {
		snapshotExists = (await lstat(snapshotDependencies)).isDirectory();
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}
	if (!snapshotExists) {
		const stagingRoot = await mkdtemp(join(storeRoot, "staging-"));
		const stagingDependencies = join(stagingRoot, DEPENDENCY_ROOT);
		try {
			if (process.platform === "darwin") {
				await run("/bin/cp", ["-cR", "-P", source, stagingDependencies], repositoryRoot);
			} else {
				await cp(source, stagingDependencies, {
					dereference: false,
					errorOnExist: true,
					force: false,
					recursive: true,
					verbatimSymlinks: true,
				});
			}
			rewriteDependencySnapshotLinks(source, stagingDependencies, repositoryRoot);
			const copiedDigest = await computeInstalledDependenciesDigest(repositoryRoot, stagingDependencies);
			if (copiedDigest !== digest) {
				throw new EvaluatorIntegrityError("Dependency tree changed while ISO was freezing it.");
			}
			try {
				await rename(stagingRoot, snapshotRoot);
			} catch (error) {
				if (!(typeof error === "object" && error !== null && "code" in error && error.code === "EEXIST")) {
					throw error;
				}
			}
		} finally {
			await rm(stagingRoot, { force: true, recursive: true });
		}
	}
	const frozenDigest = await computeInstalledDependenciesDigest(repositoryRoot, snapshotDependencies);
	if (frozenDigest !== digest) {
		throw new EvaluatorIntegrityError("Existing ISO dependency snapshot does not match its content address.");
	}
	await run("find", [snapshotRoot, "-type", "f", "-exec", "chmod", "a-w", "{}", "+"], repositoryRoot);
	verifiedDependencySnapshots.set(await realpath(snapshotDependencies), digest);
	await writeActiveDependencyPointer(repositoryRoot, digest);
	return digest;
}

export async function resolveCommit(repoRoot: string, ref = "HEAD"): Promise<string> {
	return (await run("git", ["rev-parse", `${ref}^{commit}`], repoRoot)).stdout.trim();
}

export async function assertCleanRepository(repoRoot: string): Promise<void> {
	const configScopes = await Promise.all(
		["--local", "--worktree"].map((scope) =>
			run("git", ["config", scope, "--no-includes", "--list", "--name-only"], repoRoot),
		),
	);
	const configKeys = [...new Set(configScopes.flatMap(({ stdout }) => stdout.split(/\r?\n/u).filter(Boolean)))];
	const executableConfig = configKeys.filter((key) =>
		/^(?:filter\..*\.(?:clean|smudge|process|required)|diff\..*\.(?:command|textconv)|merge\..*\.driver|core\.(?:attributesfile|fsmonitor|hookspath|sshcommand)|include(?:if)?\.)$/iu.test(
			key,
		),
	);
	if (executableConfig.length > 0) {
		throw new Error(
			`ISO refuses repository-local Git configuration that can execute or import code: ${executableConfig.join(", ")}`,
		);
	}
	const remotes = (await run("git", ["remote", "-v"], repoRoot)).stdout
		.split(/\r?\n/u)
		.map((line) => line.trim().split(/\s+/u)[1])
		.filter((value): value is string => value !== undefined);
	for (const remote of remotes) {
		if (/^https?:\/\//iu.test(remote)) {
			const url = new URL(remote);
			if (url.username || url.password) {
				throw new Error("ISO refuses Git remote URLs with embedded credentials.");
			}
		}
	}
	const replacementRefs = (
		await run("git", ["for-each-ref", "--format=%(refname)", "refs/replace/"], repoRoot)
	).stdout.trim();
	const commonGitDirectory = (
		await run("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], repoRoot)
	).stdout.trim();
	let hasGrafts = false;
	try {
		hasGrafts = (await lstat(join(commonGitDirectory, "info", "grafts"))).isFile();
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}
	if (replacementRefs || hasGrafts) {
		throw new Error("ISO refuses Git replace refs and grafts because they can change frozen commit materialization.");
	}
	const status = (await run("git", ["status", "--porcelain=v1", "--untracked-files=all"], repoRoot)).stdout.trim();
	if (status) {
		throw new Error(
			"ISO requires a clean repository before calibration so every experiment has a reproducible base commit.",
		);
	}
}

export function isoWorktreeRoot(repoRoot: string): string {
	const repositoryKey = createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 20);
	return join(tmpdir(), "iso-worktrees", repositoryKey);
}

function evaluatorControlWorktreeRoot(repoRoot: string): string {
	const repositoryKey = createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 20);
	return join(tmpdir(), "iso-evaluator-control-worktrees", repositoryKey);
}

async function materializeDependencyEntry(options: {
	source: string;
	target: string;
	sourceRoot: string;
	repoRoot: string;
	worktree: string;
	expandDirectory: boolean;
}): Promise<void> {
	const metadata = await lstat(options.source);
	if (metadata.isSymbolicLink()) {
		const canonicalTarget = await realpath(options.source);
		const mappedTarget =
			isContainedPath(options.repoRoot, canonicalTarget) && !isContainedPath(options.sourceRoot, canonicalTarget)
				? join(options.worktree, relative(options.repoRoot, canonicalTarget))
				: options.source;
		await symlink(mappedTarget, options.target);
		return;
	}
	if (metadata.isDirectory() && options.expandDirectory) {
		await mkdir(options.target, { mode: 0o700 });
		for (const entry of (await readdir(options.source)).sort()) {
			await materializeDependencyEntry({
				...options,
				source: join(options.source, entry),
				target: join(options.target, entry),
				expandDirectory: false,
			});
		}
		return;
	}
	if (metadata.isDirectory()) {
		await symlink(options.source, options.target, "dir");
		return;
	}
	if (metadata.isFile()) {
		await symlink(options.source, options.target, "file");
	}
}

async function mountReadonlyDependencies(repoRoot: string, worktree: string): Promise<void> {
	const source = await dependencySource(repoRoot);
	const target = join(worktree, DEPENDENCY_ROOT);
	try {
		if (!(await lstat(source)).isDirectory()) {
			return;
		}
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return;
		}
		throw error;
	}
	try {
		await lstat(target);
		return;
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}

	await mkdir(target, { mode: 0o700 });
	await symlink(source, join(target, DEPENDENCY_VIEW_MARKER), "dir");
	const [canonicalRepoRoot, canonicalSource, canonicalWorktree] = await Promise.all([
		realpath(repoRoot),
		realpath(source),
		realpath(worktree),
	]);
	for (const entry of (await readdir(source)).sort()) {
		if (entry === DEPENDENCY_VIEW_MARKER) {
			throw new Error(`Dependency directory uses ISO's reserved entry: ${DEPENDENCY_VIEW_MARKER}`);
		}
		await materializeDependencyEntry({
			source: join(source, entry),
			target: join(target, entry),
			sourceRoot: canonicalSource,
			repoRoot: canonicalRepoRoot,
			worktree: canonicalWorktree,
			expandDirectory: entry === ".bin" || entry.startsWith("@"),
		});
	}
}

async function removeReadonlyDependencyMounts(repoRoot: string, worktree: string): Promise<void> {
	const source = await dependencySource(repoRoot);
	const target = join(worktree, DEPENDENCY_ROOT);
	const marker = join(target, DEPENDENCY_VIEW_MARKER);
	try {
		const [markerMetadata, canonicalMarker, canonicalSource] = await Promise.all([
			lstat(marker),
			realpath(marker),
			realpath(source),
		]);
		if (!markerMetadata.isSymbolicLink() || canonicalMarker !== canonicalSource) {
			throw new CandidatePolicyError("Candidate modified ISO's frozen dependency view.");
		}
		await rm(target, { recursive: true });
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}
}

export async function createGenerationWorktree(options: {
	repoRoot: string;
	generationId: string;
	baseCommit: string;
}): Promise<string> {
	return createDetachedWorktree({
		repoRoot: options.repoRoot,
		worktreeId: `${options.generationId}-base`,
		commit: options.baseCommit,
	});
}

export async function createDetachedWorktree(options: {
	repoRoot: string;
	worktreeId: string;
	commit: string;
}): Promise<string> {
	return createDetachedWorktreeAtRoot(options, isoWorktreeRoot(options.repoRoot));
}

export async function createEvaluatorControlWorktree(options: {
	repoRoot: string;
	worktreeId: string;
	commit: string;
}): Promise<string> {
	return createDetachedWorktreeAtRoot(options, evaluatorControlWorktreeRoot(options.repoRoot));
}

async function createDetachedWorktreeAtRoot(
	options: {
		repoRoot: string;
		worktreeId: string;
		commit: string;
	},
	root: string,
): Promise<string> {
	if (!/^[a-zA-Z0-9._-]+$/.test(options.worktreeId)) {
		throw new Error(`Invalid detached worktree ID: ${options.worktreeId}`);
	}
	await mkdir(root, { recursive: true, mode: 0o700 });
	const path = join(root, options.worktreeId);
	await run("git", ["worktree", "add", "--detach", path, options.commit], options.repoRoot);
	try {
		await mountReadonlyDependencies(options.repoRoot, path);
	} catch (error) {
		await removeWorktree(options.repoRoot, path).catch(() => undefined);
		throw error;
	}
	return path;
}

export async function createExperimentWorktree(options: {
	repoRoot: string;
	title: string;
	experimentId: string;
	baseCommit: string;
}): Promise<{ branch: string; worktree: string }> {
	const root = isoWorktreeRoot(options.repoRoot);
	await mkdir(root, { recursive: true, mode: 0o700 });
	const suffix = options.experimentId.replace("experiment_", "").slice(0, 8);
	const branch = `iso/${slug(options.title)}-${suffix}`;
	const worktree = join(root, options.experimentId);
	await run("git", ["worktree", "add", "-b", branch, worktree, options.baseCommit], options.repoRoot);
	try {
		await mountReadonlyDependencies(options.repoRoot, worktree);
	} catch (error) {
		await removeWorktree(options.repoRoot, worktree).catch(() => undefined);
		await run("git", ["branch", "-D", branch], options.repoRoot).catch(() => undefined);
		throw error;
	}
	return { branch, worktree };
}

const DEFAULT_MAX_CANDIDATE_BYTES = 64 * 1024 * 1024;
const DEFAULT_MAX_CANDIDATE_FILE_BYTES = 16 * 1024 * 1024;
const SNAPSHOT_GIT_OPTIONS = { outputLimitBytes: 1024 * 1024, timeoutMs: 30_000 } as const;

interface FrozenCandidateFile {
	blob?: string;
	deleted: boolean;
	digest?: string;
	mode: "100644" | "100755" | "120000";
	path: string;
	size: number;
}

function shellArgument(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

const CAPTURE_HELPER_SOURCE = String.raw`
"use strict";
const fs = require("node:fs");
const fsp = fs.promises;
const path = require("node:path");
const { createHash } = require("node:crypto");

function fail(message) {
	throw new Error(message);
}

async function safeParents(root, relativePath) {
	let current = root;
	for (const component of relativePath.split("/").slice(0, -1)) {
		current = path.join(current, component);
		try {
			const metadata = await fsp.lstat(current, { bigint: true });
			if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
				fail("path traverses a symbolic link or non-directory");
			}
		} catch (error) {
			if (error && error.code === "ENOENT") return false;
			throw error;
		}
	}
	return true;
}

function sameIdentity(left, right) {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameState(left, right) {
	return sameIdentity(left, right) &&
		left.size === right.size &&
		left.mode === right.mode &&
		left.mtimeNs === right.mtimeNs &&
		left.ctimeNs === right.ctimeNs &&
		left.nlink === right.nlink;
}

async function capture(manifest) {
	const records = [];
	let totalBytes = 0n;
	const maximumBytes = BigInt(manifest.maxBytes);
	const maximumFileBytes = BigInt(manifest.maxFileBytes);
	for (const [recordIndex, relativePath] of manifest.paths.entries()) {
		const sourcePath = path.join(manifest.worktree, ...relativePath.split("/"));
		if (!(await safeParents(manifest.worktree, relativePath))) {
			records.push({ path: relativePath, deleted: true, mode: "100644", size: 0 });
			continue;
		}
		let initial;
		try {
			initial = await fsp.lstat(sourcePath, { bigint: true });
		} catch (error) {
			if (error && error.code === "ENOENT") {
				records.push({ path: relativePath, deleted: true, mode: "100644", size: 0 });
				continue;
			}
			throw error;
		}
		if (initial.isSymbolicLink()) {
			if (!manifest.allowSymbolicLinks || initial.nlink !== 1n) {
				fail("path is not an admitted single-link symbolic link");
			}
			const beforeTarget = await fsp.readlink(sourcePath, { encoding: "buffer" });
			const current = await fsp.lstat(sourcePath, { bigint: true });
			if (!sameState(initial, current) || !(await safeParents(manifest.worktree, relativePath))) {
				fail("symbolic link changed during capture");
			}
			const size = beforeTarget.byteLength;
			if (
				!Number.isSafeInteger(size) ||
				BigInt(size) > maximumFileBytes ||
				totalBytes + BigInt(size) > maximumBytes
			) {
				fail("candidate byte limit exceeded");
			}
			const blob = "blob-" + String(recordIndex).padStart(6, "0");
			const targetPath = path.join(manifest.quarantine, "blobs", blob);
			await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
			await fsp.writeFile(targetPath, beforeTarget, { flag: "wx", mode: 0o600 });
			const afterTarget = await fsp.readlink(sourcePath, { encoding: "buffer" });
			const finalPath = await fsp.lstat(sourcePath, { bigint: true });
			if (
				!beforeTarget.equals(afterTarget) ||
				!sameState(initial, finalPath) ||
				!(await safeParents(manifest.worktree, relativePath))
			) {
				fail("symbolic link changed during capture");
			}
			totalBytes += BigInt(size);
			records.push({
				path: relativePath,
				blob,
				deleted: false,
				digest: createHash("sha256").update(beforeTarget).digest("hex"),
				mode: "120000",
				size,
			});
			continue;
		}
		if (!initial.isFile() || initial.nlink !== 1n) {
			fail("path is not a single-link regular file");
		}
		const source = await fsp.open(
			sourcePath,
			fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK,
		);
		try {
			const before = await source.stat({ bigint: true });
			const current = await fsp.lstat(sourcePath, { bigint: true });
			if (!before.isFile() || before.nlink !== 1n || !sameIdentity(before, initial) ||
				!sameIdentity(before, current) || !(await safeParents(manifest.worktree, relativePath))) {
				fail("path changed identity during capture");
			}
			if (before.size < 0n || before.size > maximumFileBytes || totalBytes + before.size > maximumBytes) {
				fail("candidate byte limit exceeded");
			}
			const size = Number(before.size);
			if (!Number.isSafeInteger(size)) fail("candidate file size is unsafe");
			const blob = "blob-" + String(recordIndex).padStart(6, "0");
			const targetPath = path.join(manifest.quarantine, "blobs", blob);
			await fsp.mkdir(path.dirname(targetPath), { recursive: true, mode: 0o700 });
			const target = await fsp.open(targetPath, "wx", 0o600);
			const digest = createHash("sha256");
			try {
				const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, size)));
				let offset = 0;
				while (offset < size) {
					const { bytesRead } = await source.read(
						buffer,
						0,
						Math.min(buffer.byteLength, size - offset),
						offset,
					);
					if (bytesRead === 0) fail("path changed size during capture");
					let written = 0;
					while (written < bytesRead) {
						const result = await target.write(buffer, written, bytesRead - written, offset + written);
						if (result.bytesWritten === 0) fail("quarantine write made no progress");
						written += result.bytesWritten;
					}
					digest.update(buffer.subarray(0, bytesRead));
					offset += bytesRead;
				}
			} finally {
				await target.close();
			}
			const after = await source.stat({ bigint: true });
			const finalPath = await fsp.lstat(sourcePath, { bigint: true });
			if (!sameState(before, after) || !sameIdentity(after, finalPath) ||
				!(await safeParents(manifest.worktree, relativePath))) {
				fail("path changed during capture");
			}
			totalBytes += before.size;
			records.push({
				path: relativePath,
				blob,
				deleted: false,
				digest: digest.digest("hex"),
				mode: (before.mode & 0o111n) === 0n ? "100644" : "100755",
				size,
			});
		} finally {
			await source.close();
		}
	}
	await fsp.writeFile(
		path.join(manifest.quarantine, "result.json"),
		JSON.stringify({ records, totalBytes: Number(totalBytes) }),
		{ encoding: "utf8", flag: "wx", mode: 0o600 },
	);
}

(async () => {
	const manifest = JSON.parse(await fsp.readFile(process.argv[1], "utf8"));
	await capture(manifest);
	process.stdout.write("ISO_CAPTURE_OK\n");
})().catch((error) => {
	process.stderr.write("ISO capture rejected candidate bytes: " + String(error && error.message || error) + "\n");
	process.exitCode = 1;
});
`;

function parseCaptureResult(
	value: unknown,
	expectedPaths: string[],
	maximumBytes: number,
	maximumFileBytes: number,
	allowSymbolicLinks: boolean,
): FrozenCandidateFile[] {
	if (typeof value !== "object" || value === null || !("records" in value) || !Array.isArray(value.records)) {
		throw new CandidatePolicyError("Trusted candidate capture produced a malformed result.");
	}
	const records: FrozenCandidateFile[] = value.records.map((record: unknown) => {
		if (
			typeof record !== "object" ||
			record === null ||
			!("path" in record) ||
			typeof record.path !== "string" ||
			!("deleted" in record) ||
			typeof record.deleted !== "boolean" ||
			!("mode" in record) ||
			(record.mode !== "100644" && record.mode !== "100755" && (!allowSymbolicLinks || record.mode !== "120000")) ||
			!("size" in record) ||
			typeof record.size !== "number" ||
			!Number.isSafeInteger(record.size) ||
			record.size < 0
		) {
			throw new CandidatePolicyError("Trusted candidate capture produced a malformed file record.");
		}
		const blob = "blob" in record && typeof record.blob === "string" ? record.blob : undefined;
		const digest = "digest" in record && typeof record.digest === "string" ? record.digest : undefined;
		if (
			(record.deleted && (blob !== undefined || digest !== undefined)) ||
			(!record.deleted && (!/^blob-\d{6}$/u.test(blob ?? "") || !/^[a-f0-9]{64}$/u.test(digest ?? "")))
		) {
			throw new CandidatePolicyError("Trusted candidate capture produced malformed blob provenance.");
		}
		return {
			path: record.path,
			deleted: record.deleted,
			mode: record.mode,
			size: record.size,
			...(blob === undefined ? {} : { blob }),
			...(digest === undefined ? {} : { digest }),
		};
	});
	if (
		records.length !== expectedPaths.length ||
		records.some((record, index) => record.path !== expectedPaths[index]) ||
		records.some((record, index) => !record.deleted && record.blob !== `blob-${String(index).padStart(6, "0")}`) ||
		records.some((record) => (record.deleted && record.size !== 0) || record.size > maximumFileBytes) ||
		records.reduce((total, record) => total + record.size, 0) > maximumBytes
	) {
		throw new CandidatePolicyError("Trusted candidate capture did not match the bounded candidate path set.");
	}
	return records;
}

async function captureCandidateFiles(options: {
	repoRoot: string;
	worktree: string;
	quarantine: string;
	paths: string[];
	protectedPaths: string[];
	maxBytes: number;
	maxFileBytes: number;
	allowSymbolicLinks?: boolean;
	denyControlRepo?: boolean;
	protectFrozenDependencyPaths?: boolean;
}): Promise<FrozenCandidateFile[]> {
	const manifestPath = join(options.quarantine, "manifest.json");
	await writeFile(
		manifestPath,
		JSON.stringify({
			worktree: options.worktree,
			quarantine: options.quarantine,
			paths: options.paths,
			maxBytes: options.maxBytes,
			maxFileBytes: options.maxFileBytes,
			allowSymbolicLinks: options.allowSymbolicLinks ?? false,
		}),
		{ encoding: "utf8", mode: 0o600 },
	);
	const operations = await createSandboxedBashOperations({
		cwd: options.worktree,
		repoRoot: options.worktree,
		writablePaths: [options.quarantine],
		denyReadPaths: [
			...(options.denyControlRepo === false ? [] : [options.repoRoot]),
			join(options.worktree, ".git"),
			join(options.worktree, ".iso"),
			join(options.worktree, DEPENDENCY_ROOT),
			...(options.protectFrozenDependencyPaths === false
				? []
				: FROZEN_DEPENDENCY_PATHS.map((path) => join(options.worktree, path))),
			...options.protectedPaths.map((path) => join(options.worktree, path)),
		],
	});
	const output: Buffer[] = [];
	let outputBytes = 0;
	const controller = new AbortController();
	try {
		const result = await operations.exec(
			`exec ${shellArgument(process.execPath)} -e ${shellArgument(CAPTURE_HELPER_SOURCE)} ${shellArgument(manifestPath)}`,
			options.worktree,
			{
				timeout: 30,
				signal: controller.signal,
				onData: (chunk) => {
					outputBytes += chunk.byteLength;
					if (outputBytes > 64 * 1024) {
						controller.abort();
						return;
					}
					output.push(chunk);
				},
			},
		);
		const outputText = Buffer.concat(output).toString("utf8");
		if (result.exitCode !== 0 || outputBytes > 64 * 1024 || !outputText.includes("ISO_CAPTURE_OK")) {
			throw new CandidatePolicyError(
				`Trusted candidate capture failed${outputText.trim() ? `: ${outputText.trim()}` : "."}`,
			);
		}
	} finally {
		await operations.dispose();
	}
	const parsed: unknown = JSON.parse(await readFile(join(options.quarantine, "result.json"), "utf8"));
	const records = parseCaptureResult(
		parsed,
		options.paths,
		options.maxBytes,
		options.maxFileBytes,
		options.allowSymbolicLinks ?? false,
	);
	for (const record of records) {
		if (record.deleted) {
			continue;
		}
		if (record.blob === undefined || record.digest === undefined) {
			throw new CandidatePolicyError("Trusted candidate capture omitted blob provenance.");
		}
		const blobPath = join(options.quarantine, "blobs", record.blob);
		await chmod(blobPath, 0o400);
		const metadata = await lstat(blobPath);
		const digest = createHash("sha256")
			.update(await readFile(blobPath))
			.digest("hex");
		if (
			!metadata.isFile() ||
			metadata.isSymbolicLink() ||
			metadata.size !== record.size ||
			metadata.nlink !== 1 ||
			(metadata.mode & 0o222) !== 0 ||
			digest !== record.digest
		) {
			throw new CandidatePolicyError("Trusted candidate quarantine changed before Git snapshotting.");
		}
	}
	return records;
}

async function assertCapturedFilesStillCurrent(options: {
	repoRoot: string;
	worktree: string;
	paths: string[];
	expected: FrozenCandidateFile[];
	maxBytes: number;
	maxFileBytes: number;
}): Promise<void> {
	if (options.paths.length === 0) {
		return;
	}
	const verificationRoot = await mkdtemp(join(tmpdir(), "iso-source-verify-"));
	try {
		const current = await captureCandidateFiles({
			repoRoot: options.repoRoot,
			worktree: options.worktree,
			quarantine: verificationRoot,
			paths: options.paths,
			protectedPaths: [],
			maxBytes: options.maxBytes,
			maxFileBytes: options.maxFileBytes,
			allowSymbolicLinks: true,
			denyControlRepo: false,
			protectFrozenDependencyPaths: false,
		});
		if (
			current.length !== options.expected.length ||
			current.some((record, index) => {
				const expected = options.expected[index];
				return (
					expected === undefined ||
					record.path !== expected.path ||
					record.deleted !== expected.deleted ||
					record.mode !== expected.mode ||
					record.size !== expected.size ||
					record.digest !== expected.digest
				);
			})
		) {
			throw new SourceSnapshotPolicyError(
				"Repository source bytes, mode, or symbolic-link target changed before snapshot publication.",
			);
		}
	} finally {
		await rm(verificationRoot, { force: true, recursive: true });
	}
}

function parseGitPathList(output: string): string[] {
	return output
		.split("\0")
		.filter(Boolean)
		.map((path) => {
			if (path.includes("\uFFFD")) {
				throw new CandidatePolicyError("ISO only accepts UTF-8 repository paths without replacement characters.");
			}
			if (/[\u0000-\u001f\u007f]/u.test(path)) {
				throw new CandidatePolicyError("ISO does not accept repository paths containing control characters.");
			}
			const normalized = normalizeRepositoryRelativePath(path, "Candidate repository path");
			if (normalized !== path) {
				throw new CandidatePolicyError(`Candidate repository path was not canonical: ${path}`);
			}
			return normalized;
		});
}

function isSourceSnapshotExcluded(path: string): boolean {
	const components = path.split("/");
	return (
		components[0] === ".iso" ||
		components.includes(".git") ||
		components.includes(DEPENDENCY_ROOT) ||
		components.includes(DEPENDENCY_VIEW_MARKER)
	);
}

function validateSourceSnapshotLimits(options: {
	maxChangedPaths: number;
	maxSourceBytes: number;
	maxSourceFileBytes: number;
}): void {
	for (const [label, value] of [
		["maxChangedPaths", options.maxChangedPaths],
		["maxSourceBytes", options.maxSourceBytes],
		["maxSourceFileBytes", options.maxSourceFileBytes],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error(`${label} must be a positive safe integer.`);
		}
	}
	if (options.maxSourceFileBytes > options.maxSourceBytes) {
		throw new Error("maxSourceFileBytes must not exceed maxSourceBytes.");
	}
}

async function createImmutableSourceSnapshotRef(repoRoot: string, commit: string): Promise<string> {
	if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(commit)) {
		throw new SourceSnapshotPolicyError("Git returned a malformed source snapshot commit ID.");
	}
	const ref = `refs/iso/source-snapshots/${commit}`;
	try {
		// An empty expected old object is Git's create-only update-ref form.
		await run("git", ["update-ref", ref, commit, ""], repoRoot, {}, SNAPSHOT_GIT_OPTIONS);
	} catch (error) {
		let existing: string;
		try {
			existing = await resolveCommit(repoRoot, ref);
		} catch {
			throw error;
		}
		if (existing !== commit) {
			throw new SourceSnapshotPolicyError(`Immutable source snapshot ref already points elsewhere: ${ref}`);
		}
	}
	return ref;
}

export async function pinSourceSnapshot(repoRoot: string, commit: string): Promise<string> {
	repoRoot = await realpath(resolve(repoRoot));
	const resolved = await resolveCommit(repoRoot, commit);
	if (resolved !== commit) {
		throw new SourceSnapshotPolicyError("Source snapshot commit did not resolve to its exact object ID.");
	}
	return createImmutableSourceSnapshotRef(repoRoot, commit);
}

export async function sourceSnapshotChangedPaths(
	repoRoot: string,
	headCommit: string,
	sourceCommit: string,
): Promise<string[]> {
	repoRoot = await realpath(resolve(repoRoot));
	const output = await run(
		"git",
		["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", headCommit, sourceCommit, "--"],
		repoRoot,
		{},
		SNAPSHOT_GIT_OPTIONS,
	);
	return parseGitPathList(output.stdout)
		.filter((path) => !isSourceSnapshotExcluded(path))
		.sort();
}

/**
 * Freeze the actual bytes in the current checkout into an internal commit.
 *
 * Staging is deliberately not treated as a second source of bytes: the index is
 * consulted only so Git can discover tracked changes, while every admitted path
 * is copied from the worktree through the no-follow quarantine. The caller's
 * index, branch and worktree are never updated. A create-only private ref keeps
 * the resulting commit reachable until the campaign explicitly removes it.
 *
 * The capture is race-hardened per file and rejects changed/untracked path-set
 * drift, but it is not a filesystem-wide atomic snapshot. Callers should quiesce
 * ambient writers when they require every file to represent one wall-clock instant.
 */
interface SourceSnapshotOptions {
	repoRoot: string;
	maxChangedPaths?: number;
	maxSourceBytes?: number;
	maxSourceFileBytes?: number;
	message?: string;
}

export function snapshotCurrentWorktree(
	options: SourceSnapshotOptions & { publishRef: false },
): Promise<EphemeralSourceSnapshot>;
export function snapshotCurrentWorktree(
	options: SourceSnapshotOptions & { publishRef?: true },
): Promise<SourceSnapshot>;
export async function snapshotCurrentWorktree(
	options: SourceSnapshotOptions & { publishRef?: boolean },
): Promise<SourceSnapshot | EphemeralSourceSnapshot> {
	const repoRoot = await realpath(resolve(options.repoRoot));
	const [baseCommit, originalHeadRef] = await Promise.all([
		resolveCommit(repoRoot),
		run("git", ["rev-parse", "--symbolic-full-name", "HEAD"], repoRoot, {}, SNAPSHOT_GIT_OPTIONS).then((result) =>
			result.stdout.trim(),
		),
	]);
	const maxChangedPaths = options.maxChangedPaths ?? 250;
	const maxSourceBytes = options.maxSourceBytes ?? DEFAULT_MAX_CANDIDATE_BYTES;
	const maxSourceFileBytes = options.maxSourceFileBytes ?? DEFAULT_MAX_CANDIDATE_FILE_BYTES;
	validateSourceSnapshotLimits({ maxChangedPaths, maxSourceBytes, maxSourceFileBytes });
	const message = options.message?.trim() || "ISO immutable source snapshot";
	if (message.includes("\0") || Buffer.byteLength(message) > 4 * 1024) {
		throw new Error("Source snapshot message must be at most 4096 bytes and contain no NUL.");
	}

	const [trackedOutput, untrackedOutput, basePathOutput, baseTree] = await Promise.all([
		run(
			"git",
			["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", baseCommit, "--"],
			repoRoot,
			{},
			SNAPSHOT_GIT_OPTIONS,
		),
		run("git", ["ls-files", "--others", "--exclude-standard", "-z"], repoRoot, {}, SNAPSHOT_GIT_OPTIONS),
		run(
			"git",
			["ls-tree", "-r", "--name-only", "-z", baseCommit, "--"],
			repoRoot,
			{},
			{ outputLimitBytes: 16 * 1024 * 1024, timeoutMs: 30_000 },
		),
		run("git", ["rev-parse", `${baseCommit}^{tree}`], repoRoot, {}, SNAPSHOT_GIT_OPTIONS).then((result) =>
			result.stdout.trim(),
		),
	]);
	const discoveredPaths = [
		...new Set([...parseGitPathList(trackedOutput.stdout), ...parseGitPathList(untrackedOutput.stdout)]),
	].sort();
	const basePaths = parseGitPathList(basePathOutput.stdout);
	const admittedPaths = discoveredPaths.filter((path) => !isSourceSnapshotExcluded(path));
	const excludedPaths = [
		...new Set([...discoveredPaths.filter(isSourceSnapshotExcluded), ...basePaths.filter(isSourceSnapshotExcluded)]),
	].sort();
	const excludedBasePaths = basePaths.filter(isSourceSnapshotExcluded);
	const indexMutationPaths = [...new Set([...admittedPaths, ...excludedBasePaths])].sort();
	const changedPathBytes = indexMutationPaths.reduce((total, path) => total + Buffer.byteLength(path), 0);
	if (indexMutationPaths.some((path) => Buffer.byteLength(path) > 4 * 1024) || changedPathBytes > 256 * 1024) {
		throw new SourceSnapshotPolicyError("Source repository paths exceed ISO's bounded path budget.");
	}
	if (indexMutationPaths.length > maxChangedPaths) {
		throw new SourceSnapshotPolicyError(
			`Source snapshot requires ${indexMutationPaths.length} path mutations; limit is ${maxChangedPaths}.`,
		);
	}
	const sensitive = admittedPaths.filter((path) => SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path)));
	if (sensitive.length > 0) {
		throw new SourceSnapshotPolicyError(
			`Source snapshot rejected potentially sensitive changed files: ${sensitive.join(", ")}`,
		);
	}

	const quarantine = await mkdtemp(join(tmpdir(), "iso-source-freeze-"));
	let indexDirectory: string | undefined;
	let frozenFiles: FrozenCandidateFile[] = [];
	let tree = baseTree;
	let commit = baseCommit;
	let totalBytes = 0;
	try {
		indexDirectory = await mkdtemp(join(tmpdir(), "iso-source-index-"));
		const gitEnvironment = {
			GIT_AUTHOR_EMAIL: "iso@localhost",
			GIT_AUTHOR_NAME: "ISO Research",
			GIT_COMMITTER_EMAIL: "iso@localhost",
			GIT_COMMITTER_NAME: "ISO Research",
			GIT_INDEX_FILE: join(indexDirectory, "source.index"),
		};
		frozenFiles =
			admittedPaths.length === 0
				? []
				: await captureCandidateFiles({
						repoRoot,
						worktree: repoRoot,
						quarantine,
						paths: admittedPaths,
						protectedPaths: [],
						maxBytes: maxSourceBytes,
						maxFileBytes: maxSourceFileBytes,
						allowSymbolicLinks: true,
						denyControlRepo: false,
						protectFrozenDependencyPaths: false,
					});
		totalBytes = frozenFiles.reduce((total, file) => total + file.size, 0);
		await run("git", ["read-tree", baseCommit], repoRoot, gitEnvironment, SNAPSHOT_GIT_OPTIONS);
		for (const path of excludedBasePaths) {
			await run(
				"git",
				["update-index", "--force-remove", "--", path],
				repoRoot,
				gitEnvironment,
				SNAPSHOT_GIT_OPTIONS,
			);
		}
		for (const [index, path] of admittedPaths.entries()) {
			const frozen = frozenFiles[index];
			if (frozen === undefined || frozen.path !== path) {
				throw new SourceSnapshotPolicyError("Trusted source quarantine path order changed.");
			}
			if (frozen.deleted) {
				await run(
					"git",
					["update-index", "--force-remove", "--", path],
					repoRoot,
					gitEnvironment,
					SNAPSHOT_GIT_OPTIONS,
				);
				continue;
			}
			if (frozen.blob === undefined) {
				throw new SourceSnapshotPolicyError("Trusted source quarantine omitted a blob mapping.");
			}
			const object = (
				await run(
					"git",
					["hash-object", "-w", "--no-filters", "--", join(quarantine, "blobs", frozen.blob)],
					repoRoot,
					gitEnvironment,
					SNAPSHOT_GIT_OPTIONS,
				)
			).stdout.trim();
			await run(
				"git",
				["update-index", "--add", "--cacheinfo", frozen.mode, object, path],
				repoRoot,
				gitEnvironment,
				SNAPSHOT_GIT_OPTIONS,
			);
		}
		tree = (await run("git", ["write-tree"], repoRoot, gitEnvironment, SNAPSHOT_GIT_OPTIONS)).stdout.trim();
		if (tree !== baseTree) {
			commit = (
				await run(
					"git",
					["commit-tree", tree, "-p", baseCommit, "-m", message],
					repoRoot,
					gitEnvironment,
					SNAPSHOT_GIT_OPTIONS,
				)
			).stdout.trim();
		}
	} finally {
		await Promise.all([
			indexDirectory === undefined ? Promise.resolve() : rm(indexDirectory, { force: true, recursive: true }),
			rm(quarantine, { force: true, recursive: true }),
		]);
	}

	const [currentHead, currentHeadRef, finalPathOutput, finalTreePathOutput, finalTrackedOutput, finalUntrackedOutput] =
		await Promise.all([
			resolveCommit(repoRoot),
			run("git", ["rev-parse", "--symbolic-full-name", "HEAD"], repoRoot, {}, SNAPSHOT_GIT_OPTIONS).then((result) =>
				result.stdout.trim(),
			),
			run(
				"git",
				["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", baseCommit, commit, "--"],
				repoRoot,
				{},
				SNAPSHOT_GIT_OPTIONS,
			),
			run(
				"git",
				["ls-tree", "-r", "--name-only", "-z", commit, "--"],
				repoRoot,
				{},
				{ outputLimitBytes: 16 * 1024 * 1024, timeoutMs: 30_000 },
			),
			run(
				"git",
				["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", baseCommit, "--"],
				repoRoot,
				{},
				SNAPSHOT_GIT_OPTIONS,
			),
			run("git", ["ls-files", "--others", "--exclude-standard", "-z"], repoRoot, {}, SNAPSHOT_GIT_OPTIONS),
		]);
	if (currentHead !== baseCommit || currentHeadRef !== originalHeadRef) {
		throw new SourceSnapshotPolicyError("Repository HEAD changed while ISO was freezing the source snapshot.");
	}
	const finalDiscoveredPaths = [
		...new Set([...parseGitPathList(finalTrackedOutput.stdout), ...parseGitPathList(finalUntrackedOutput.stdout)]),
	].sort();
	if (
		finalDiscoveredPaths.length !== discoveredPaths.length ||
		finalDiscoveredPaths.some((path, index) => path !== discoveredPaths[index])
	) {
		throw new SourceSnapshotPolicyError(
			"Repository changed or untracked path set drifted while ISO was freezing the source snapshot.",
		);
	}
	const finalDiffPaths = parseGitPathList(finalPathOutput.stdout);
	const changedPaths = finalDiffPaths.filter((path) => !isSourceSnapshotExcluded(path)).sort();
	if (changedPaths.some((path) => !admittedPaths.includes(path))) {
		throw new SourceSnapshotPolicyError("Source snapshot contains a path outside the admitted worktree change set.");
	}
	const leakedExcludedPaths = parseGitPathList(finalTreePathOutput.stdout).filter(isSourceSnapshotExcluded);
	if (leakedExcludedPaths.length > 0) {
		throw new SourceSnapshotPolicyError(
			`Source snapshot retained excluded dependency/control paths: ${leakedExcludedPaths.join(", ")}`,
		);
	}
	await assertCapturedFilesStillCurrent({
		repoRoot,
		worktree: repoRoot,
		paths: admittedPaths,
		expected: frozenFiles,
		maxBytes: maxSourceBytes,
		maxFileBytes: maxSourceFileBytes,
	});
	const ref = options.publishRef === false ? undefined : await pinSourceSnapshot(repoRoot, commit);
	return {
		baseCommit,
		commit,
		tree,
		...(ref === undefined ? {} : { ref }),
		changedPaths,
		excludedPaths,
		totalBytes,
	};
}

export async function snapshotExperiment(options: {
	repoRoot: string;
	worktree: string;
	baseCommit: string;
	title: string;
	protectedPaths: string[];
	maxChangedPaths?: number;
	maxCandidateBytes?: number;
	maxCandidateFileBytes?: number;
}): Promise<CandidateSnapshot> {
	const repoRoot = await realpath(resolve(options.repoRoot));
	const worktree = await realpath(resolve(options.worktree));
	await removeReadonlyDependencyMounts(repoRoot, worktree);
	const expectedHead = await resolveCommit(worktree);
	const protectedPaths = options.protectedPaths.map((path) =>
		normalizeRepositoryRelativePath(path, "Protected evaluator path"),
	);
	const tracked = parseGitPathList(
		(
			await run(
				"git",
				["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", options.baseCommit, "--"],
				worktree,
				{},
				SNAPSHOT_GIT_OPTIONS,
			)
		).stdout,
	);
	const untracked = parseGitPathList(
		(await run("git", ["ls-files", "--others", "--exclude-standard", "-z"], worktree, {}, SNAPSHOT_GIT_OPTIONS))
			.stdout,
	);
	const changedPaths = [...new Set([...tracked, ...untracked])].sort();
	const changedPathBytes = changedPaths.reduce((total, path) => total + Buffer.byteLength(path), 0);
	if (changedPaths.some((path) => Buffer.byteLength(path) > 4 * 1024) || changedPathBytes > 256 * 1024) {
		throw new CandidatePolicyError("Candidate repository paths exceed ISO's bounded path budget.");
	}
	const maxChangedPaths = options.maxChangedPaths ?? 250;
	const maxCandidateBytes = options.maxCandidateBytes ?? DEFAULT_MAX_CANDIDATE_BYTES;
	const maxCandidateFileBytes = options.maxCandidateFileBytes ?? DEFAULT_MAX_CANDIDATE_FILE_BYTES;
	for (const [label, value] of [
		["maxChangedPaths", maxChangedPaths],
		["maxCandidateBytes", maxCandidateBytes],
		["maxCandidateFileBytes", maxCandidateFileBytes],
	] as const) {
		if (!Number.isSafeInteger(value) || value < 1) {
			throw new Error(`${label} must be a positive safe integer.`);
		}
	}
	if (maxCandidateFileBytes > maxCandidateBytes) {
		throw new Error("maxCandidateFileBytes must not exceed maxCandidateBytes.");
	}
	if (changedPaths.length > maxChangedPaths) {
		throw new CandidatePolicyError(
			`Policy rejected ${changedPaths.length} changed paths; limit is ${maxChangedPaths}.`,
		);
	}
	const sensitive = changedPaths.filter((path) => SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path)));
	if (sensitive.length > 0) {
		throw new CandidatePolicyError(`Policy rejected potentially sensitive files: ${sensitive.join(", ")}`);
	}
	const controlPlaneChanges = changedPaths.filter((path) =>
		CONTROL_PLANE_PATH_PATTERNS.some((pattern) => pattern.test(path)),
	);
	if (controlPlaneChanges.length > 0) {
		throw new CandidatePolicyError(`Candidate modified agent control-plane files: ${controlPlaneChanges.join(", ")}`);
	}
	const protectedChanges = changedPaths.filter(
		(path) =>
			path === ".iso" ||
			path.startsWith(".iso/") ||
			FROZEN_DEPENDENCY_PATHS.some((dependencyPath) => matchesProtectedPath(path, dependencyPath)) ||
			protectedPaths.some((protectedPath) => matchesProtectedPath(path, protectedPath)),
	);
	if (protectedChanges.length > 0) {
		throw new CandidatePolicyError(`Candidate modified protected evaluator inputs: ${protectedChanges.join(", ")}`);
	}
	const symbolicLinks: string[] = [];
	for (const path of changedPaths) {
		try {
			if ((await lstat(join(worktree, path))).isSymbolicLink()) {
				symbolicLinks.push(path);
			}
		} catch (error) {
			if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
				throw error;
			}
		}
	}
	if (symbolicLinks.length > 0) {
		throw new CandidatePolicyError(`Candidate introduced or modified symbolic links: ${symbolicLinks.join(", ")}`);
	}

	let commit = options.baseCommit;
	if (changedPaths.length > 0) {
		const basePaths = parseGitPathList(
			(
				await run(
					"git",
					["ls-tree", "-r", "--name-only", "-z", options.baseCommit, "--"],
					repoRoot,
					{},
					{ outputLimitBytes: 16 * 1024 * 1024, timeoutMs: 30_000 },
				)
			).stdout,
		);
		const captureProtectedPaths = [
			...new Set([
				...protectedPaths,
				...basePaths.filter(
					(path) =>
						SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path)) ||
						CONTROL_PLANE_PATH_PATTERNS.some((pattern) => pattern.test(path)),
				),
			]),
		];
		const quarantine = await mkdtemp(join(tmpdir(), "iso-candidate-freeze-"));
		let indexDirectory: string | undefined;
		try {
			indexDirectory = await mkdtemp(join(tmpdir(), "iso-index-"));
			const gitEnvironment = {
				GIT_AUTHOR_EMAIL: "iso@localhost",
				GIT_AUTHOR_NAME: "ISO Research",
				GIT_COMMITTER_EMAIL: "iso@localhost",
				GIT_COMMITTER_NAME: "ISO Research",
				GIT_INDEX_FILE: join(indexDirectory, "candidate.index"),
			};
			const frozenFiles = await captureCandidateFiles({
				repoRoot,
				worktree,
				quarantine,
				paths: changedPaths,
				protectedPaths: captureProtectedPaths,
				maxBytes: maxCandidateBytes,
				maxFileBytes: maxCandidateFileBytes,
			});
			await run("git", ["read-tree", options.baseCommit], repoRoot, gitEnvironment, SNAPSHOT_GIT_OPTIONS);
			for (const [index, path] of changedPaths.entries()) {
				const frozen = frozenFiles[index];
				if (frozen === undefined || frozen.path !== path) {
					throw new CandidatePolicyError("Trusted candidate quarantine path order changed.");
				}
				if (frozen.deleted) {
					await run(
						"git",
						["update-index", "--force-remove", "--", path],
						repoRoot,
						gitEnvironment,
						SNAPSHOT_GIT_OPTIONS,
					);
					continue;
				}
				if (frozen.blob === undefined) {
					throw new CandidatePolicyError("Trusted candidate quarantine omitted a blob mapping.");
				}
				const quarantinePath = join(quarantine, "blobs", frozen.blob);
				const object = (
					await run(
						"git",
						["hash-object", "-w", "--no-filters", "--", quarantinePath],
						repoRoot,
						gitEnvironment,
						SNAPSHOT_GIT_OPTIONS,
					)
				).stdout.trim();
				await run(
					"git",
					["update-index", "--add", "--cacheinfo", frozen.mode, object, path],
					repoRoot,
					gitEnvironment,
					SNAPSHOT_GIT_OPTIONS,
				);
			}
			const tree = (await run("git", ["write-tree"], repoRoot, gitEnvironment, SNAPSHOT_GIT_OPTIONS)).stdout.trim();
			commit = (
				await run(
					"git",
					["commit-tree", tree, "-p", options.baseCommit, "-m", `experiment: ${options.title}`],
					repoRoot,
					gitEnvironment,
					SNAPSHOT_GIT_OPTIONS,
				)
			).stdout.trim();
			await run("git", ["update-ref", "HEAD", commit, expectedHead], worktree, gitEnvironment, SNAPSHOT_GIT_OPTIONS);
		} finally {
			await Promise.all([
				indexDirectory === undefined ? Promise.resolve() : rm(indexDirectory, { force: true, recursive: true }),
				rm(quarantine, { force: true, recursive: true }),
			]);
		}
	}
	let mergeBase: string;
	try {
		mergeBase = (
			await run("git", ["merge-base", options.baseCommit, commit], repoRoot, {}, SNAPSHOT_GIT_OPTIONS)
		).stdout.trim();
	} catch {
		throw new CandidatePolicyError("Candidate history is not descended from the generation's frozen base commit.");
	}
	if (mergeBase !== options.baseCommit) {
		throw new CandidatePolicyError("Candidate history rewrote or escaped the generation's frozen base commit.");
	}
	const finalChangedPaths = (
		await run(
			"git",
			["diff", "--no-ext-diff", "--no-renames", "--name-only", "-z", options.baseCommit, commit, "--"],
			repoRoot,
			{},
			SNAPSHOT_GIT_OPTIONS,
		)
	).stdout;
	const diffStat =
		(
			await run(
				"git",
				["diff", "--no-ext-diff", "--stat", options.baseCommit, commit, "--"],
				repoRoot,
				{},
				SNAPSHOT_GIT_OPTIONS,
			)
		).stdout.trim() || "No code changes";
	const frozenChangedPaths = parseGitPathList(finalChangedPaths).sort();
	if (frozenChangedPaths.some((path) => !changedPaths.includes(path))) {
		throw new CandidatePolicyError("Frozen candidate commit contains a path outside the admitted change set.");
	}
	const invalidFrozenPaths = frozenChangedPaths.filter(
		(path) =>
			SENSITIVE_PATH_PATTERNS.some((pattern) => pattern.test(path)) ||
			CONTROL_PLANE_PATH_PATTERNS.some((pattern) => pattern.test(path)) ||
			path === ".iso" ||
			path.startsWith(".iso/") ||
			FROZEN_DEPENDENCY_PATHS.some((dependencyPath) => matchesProtectedPath(path, dependencyPath)) ||
			protectedPaths.some((protectedPath) => matchesProtectedPath(path, protectedPath)),
	);
	if (invalidFrozenPaths.length > 0) {
		throw new CandidatePolicyError(
			`Frozen candidate commit failed final path policy: ${invalidFrozenPaths.join(", ")}`,
		);
	}
	return { commit, diffStat, changedPaths: frozenChangedPaths };
}

export async function removeWorktree(repoRoot: string, worktree: string): Promise<void> {
	const registered = (await run("git", ["worktree", "list", "--porcelain"], repoRoot)).stdout
		.split(/\r?\n/u)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
	const target = await canonicalPathForComparison(worktree);
	let registeredTarget: string | undefined;
	for (const path of registered) {
		if ((await canonicalPathForComparison(path)) === target) {
			registeredTarget = path;
			break;
		}
	}
	if (registeredTarget !== undefined) {
		await run("git", ["worktree", "remove", "--force", registeredTarget], repoRoot);
	}
	await run("git", ["worktree", "prune"], repoRoot);
}

export async function removeIsoWorktrees(repoRoot: string): Promise<number> {
	const roots = await Promise.all(
		[isoWorktreeRoot(repoRoot), evaluatorControlWorktreeRoot(repoRoot)].map(canonicalPathForComparison),
	);
	const registeredPaths = (await run("git", ["worktree", "list", "--porcelain"], repoRoot)).stdout
		.split(/\r?\n/u)
		.filter((line) => line.startsWith("worktree "))
		.map((line) => line.slice("worktree ".length));
	const registered = (
		await Promise.all(
			registeredPaths.map(async (path) => ({
				canonical: await canonicalPathForComparison(path),
				path,
			})),
		)
	).filter((path) => {
		return roots.some((root) => {
			const pathFromRoot = relative(root, path.canonical);
			return pathFromRoot !== "" && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot);
		});
	});
	for (const { path } of registered) {
		await run("git", ["worktree", "remove", "--force", path], repoRoot);
	}
	await run("git", ["worktree", "prune"], repoRoot);
	return registered.length;
}

export async function evaluatorDigest(options: {
	repoRoot: string;
	controlCwd: string;
	command: string;
	protectedPaths: string[];
	sourceRoot?: string;
}): Promise<string> {
	const hash = createHash("sha256");
	hashField(hash, "command", options.command);
	const repositoryRoot = await realpath(resolve(options.repoRoot));
	const sourceRoot = options.sourceRoot === undefined ? repositoryRoot : await realpath(resolve(options.sourceRoot));
	const controlRoot = await realpath(resolve(options.controlCwd));
	const controlBase = options.sourceRoot === undefined ? repositoryRoot : sourceRoot;
	const controlFromRepository = relative(controlBase, controlRoot);
	if (
		controlFromRepository === ".." ||
		controlFromRepository.startsWith(`..${sep}`) ||
		isAbsolute(controlFromRepository)
	) {
		throw new EvaluatorIntegrityError("Evaluator control directory resolves outside the repository.");
	}
	hashField(hash, "control", controlFromRepository);
	hashField(hash, "node", process.version);
	hashField(hash, "platform", process.platform);
	hashField(hash, "architecture", process.arch);
	for (const dependencyPath of DEPENDENCY_DIGEST_PATHS) {
		const absolutePath = resolve(sourceRoot, dependencyPath);
		const entries = await collectIntegrityTree(absolutePath);
		if (entries.length === 0) {
			hashField(hash, "dependency-missing", dependencyPath);
			continue;
		}
		await hashIntegrityTree(hash, "dependency", sourceRoot, entries);
	}
	hashField(hash, "installed-dependencies", await installedDependenciesDigest(repositoryRoot));
	for (const rawProtectedPath of options.protectedPaths.slice().sort()) {
		const protectedPath = normalizeRepositoryRelativePath(rawProtectedPath, "Protected evaluator path");
		const protectedRoot = protectedPath.startsWith(".iso/") ? repositoryRoot : sourceRoot;
		const absolutePath = resolve(protectedRoot, protectedPath);
		const pathFromRepository = relative(protectedRoot, absolutePath);
		if (pathFromRepository === ".." || pathFromRepository.startsWith(`..${sep}`) || isAbsolute(pathFromRepository)) {
			throw new Error(`Protected path escapes the repository: ${protectedPath}`);
		}
		let current = protectedRoot;
		for (const component of pathFromRepository.split(sep).filter(Boolean)) {
			current = join(current, component);
			try {
				if ((await lstat(current)).isSymbolicLink()) {
					throw new EvaluatorIntegrityError(
						`Protected evaluator inputs may not traverse symbolic links: ${protectedPath}`,
					);
				}
			} catch (error) {
				if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
					break;
				}
				throw error;
			}
		}
		const entries = await collectIntegrityTree(absolutePath);
		if (entries.length === 0) {
			hashField(hash, "protected-missing", pathFromRepository);
			continue;
		}
		await hashIntegrityTree(hash, "protected", protectedRoot, entries);
	}
	return hash.digest("hex");
}

export async function assertEvaluatorDigest(
	expected: string,
	options: {
		repoRoot: string;
		controlCwd: string;
		command: string;
		protectedPaths: string[];
		sourceRoot?: string;
	},
): Promise<void> {
	const actual = await evaluatorDigest(options);
	if (actual !== expected) {
		throw new EvaluatorIntegrityError(
			"Evaluator integrity check failed: the frozen control harness changed after calibration.",
		);
	}
}
