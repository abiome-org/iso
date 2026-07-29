import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, rmSync, type Stats } from "node:fs";
import {
	access,
	chmod,
	lstat,
	mkdir,
	mkdtemp,
	open,
	readdir,
	readFile,
	realpath,
	rm,
	writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import {
	type BashOperations,
	createBashToolDefinition,
	createEditToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	type EditOperations,
	type ReadOperations,
	type WriteOperations,
} from "@earendil-works/pi-coding-agent";
import shellQuote from "shell-quote";

const SAFE_PATH =
	process.platform === "darwin"
		? `${dirname(process.execPath)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin`
		: `${dirname(process.execPath)}:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`;

const STRICT_NETWORK_CONFIG = {
	allowedDomains: [],
	deniedDomains: [],
	allowUnixSockets: [],
	allowAllUnixSockets: false,
	allowLocalBinding: false,
};

const INITIAL_SANDBOX_CONFIG: SandboxRuntimeConfig = {
	network: STRICT_NETWORK_CONFIG,
	filesystem: {
		denyRead: [],
		allowWrite: [],
		denyWrite: [],
		allowGitConfig: false,
	},
	enableWeakerNestedSandbox: false,
	allowPty: false,
	mandatoryDenySearchDepth: 10,
};

const DEFAULT_RUNTIME_WRITE_PATHS = [
	"/tmp/claude",
	"/private/tmp/claude",
	join(homedir(), ".npm", "_logs"),
	join(homedir(), ".claude", "debug"),
];

const COMMON_CREDENTIAL_PATHS = [
	join(homedir(), ".ssh"),
	join(homedir(), ".aws"),
	join(homedir(), ".azure"),
	join(homedir(), ".gnupg"),
	join(homedir(), ".kube"),
	join(homedir(), ".docker"),
	join(homedir(), ".terraform.d"),
	join(homedir(), ".codex"),
	join(homedir(), ".claude"),
	join(homedir(), ".pi"),
	join(homedir(), ".agents"),
	join(homedir(), ".openai"),
	join(homedir(), ".anthropic"),
	join(homedir(), ".config", "gcloud"),
	join(homedir(), ".config", "gh"),
	join(homedir(), ".config", "hub"),
	join(homedir(), ".config", "op"),
	join(homedir(), ".config", "1Password"),
	join(homedir(), ".config", "pip"),
	join(homedir(), ".config", "npm"),
	join(homedir(), ".local", "share", "keyrings"),
	join(homedir(), ".cargo", "credentials"),
	join(homedir(), ".cargo", "credentials.toml"),
	join(homedir(), ".npmrc"),
	join(homedir(), ".pypirc"),
	join(homedir(), ".netrc"),
	join(homedir(), ".git-credentials"),
	join(homedir(), "Library", "Keychains"),
	join(homedir(), "Library", "Application Support", "1Password"),
	join(homedir(), "Library", "Application Support", "Google", "Chrome", "Default", "Login Data"),
	"/var/run/docker.sock",
	"/run/docker.sock",
	"/proc/self/environ",
	"/proc/1/environ",
];

const SENSITIVE_WRITE_PATHS = [
	"/etc",
	"/usr",
	"/bin",
	"/sbin",
	"/System",
	"/Library",
	...COMMON_CREDENTIAL_PATHS,
	...DEFAULT_RUNTIME_WRITE_PATHS,
];

let initialization: Promise<void> | undefined;
let environmentMutationTail = Promise.resolve();
let exitCleanupRegistered = false;
const privateDirectories = new Set<string>();
const sandboxProcessGroups = new Set<number>();
const PROCESS_GROUP_REAP_TIMEOUT_MS = 2_000;
const PROCESS_GROUP_REAP_POLL_MS = 10;
const PROCESS_OUTPUT_DRAIN_TIMEOUT_MS = 5_000;
const FROZEN_EVALUATOR_PATH_PATTERN = /^\.iso\/evaluators\/frozen\/([a-f0-9]{64})\.mjs$/u;
const MAX_FROZEN_EVALUATOR_BYTES = 4 * 1024 * 1024;

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function processGroupExists(processGroupId: number): boolean {
	try {
		process.kill(-processGroupId, 0);
		return true;
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
			return false;
		}
		if (typeof error === "object" && error !== null && "code" in error && error.code === "EPERM") {
			return true;
		}
		throw new Error(`ISO cannot inspect sandbox process group ${processGroupId}: ${errorMessage(error)}`, {
			cause: error,
		});
	}
}

function killProcessGroupNow(processGroupId: number): void {
	try {
		process.kill(-processGroupId, "SIGKILL");
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH") {
			return;
		}
		throw new Error(`ISO cannot kill sandbox process group ${processGroupId}: ${errorMessage(error)}`, {
			cause: error,
		});
	}
}

async function killAndReapProcessGroup(processGroupId: number): Promise<void> {
	const deadline = Date.now() + PROCESS_GROUP_REAP_TIMEOUT_MS;
	while (processGroupExists(processGroupId)) {
		let signalError: unknown;
		try {
			killProcessGroupNow(processGroupId);
		} catch (error) {
			signalError = error;
		}
		if (Date.now() >= deadline) {
			throw new Error(
				`ISO could not reap sandbox process group ${processGroupId}${signalError === undefined ? "." : `: ${errorMessage(signalError)}`}`,
				signalError === undefined ? undefined : { cause: signalError },
			);
		}
		await new Promise<void>((resolveDelay) => {
			setTimeout(resolveDelay, PROCESS_GROUP_REAP_POLL_MS);
		});
	}
}

async function waitForProcessOutputDrain(close: Promise<void>, processGroupId: number): Promise<void> {
	let timeoutHandle: NodeJS.Timeout | undefined;
	try {
		await Promise.race([
			close,
			new Promise<never>((_resolve, reject) => {
				timeoutHandle = setTimeout(() => {
					reject(new Error(`ISO timed out draining output from sandbox process group ${processGroupId}.`));
				}, PROCESS_OUTPUT_DRAIN_TIMEOUT_MS);
			}),
		]);
	} finally {
		if (timeoutHandle) {
			clearTimeout(timeoutHandle);
		}
	}
}

function resolveExecutionTimeoutMs(timeout: number | undefined): number | undefined {
	if (timeout === undefined) {
		return undefined;
	}
	if (!Number.isFinite(timeout) || timeout <= 0 || timeout * 1_000 > 2_147_483_647) {
		throw new Error("Invalid timeout: must be a finite positive number of seconds no greater than 2147483.647");
	}
	return timeout * 1_000;
}

function darwinProcessLimit(): number {
	const userId = process.getuid?.();
	if (userId === undefined) {
		throw new Error("ISO cannot determine the current user for the macOS process limit.");
	}
	const processList = spawnSync("/bin/ps", ["-U", String(userId), "-o", "pid="], {
		encoding: "utf8",
		maxBuffer: 4 * 1024 * 1024,
	});
	if (processList.error || processList.status !== 0) {
		throw new Error(
			`ISO cannot count ambient macOS processes before setting a safe limit: ${processList.stderr || errorMessage(processList.error)}`,
			processList.error ? { cause: processList.error } : undefined,
		);
	}
	const ambientProcesses = processList.stdout.split(/\r?\n/u).filter((line) => line.trim().length > 0).length;
	if (ambientProcesses === 0) {
		throw new Error("ISO received an empty ambient macOS process count.");
	}

	const hardLimitResult = spawnSync("/bin/bash", ["-c", "ulimit -Hu"], {
		encoding: "utf8",
		env: { PATH: SAFE_PATH },
		maxBuffer: 1024,
	});
	if (hardLimitResult.error || hardLimitResult.status !== 0) {
		throw new Error(
			`ISO cannot read the inherited macOS process limit: ${hardLimitResult.stderr || errorMessage(hardLimitResult.error)}`,
			hardLimitResult.error ? { cause: hardLimitResult.error } : undefined,
		);
	}
	const hardLimitText = hardLimitResult.stdout.trim();
	const hardLimit =
		hardLimitText === "unlimited"
			? Number.POSITIVE_INFINITY
			: /^\d+$/u.test(hardLimitText)
				? Number.parseInt(hardLimitText, 10)
				: Number.NaN;
	if (!Number.isFinite(hardLimit) && hardLimit !== Number.POSITIVE_INFINITY) {
		throw new Error(`ISO received an invalid inherited macOS process limit: ${hardLimitText}`);
	}

	const processLimit = Math.min(hardLimit, Math.max(512, ambientProcesses + 256));
	if (processLimit - ambientProcesses < 32) {
		throw new Error(
			`ISO cannot reserve safe process headroom: ${ambientProcesses} processes are already running under a hard limit of ${hardLimitText}.`,
		);
	}
	return processLimit;
}

function resourceLimitPrefix(): string {
	const processLimit = process.platform === "darwin" ? darwinProcessLimit() : 512;
	return [
		"ulimit -St 1800 && ulimit -Ht 1800",
		"ulimit -Sn 256 && ulimit -Hn 256",
		`ulimit -Su ${processLimit} 2>/dev/null && ulimit -Hu ${processLimit} 2>/dev/null || true`,
		"ulimit -Sv 8388608 2>/dev/null && ulimit -Hv 8388608 2>/dev/null || true",
		"ulimit -Sf 4194304 && ulimit -Hf 4194304",
	].join("; ");
}

function isWithin(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(pathFromRoot !== ".." && !pathFromRoot.startsWith(`..${sep}`) && !isAbsolute(pathFromRoot))
	);
}

function pathsIntersect(left: string, right: string): boolean {
	return isWithin(left, right) || isWithin(right, left);
}

function darwinCredentialDenyPaths(readablePaths: readonly string[]): string[] {
	const home = resolve(homedir());
	return COMMON_CREDENTIAL_PATHS.filter((path) => {
		const absolute = resolve(path);
		return !isWithin(home, absolute) || readablePaths.some((readablePath) => pathsIntersect(absolute, readablePath));
	});
}

function darwinWriteDenyPaths(writablePaths: readonly string[]): string[] {
	return SENSITIVE_WRITE_PATHS.filter((path) => {
		const absolute = resolve(path);
		return writablePaths.some((writablePath) => pathsIntersect(absolute, resolve(writablePath)));
	});
}

function assertStrictManagerConfiguration(): void {
	const config = SandboxManager.getConfig();
	if (
		config === undefined ||
		config.network.allowedDomains.length !== 0 ||
		(config.network.allowUnixSockets?.length ?? 0) !== 0 ||
		config.network.allowAllUnixSockets === true ||
		config.network.allowLocalBinding === true ||
		config.enableWeakerNestedSandbox === true ||
		config.allowPty === true
	) {
		throw new Error("Sandbox runtime is not configured with ISO's fail-closed network and IPC policy.");
	}
}

async function initializeSandboxOnce(): Promise<void> {
	initialization ??= (async () => {
		if (process.platform !== "darwin" && process.platform !== "linux") {
			throw new Error(`ISO worker sandbox is unsupported on ${process.platform}.`);
		}
		if (!SandboxManager.checkDependencies()) {
			throw new Error(
				process.platform === "linux"
					? "ISO worker sandbox requires rg, bwrap, socat, and seccomp support."
					: "ISO worker sandbox requires rg and sandbox-exec.",
			);
		}
		await SandboxManager.initialize(INITIAL_SANDBOX_CONFIG);
		if (!SandboxManager.isSandboxingEnabled()) {
			throw new Error("Sandbox runtime initialized without enabling OS isolation.");
		}
		assertStrictManagerConfiguration();
	})();
	try {
		await initialization;
	} catch (error) {
		throw new Error(`ISO cannot start an unsandboxed process: ${errorMessage(error)}`, { cause: error });
	}
}

async function canonicalDirectory(path: string, label: string): Promise<string> {
	const canonical = await realpath(resolve(path));
	const metadata = await lstat(canonical);
	if (!metadata.isDirectory()) {
		throw new Error(`${label} is not a directory: ${path}`);
	}
	return canonical;
}

async function canonicalReadOnlyPath(path: string, label: string): Promise<string> {
	const absolute = resolve(path);
	const requestedMetadata = await lstat(absolute);
	if (requestedMetadata.isSymbolicLink() || (!requestedMetadata.isDirectory() && !requestedMetadata.isFile())) {
		throw new Error(`${label} must be a real regular file or directory: ${path}`);
	}
	const canonical = await realpath(absolute);
	const canonicalMetadata = await lstat(canonical);
	if (!canonicalMetadata.isDirectory() && !canonicalMetadata.isFile()) {
		throw new Error(`${label} resolved to an unsupported filesystem type: ${path}`);
	}
	return canonical;
}

function sameFileIdentity(left: Stats, right: Stats): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFileState(left: Stats, right: Stats): boolean {
	return (
		sameFileIdentity(left, right) &&
		left.mode === right.mode &&
		left.size === right.size &&
		left.mtimeMs === right.mtimeMs &&
		left.ctimeMs === right.ctimeMs &&
		left.nlink === right.nlink
	);
}

async function verifiedFrozenEvaluatorPath(repoRoot: string, path: string): Promise<string> {
	const absolute = resolve(path);
	const canonical = await canonicalReadOnlyPath(absolute, "Sandbox frozen evaluator");
	const pathFromRepository = relative(repoRoot, canonical).split(sep).join("/");
	const expectedDigest = FROZEN_EVALUATOR_PATH_PATTERN.exec(pathFromRepository)?.[1];
	if (expectedDigest === undefined) {
		throw new Error(`Sandbox read exception must be an exact frozen evaluator path: ${canonical}`);
	}

	const before = await lstat(canonical);
	if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) {
		throw new Error("Sandbox frozen evaluator must be a singly linked regular file.");
	}
	if (before.size > MAX_FROZEN_EVALUATOR_BYTES) {
		throw new Error(`Sandbox frozen evaluator exceeds ${MAX_FROZEN_EVALUATOR_BYTES} bytes.`);
	}
	const handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
	try {
		const opened = await handle.stat();
		if (!opened.isFile() || opened.nlink !== 1 || !sameFileIdentity(before, opened)) {
			throw new Error("Sandbox frozen evaluator changed identity while it was opened.");
		}
		const content = await handle.readFile();
		const after = await handle.stat();
		const finalPath = await lstat(canonical);
		if (
			content.byteLength !== after.size ||
			!sameStableFileState(opened, after) ||
			!sameFileIdentity(after, finalPath)
		) {
			throw new Error("Sandbox frozen evaluator changed while it was verified.");
		}
		if (createHash("sha256").update(content).digest("hex") !== expectedDigest) {
			throw new Error("Sandbox frozen evaluator failed content-address verification.");
		}
	} finally {
		await handle.close();
	}
	return canonical;
}

async function existingCanonicalPath(path: string): Promise<string[]> {
	const absolute = resolve(path);
	try {
		const canonical = await realpath(absolute);
		return canonical === absolute ? [absolute] : [absolute, canonical];
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return [absolute];
		}
		throw error;
	}
}

async function canonicalDenyPaths(paths: readonly string[]): Promise<string[]> {
	const resolved = await Promise.all(paths.map((path) => existingCanonicalPath(path)));
	return [...new Set(resolved.flat())].sort();
}

async function corridorDenyPaths(rootPath: string, readablePaths: readonly string[]): Promise<string[]> {
	let root: string;
	try {
		root = await realpath(resolve(rootPath));
	} catch {
		return [];
	}
	const allowed = (
		await Promise.all(
			readablePaths.map(async (path) => {
				try {
					return await realpath(resolve(path));
				} catch {
					return resolve(path);
				}
			}),
		)
	).filter((path) => isWithin(root, path));
	if (allowed.some((path) => path === root)) {
		return [];
	}
	const denied: string[] = [];
	const visit = async (directory: string, paths: string[]): Promise<void> => {
		const nextSegments = new Map<string, string[]>();
		for (const path of paths) {
			const pathFromDirectory = relative(directory, path);
			if (pathFromDirectory === "") {
				return;
			}
			const segment = pathFromDirectory.split(sep)[0];
			const entries = nextSegments.get(segment) ?? [];
			entries.push(path);
			nextSegments.set(segment, entries);
		}
		let entries: string[];
		try {
			entries = await readdir(directory);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!nextSegments.has(entry)) {
				denied.push(join(directory, entry));
			}
		}
		for (const [segment, pathsForSegment] of nextSegments) {
			const nextDirectory = join(directory, segment);
			if (!pathsForSegment.some((path) => path === nextDirectory)) {
				await visit(nextDirectory, pathsForSegment);
			}
		}
	};
	await visit(root, allowed);
	return denied;
}

async function hostPrivacyDenyPaths(readablePaths: readonly string[], privateDirectory: string): Promise<string[]> {
	const homeDenies = await corridorDenyPaths(homedir(), readablePaths);
	const tempDenies = await corridorDenyPaths(tmpdir(), [
		...readablePaths,
		privateDirectory,
		...DEFAULT_RUNTIME_WRITE_PATHS,
	]);
	return [...homeDenies, ...tempDenies];
}

interface PathPrivacyNode {
	readonly children: Map<string, PathPrivacyNode>;
	readableSubtree: boolean;
}

interface CharacterTrieNode {
	readonly children: Map<string, CharacterTrieNode>;
	terminal: boolean;
}

function createPathPrivacyNode(): PathPrivacyNode {
	return { children: new Map(), readableSubtree: false };
}

function createCharacterTrieNode(): CharacterTrieNode {
	return { children: new Map(), terminal: false };
}

function escapeRegexLiteral(value: string): string {
	return value.replace(/[\\^$.*+?()[\]{}|]/gu, "\\$&");
}

function escapeRegexCharacterClass(value: string): string {
	return value === "\\" || value === "[" || value === "]" ? `\\${value}` : value;
}

function disallowedSegmentAlternatives(allowedSegments: readonly string[]): string[] {
	if (allowedSegments.length === 0) {
		return ["[^/][^/]*"];
	}
	const root = createCharacterTrieNode();
	for (const segment of allowedSegments) {
		let node = root;
		for (const character of segment) {
			let child = node.children.get(character);
			if (child === undefined) {
				child = createCharacterTrieNode();
				node.children.set(character, child);
			}
			node = child;
		}
		node.terminal = true;
	}

	const alternatives: string[] = [];
	const visit = (node: CharacterTrieNode, prefix: string): void => {
		if (prefix.length > 0 && !node.terminal) {
			alternatives.push(prefix);
		}
		const children = [...node.children.entries()].sort(([left], [right]) => left.localeCompare(right));
		const childCharacters = children.map(([character]) => character);
		const excludedCharacters = [
			...childCharacters.filter((character) => character !== "-").map(escapeRegexCharacterClass),
			...(childCharacters.includes("-") ? ["-"] : []),
		].join("");
		alternatives.push(`${prefix}[^/${excludedCharacters}][^/]*`);
		for (const [character, child] of children) {
			visit(child, `${prefix}${escapeRegexLiteral(character)}`);
		}
	};
	visit(root, "");
	return alternatives;
}

function corridorExpressions(path: string, allowedSegments: readonly string[]): string[] {
	const escapedPath = escapeRegexLiteral(path);
	if (allowedSegments.length === 0) {
		return [`^${escapedPath}/.*$`];
	}
	const prefix = `^${escapedPath}/(`;
	const suffix = ")(/.*)?$";
	const maximumExpressionLength = 512;
	const expressions: string[] = [];
	let alternatives: string[] = [];
	for (const alternative of disallowedSegmentAlternatives(allowedSegments)) {
		const candidate = [...alternatives, alternative];
		if (`${prefix}${candidate.join("|")}${suffix}`.length > maximumExpressionLength) {
			if (alternatives.length === 0) {
				throw new Error(`ISO cannot encode a bounded macOS privacy corridor for ${path}.`);
			}
			expressions.push(`${prefix}${alternatives.join("|")}${suffix}`);
			alternatives = [alternative];
		} else {
			alternatives = candidate;
		}
	}
	if (alternatives.length > 0) {
		expressions.push(`${prefix}${alternatives.join("|")}${suffix}`);
	}
	return expressions;
}

async function privacyRulesForRoot(rootPath: string, readablePaths: readonly string[]): Promise<string[]> {
	const root = await realpath(resolve(rootPath));
	const canonicalReadablePaths = await Promise.all(
		readablePaths.map(async (path) => {
			try {
				return await realpath(resolve(path));
			} catch {
				return resolve(path);
			}
		}),
	);
	const trie = createPathPrivacyNode();
	for (const readablePath of canonicalReadablePaths) {
		if (!isWithin(root, readablePath)) {
			continue;
		}
		const pathFromRoot = relative(root, readablePath);
		if (pathFromRoot === "") {
			trie.readableSubtree = true;
			trie.children.clear();
			break;
		}
		let node = trie;
		for (const segment of pathFromRoot.split(sep)) {
			if (node.readableSubtree) {
				break;
			}
			let child = node.children.get(segment);
			if (child === undefined) {
				child = createPathPrivacyNode();
				node.children.set(segment, child);
			}
			node = child;
		}
		node.readableSubtree = true;
		node.children.clear();
	}
	if (trie.readableSubtree) {
		return [];
	}

	const rules: string[] = [];
	const visit = (node: PathPrivacyNode, path: string): void => {
		if (node.readableSubtree) {
			return;
		}
		const children = [...node.children.entries()].sort(([left], [right]) => left.localeCompare(right));
		for (const expression of corridorExpressions(
			path,
			children.map(([segment]) => segment),
		)) {
			rules.push(`(deny file-read* (regex ${JSON.stringify(expression)}))`);
		}
		for (const [segment, child] of children) {
			visit(child, join(path, segment));
		}
	};
	visit(trie, root);
	return rules;
}

async function darwinHostPrivacyRules(readablePaths: readonly string[], privateDirectory: string): Promise<string[]> {
	const homeRules = await privacyRulesForRoot(homedir(), readablePaths);
	const tempRules = await privacyRulesForRoot(tmpdir(), [
		...readablePaths,
		privateDirectory,
		...DEFAULT_RUNTIME_WRITE_PATHS,
	]);
	return [...homeRules, ...tempRules];
}

function globToSeatbeltRegex(globPattern: string): string {
	return (
		"^" +
		globPattern
			.replace(/[.^$+{}()|\\]/gu, "\\$&")
			.replace(/\[([^\]]*?)$/gu, "\\[$1")
			.replace(/\*\*\//gu, "__ISO_GLOBSTAR_SLASH__")
			.replace(/\*\*/gu, "__ISO_GLOBSTAR__")
			.replace(/\*/gu, "[^/]*")
			.replace(/\?/gu, "[^/]")
			.replace(/__ISO_GLOBSTAR_SLASH__/gu, "(.*/)?")
			.replace(/__ISO_GLOBSTAR__/gu, ".*") +
		"$"
	);
}

function normalizeDarwinSandboxPath(path: string): string {
	if (path === "/tmp" || path === "/var") {
		return `/private${path}`;
	}
	if (path.startsWith("/tmp/") || path.startsWith("/var/")) {
		return `/private${path}`;
	}
	return path;
}

function darwinReadDenyRule(path: string): string {
	const normalizedPath = normalizeDarwinSandboxPath(path).replace(/\/\*\*$/u, "");
	const containsGlob =
		normalizedPath.includes("*") ||
		normalizedPath.includes("?") ||
		normalizedPath.includes("[") ||
		normalizedPath.includes("]");
	return containsGlob
		? `(deny file-read* (regex ${JSON.stringify(globToSeatbeltRegex(normalizedPath))}))`
		: `(deny file-read* (subpath ${JSON.stringify(normalizedPath)}))`;
}

function darwinReadPolicyOverrides(
	readablePaths: readonly string[],
	denyReadPaths: readonly string[],
	readExceptions: readonly string[],
): string[] {
	const metadataAncestors = (paths: readonly string[]): string[] => [
		...new Set(
			paths.flatMap((path) => {
				const ancestors: string[] = [];
				let current = dirname(path);
				while (current !== dirname(current)) {
					ancestors.push(current);
					current = dirname(current);
				}
				return ancestors;
			}),
		),
	];
	const readable = [...new Set(readablePaths)].sort();
	const allowRules = readable.map((path) => `(allow file-read* (subpath ${JSON.stringify(path)}))`);
	const ancestorMetadataRules = metadataAncestors(readable)
		.sort()
		.map((path) => `(allow file-read-metadata (literal ${JSON.stringify(path)}))`);
	const denyRules = [...new Set(denyReadPaths)].sort().map(darwinReadDenyRule);
	const exceptionAncestorMetadataRules = metadataAncestors(readExceptions)
		.sort()
		.map((path) => `(allow file-read-metadata (literal ${JSON.stringify(path)}))`);
	const exceptionRules = [...new Set(readExceptions)]
		.sort()
		.flatMap((path) => [
			`(allow file-read* (literal ${JSON.stringify(path)}))`,
			`(allow file-read* (subpath ${JSON.stringify(path)}))`,
		]);
	// Seatbelt applies the last equally specific matching rule. Reassert the
	// readable corridors after their compact regex complements, then reassert
	// every explicit deny so protected files inside a readable tree stay hidden.
	// Narrow, trusted read exceptions come last so a frozen dependency snapshot
	// can remain visible beneath an otherwise hidden control-plane directory.
	return [...allowRules, ...ancestorMetadataRules, ...denyRules, ...exceptionAncestorMetadataRules, ...exceptionRules];
}

function registerPrivateDirectory(path: string): void {
	privateDirectories.add(path);
	if (exitCleanupRegistered) {
		return;
	}
	exitCleanupRegistered = true;
	process.once("exit", () => {
		for (const processGroupId of sandboxProcessGroups) {
			try {
				killProcessGroupNow(processGroupId);
			} catch {
				// Process exit is already best-effort; explicit dispose reports containment errors.
			}
		}
		for (const privateDirectory of privateDirectories) {
			try {
				rmSync(privateDirectory, { force: true, recursive: true });
			} catch {
				// Process exit is already best-effort; explicit dispose reports cleanup errors.
			}
		}
	});
}

async function createPrivateDirectory(): Promise<{
	root: string;
	home: string;
	temp: string;
}> {
	const root = await mkdtemp(join(tmpdir(), "iso-worker-"));
	await chmod(root, 0o700);
	const home = join(root, "home");
	const temp = join(root, "tmp");
	await Promise.all([mkdir(home, { mode: 0o700, recursive: true }), mkdir(temp, { mode: 0o700, recursive: true })]);
	registerPrivateDirectory(root);
	return { root, home, temp };
}

function minimalEnvironment(
	home: string,
	temp: string,
	additions: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
	const environment: NodeJS.ProcessEnv = {
		HOME: home,
		PATH: SAFE_PATH,
		SHELL:
			process.env.SHELL?.startsWith("/bin/") || process.env.SHELL?.startsWith("/usr/bin/")
				? process.env.SHELL
				: "/bin/bash",
		TMPDIR: temp,
	};
	for (const name of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
		const value = process.env[name];
		if (value !== undefined) {
			environment[name] = value;
		}
	}
	for (const [name, value] of Object.entries(additions)) {
		if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
			throw new Error(`Invalid sandbox environment variable name: ${name}`);
		}
		environment[name] = value;
	}
	return environment;
}

async function withPrivateTmpEnvironment<T>(temp: string, callback: () => Promise<T>): Promise<T> {
	let release: (() => void) | undefined;
	const predecessor = environmentMutationTail;
	environmentMutationTail = new Promise<void>((resolveMutation) => {
		release = resolveMutation;
	});
	await predecessor;
	const hadTmpdir = Object.hasOwn(process.env, "TMPDIR");
	const hadClaudeTmpdir = Object.hasOwn(process.env, "CLAUDE_TMPDIR");
	const previousTmpdir = process.env.TMPDIR;
	const previousClaudeTmpdir = process.env.CLAUDE_TMPDIR;
	process.env.TMPDIR = temp;
	process.env.CLAUDE_TMPDIR = temp;
	try {
		return await callback();
	} finally {
		if (hadTmpdir) {
			process.env.TMPDIR = previousTmpdir;
		} else {
			delete process.env.TMPDIR;
		}
		if (hadClaudeTmpdir) {
			process.env.CLAUDE_TMPDIR = previousClaudeTmpdir;
		} else {
			delete process.env.CLAUDE_TMPDIR;
		}
		release?.();
	}
}

interface MacOSSandboxInvocation {
	environmentArguments: string[];
	profile: string;
	shell: string;
}

function parseLiteralShellArguments(command: string): string[] {
	const arguments_: string[] = [];
	let argument = "";
	let argumentStarted = false;
	let quote: "single" | "double" | undefined;
	for (let index = 0; index < command.length; index += 1) {
		const character = command[index];
		if (character === undefined || character === "\0") {
			throw new Error("The sandbox command contains an invalid null byte.");
		}
		if (quote === "single") {
			if (character === "'") {
				quote = undefined;
			} else {
				argument += character;
			}
			continue;
		}
		if (quote === "double") {
			if (character === '"') {
				quote = undefined;
				continue;
			}
			if (character === "\\") {
				const escaped = command[index + 1];
				if (escaped === undefined || !'"\\$`!'.includes(escaped)) {
					throw new Error("The sandbox command contains an invalid double-quoted escape.");
				}
				argument += escaped;
				index += 1;
				continue;
			}
			if (character === "$" || character === "`" || character === "!") {
				throw new Error("The sandbox command contains an unescaped expansion.");
			}
			argument += character;
			continue;
		}
		if (/\s/u.test(character)) {
			if (argumentStarted) {
				arguments_.push(argument);
				argument = "";
				argumentStarted = false;
			}
			continue;
		}
		argumentStarted = true;
		if (character === "'") {
			quote = "single";
			continue;
		}
		if (character === '"') {
			quote = "double";
			continue;
		}
		if (character === "\\") {
			const escaped = command[index + 1];
			if (escaped === undefined || escaped === "\n" || escaped === "\r") {
				throw new Error("The sandbox command contains an invalid unquoted escape.");
			}
			argument += escaped;
			index += 1;
			continue;
		}
		if (/[#!"$&'()*,:;<=>?@[\\\]^`{|}~]/u.test(character)) {
			throw new Error("The sandbox command contains unquoted shell syntax.");
		}
		argument += character;
	}
	if (quote !== undefined) {
		throw new Error("The sandbox command contains an unterminated quote.");
	}
	if (argumentStarted) {
		arguments_.push(argument);
	}
	return arguments_;
}

function reopenLinuxReadExceptions(
	wrappedCommand: string,
	hiddenRoot: string,
	readExceptions: readonly string[],
): string {
	if (readExceptions.length === 0) {
		return wrappedCommand;
	}
	let parsedCommand: string[];
	try {
		parsedCommand = parseLiteralShellArguments(wrappedCommand);
	} catch (error) {
		throw new Error("ISO could not parse the Linux sandbox command emitted by the sandbox runtime.", {
			cause: error,
		});
	}
	const commandIndex = parsedCommand.lastIndexOf("--");
	if (
		parsedCommand[0] !== "bwrap" ||
		commandIndex < 1 ||
		!parsedCommand
			.slice(0, commandIndex)
			.some((argument, index, arguments_) => argument === "--tmpfs" && arguments_[index + 1] === hiddenRoot)
	) {
		throw new Error("ISO rejected a Linux sandbox command that did not mask the mutable repository.");
	}

	const ancestorDirectories = new Set<string>();
	for (const exception of readExceptions) {
		if (!isWithin(hiddenRoot, exception) || exception === hiddenRoot) {
			throw new Error(`ISO cannot reopen a read exception outside the hidden repository: ${exception}`);
		}
		let current = dirname(exception);
		while (current !== hiddenRoot) {
			if (!isWithin(hiddenRoot, current)) {
				throw new Error(`ISO cannot construct a Linux read corridor for ${exception}.`);
			}
			ancestorDirectories.add(current);
			current = dirname(current);
		}
	}
	const directoryArguments = [...ancestorDirectories]
		.sort((left, right) => {
			const depthDifference =
				relative(hiddenRoot, left).split(sep).length - relative(hiddenRoot, right).split(sep).length;
			return depthDifference === 0 ? left.localeCompare(right) : depthDifference;
		})
		.flatMap((directory) => ["--dir", directory]);
	const exceptionArguments = [...readExceptions].sort().flatMap((exception) => ["--ro-bind", exception, exception]);
	parsedCommand.splice(commandIndex, 0, ...directoryArguments, ...exceptionArguments);
	return shellQuote.quote(parsedCommand);
}

function parseMacOSSandboxInvocation(wrappedCommand: string, expectedCommand: string): MacOSSandboxInvocation {
	let parsedCommand: string[];
	try {
		parsedCommand = parseLiteralShellArguments(wrappedCommand);
	} catch (error) {
		throw new Error("ISO could not parse the macOS sandbox command emitted by the sandbox runtime.", {
			cause: error,
		});
	}

	const sandboxExecutableIndex = parsedCommand.indexOf("sandbox-exec", 1);
	if (
		parsedCommand[0] !== "env" ||
		sandboxExecutableIndex < 1 ||
		parsedCommand.length !== sandboxExecutableIndex + 6 ||
		parsedCommand[sandboxExecutableIndex + 1] !== "-p" ||
		parsedCommand[sandboxExecutableIndex + 4] !== "-c"
	) {
		throw new Error("ISO rejected an unexpected macOS sandbox command emitted by the sandbox runtime.");
	}
	const environmentArguments = parsedCommand.slice(1, sandboxExecutableIndex);
	if (!environmentArguments.every((argument) => /^[A-Za-z_][A-Za-z0-9_]*=.*$/u.test(argument))) {
		throw new Error("ISO rejected unexpected environment arguments in the macOS sandbox command.");
	}
	const profile = parsedCommand[sandboxExecutableIndex + 2];
	const shell = parsedCommand[sandboxExecutableIndex + 3];
	const command = parsedCommand[sandboxExecutableIndex + 5];
	if (profile === undefined || profile.length === 0 || shell === undefined || !isAbsolute(shell)) {
		throw new Error("ISO rejected an incomplete macOS sandbox command emitted by the sandbox runtime.");
	}
	if (command !== expectedCommand) {
		throw new Error("ISO rejected a macOS sandbox command whose payload did not match the requested command.");
	}
	return { environmentArguments, profile, shell };
}

async function withExternalizedMacOSSandboxCommand<T>(
	privateDirectory: string,
	wrappedCommand: string,
	expectedRuntimeCommand: string,
	requestedCommand: string,
	additionalProfileRules: readonly string[],
	signal: AbortSignal | undefined,
	callback: (command: string) => Promise<T>,
): Promise<T> {
	const invocation = parseMacOSSandboxInvocation(wrappedCommand, expectedRuntimeCommand);
	const invocationDirectory = await mkdtemp(join(privateDirectory, "invocation-"));
	await chmod(invocationDirectory, 0o700);
	try {
		const profilePath = join(invocationDirectory, "sandbox.sb");
		const commandPath = join(invocationDirectory, "command.sh");
		const profile =
			additionalProfileRules.length === 0
				? invocation.profile
				: `${invocation.profile}\n\n; ISO host privacy corridors\n${additionalProfileRules.join("\n")}\n`;
		await Promise.all([
			writeFile(profilePath, profile, { encoding: "utf8", flag: "wx", mode: 0o600 }),
			writeFile(commandPath, requestedCommand, { encoding: "utf8", flag: "wx", mode: 0o600 }),
		]);
		await Promise.all([chmod(profilePath, 0o600), chmod(commandPath, 0o600)]);
		if (signal?.aborted) {
			throw new Error("aborted");
		}

		// Keep the runtime's `shell -c` semantics while moving the large command out
		// of argv. The launcher contains only the private command-file path.
		const sourceCommand = `. ${shellQuote.quote([commandPath])}`;
		const externalizedCommand = shellQuote.quote([
			"env",
			...invocation.environmentArguments,
			"sandbox-exec",
			"-f",
			profilePath,
			invocation.shell,
			"-c",
			sourceCommand,
		]);
		return await callback(externalizedCommand);
	} finally {
		await rm(invocationDirectory, { force: true, recursive: true });
	}
}

async function executeInIsolatedProcessGroup(
	command: string,
	cwd: string,
	options: {
		onData: (data: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number;
		env: NodeJS.ProcessEnv;
	},
	activeProcessGroups: Set<number>,
): Promise<{ exitCode: number | null }> {
	if (process.platform !== "darwin" && process.platform !== "linux") {
		throw new Error(`ISO process-group containment is unsupported on ${process.platform}.`);
	}
	const timeoutMs = resolveExecutionTimeoutMs(options.timeout);
	if (options.signal?.aborted) {
		throw new Error("aborted");
	}

	const child = spawn("/bin/bash", ["-c", command], {
		cwd,
		detached: true,
		env: options.env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
	});
	child.stdout?.on("data", options.onData);
	child.stderr?.on("data", options.onData);
	const exit = new Promise<number | null>((resolveExit, rejectExit) => {
		child.once("error", rejectExit);
		child.once("exit", resolveExit);
	});
	const close = new Promise<void>((resolveClose) => {
		child.once("close", () => resolveClose());
	});
	const processGroupId = child.pid;
	if (processGroupId === undefined) {
		try {
			await exit;
		} catch (error) {
			throw new Error(`ISO could not create a sandbox process group: ${errorMessage(error)}`, { cause: error });
		} finally {
			child.stdout?.destroy();
			child.stderr?.destroy();
		}
		throw new Error("ISO spawned a sandbox command without a process-group identifier.");
	}

	activeProcessGroups.add(processGroupId);
	sandboxProcessGroups.add(processGroupId);
	let timedOut = false;
	let timeoutHandle: NodeJS.Timeout | undefined;
	const forceKill = (): void => {
		try {
			killProcessGroupNow(processGroupId);
		} catch {
			// The final cleanup retries and verifies that the group is actually gone.
		}
	};
	const onAbort = (): void => {
		forceKill();
	};

	if (timeoutMs !== undefined) {
		timeoutHandle = setTimeout(() => {
			timedOut = true;
			forceKill();
		}, timeoutMs);
	}
	if (options.signal) {
		if (options.signal.aborted) {
			onAbort();
		} else {
			options.signal.addEventListener("abort", onAbort, { once: true });
		}
	}

	let executionOutcome:
		| { ok: true; exitCode: number | null }
		| {
				ok: false;
				error: unknown;
		  };
	try {
		const exitCode = await exit;
		if (options.signal?.aborted) {
			throw new Error("aborted");
		}
		if (timedOut) {
			throw new Error(`timeout:${options.timeout}`);
		}
		executionOutcome = { ok: true, exitCode };
	} catch (error) {
		executionOutcome = { ok: false, error };
	}

	if (timeoutHandle) {
		clearTimeout(timeoutHandle);
	}
	options.signal?.removeEventListener("abort", onAbort);
	let processGroupReaped = false;
	const cleanupFailures: unknown[] = [];
	try {
		await killAndReapProcessGroup(processGroupId);
		processGroupReaped = true;
	} catch (error) {
		cleanupFailures.push(error);
	}
	try {
		await waitForProcessOutputDrain(close, processGroupId);
	} catch (error) {
		cleanupFailures.push(error);
	}
	if (processGroupReaped) {
		activeProcessGroups.delete(processGroupId);
		sandboxProcessGroups.delete(processGroupId);
	}
	child.stdout?.destroy();
	child.stderr?.destroy();
	if (cleanupFailures.length > 0) {
		throw new AggregateError(
			cleanupFailures,
			`ISO could not cleanly finish sandbox process group ${processGroupId}: ${cleanupFailures.map(errorMessage).join("; ")}`,
		);
	}
	if (!executionOutcome.ok) {
		throw executionOutcome.error;
	}
	return { exitCode: executionOutcome.exitCode };
}

export interface SandboxedBashOperationsOptions {
	/** Directory in which the command executes. This path is readable, but is not implicitly writable. */
	cwd: string;
	/** Mutable control repository used only for exact, verified external artifacts. */
	repoRoot: string;
	/**
	 * Detached source-pinned checkout that contains cwd. When present, repoRoot
	 * is completely hidden except for the verified readOnlyPaths and dependency
	 * snapshot, and this source root is kept read-only.
	 */
	sourceRoot?: string;
	/** Exact disposable directories the command may modify. */
	writablePaths: string[];
	/**
	 * Exact content-addressed frozen evaluator file readable beneath the hidden
	 * mutable repository. The path and SHA-256 digest are verified before use.
	 */
	readOnlyPaths?: string[];
	/** Additional host paths hidden from the command. Common credential locations are always hidden. */
	denyReadPaths?: string[];
	/** Explicit non-secret variables added to the otherwise scrubbed process environment. */
	environment?: Readonly<Record<string, string>>;
}

export interface SandboxedBashOperations extends BashOperations {
	readonly privateDirectory: string;
	dispose(): Promise<void>;
}

/**
 * Build an OS-enforced shell boundary for workers and evaluators.
 *
 * The sandbox runtime is process-global and initialized exactly once. Each call gets a
 * unique HOME/TMPDIR and a per-command filesystem policy. An unavailable or weakened
 * sandbox is an error; commands are never run as an unsandboxed fallback.
 */
export async function createSandboxedBashOperations(
	options: SandboxedBashOperationsOptions,
): Promise<SandboxedBashOperations> {
	await initializeSandboxOnce();
	const commandCwd = await canonicalDirectory(options.cwd, "Sandbox command cwd");
	const repoRoot = await canonicalDirectory(options.repoRoot, "Sandbox repository root");
	const sourceRoot =
		options.sourceRoot === undefined
			? undefined
			: await canonicalDirectory(options.sourceRoot, "Sandbox source checkout root");
	// A caller that omits sourceRoot while running in a disjoint checkout must
	// not regain broad access to the mutable repository. Hide the repository as
	// one stable boundary and reopen only verified content-addressed artifacts.
	const repositoryIsDetached =
		sourceRoot !== undefined || (!isWithin(repoRoot, commandCwd) && !isWithin(commandCwd, repoRoot));
	await assertNodeOnlyWorkerLayout(repoRoot, sourceRoot ?? commandCwd);
	const dependencySnapshotRoot = await workerDependencySnapshotRoot(
		repoRoot,
		sourceRoot ?? commandCwd,
		sourceRoot !== undefined,
	);
	const writablePaths = await Promise.all(
		options.writablePaths.map((path) => canonicalDirectory(path, "Sandbox writable path")),
	);
	const dependencyReadExceptions =
		dependencySnapshotRoot === undefined
			? []
			: [await canonicalDirectory(dependencySnapshotRoot, "Sandbox dependency read exception")];
	const requestedReadExceptions = await Promise.all(
		(options.readOnlyPaths ?? []).map((path) => verifiedFrozenEvaluatorPath(repoRoot, path)),
	);
	const readExceptions = [...new Set([...dependencyReadExceptions, ...requestedReadExceptions])];
	if (writablePaths.length === 0) {
		throw new Error("A sandbox must have at least one explicit disposable writable path.");
	}
	for (const readException of readExceptions) {
		if (readException === repoRoot || !isWithin(repoRoot, readException)) {
			throw new Error(
				`Sandbox read exception must be a strict descendant of the control repository: ${readException}`,
			);
		}
	}
	if (sourceRoot !== undefined) {
		if (!isWithin(sourceRoot, commandCwd)) {
			throw new Error(`Sandbox command cwd is outside the source-pinned checkout: ${commandCwd}`);
		}
		if (pathsIntersect(repoRoot, sourceRoot)) {
			throw new Error("Sandbox source checkout must be disjoint from the mutable repository.");
		}
	}
	for (const writablePath of writablePaths) {
		if (isWithin(repoRoot, writablePath) || isWithin(writablePath, repoRoot)) {
			throw new Error(`Sandbox writable path would expose the control repository: ${writablePath}`);
		}
		if (sourceRoot !== undefined && pathsIntersect(sourceRoot, writablePath)) {
			throw new Error(`Sandbox writable path would expose the source-pinned checkout: ${writablePath}`);
		}
	}
	for (const readException of readExceptions) {
		for (const deniedPath of options.denyReadPaths ?? []) {
			const absoluteDeniedPath = resolve(deniedPath);
			if (pathsIntersect(readException, absoluteDeniedPath)) {
				throw new Error(`Sandbox read exception conflicts with an explicit deny path: ${readException}`);
			}
		}
	}
	const commandResourceLimitPrefix = resourceLimitPrefix();
	const privateDirectory = await createPrivateDirectory();
	let policy: SandboxRuntimeConfig;
	let additionalProfileRules: string[];
	let environment: NodeJS.ProcessEnv;
	try {
		const broadReadablePaths = repositoryIsDetached
			? [sourceRoot ?? commandCwd, commandCwd, ...writablePaths]
			: [repoRoot, commandCwd, ...writablePaths];
		const privacyReadablePaths = [...broadReadablePaths, ...readExceptions];
		const enumeratedHostPrivacyPaths =
			process.platform === "darwin" ? [] : await hostPrivacyDenyPaths(privacyReadablePaths, privateDirectory.root);
		const hostPrivacyRules =
			process.platform === "darwin" ? await darwinHostPrivacyRules(privacyReadablePaths, privateDirectory.root) : [];
		const credentialDenyPaths =
			process.platform === "darwin" ? darwinCredentialDenyPaths(privacyReadablePaths) : COMMON_CREDENTIAL_PATHS;
		const controlPlaneRoot = join(repoRoot, ".iso");
		const controlPlaneReadExceptions = readExceptions.filter((path) => isWithin(controlPlaneRoot, path));
		const controlPlaneDenyPaths =
			controlPlaneReadExceptions.length === 0
				? [controlPlaneRoot]
				: await corridorDenyPaths(controlPlaneRoot, controlPlaneReadExceptions);
		const repositoryDenyPaths = repositoryIsDetached ? [repoRoot] : controlPlaneDenyPaths;
		const denyRead = await canonicalDenyPaths([
			...credentialDenyPaths,
			`/proc/${process.pid}/environ`,
			...enumeratedHostPrivacyPaths,
			...repositoryDenyPaths,
			...(sourceRoot === undefined ? [] : [join(sourceRoot, ".git")]),
			...writablePaths.map((path) => join(path, ".git")),
			...(options.denyReadPaths ?? []),
		]);
		additionalProfileRules =
			process.platform === "darwin"
				? [
						...hostPrivacyRules,
						...darwinReadPolicyOverrides(
							[...broadReadablePaths, await realpath(privateDirectory.root)],
							denyRead,
							readExceptions,
						),
					]
				: [];
		const sensitiveWritePaths =
			process.platform === "darwin"
				? darwinWriteDenyPaths([...writablePaths, privateDirectory.root, ...DEFAULT_RUNTIME_WRITE_PATHS])
				: SENSITIVE_WRITE_PATHS;
		const denyWrite = await canonicalDenyPaths([
			...sensitiveWritePaths,
			...writablePaths.flatMap((path) => [join(path, ".git"), join(path, ".iso"), join(path, "node_modules")]),
		]);
		policy = {
			network: STRICT_NETWORK_CONFIG,
			filesystem: {
				denyRead,
				allowWrite: [...writablePaths, privateDirectory.root],
				denyWrite,
				allowGitConfig: false,
			},
			enableWeakerNestedSandbox: false,
			allowPty: false,
			mandatoryDenySearchDepth: 10,
		};
		environment = minimalEnvironment(privateDirectory.home, privateDirectory.temp, options.environment ?? {});
	} catch (error) {
		privateDirectories.delete(privateDirectory.root);
		await rm(privateDirectory.root, { force: true, recursive: true });
		throw error;
	}
	let disposed = false;
	let disposePromise: Promise<void> | undefined;
	const disposalController = new AbortController();
	const activeProcessGroups = new Set<number>();
	const activeExecutions = new Set<Promise<{ exitCode: number | null }>>();

	const reapActiveProcessGroups = async (): Promise<void> => {
		const processGroupIds = [...activeProcessGroups];
		const results = await Promise.allSettled(
			processGroupIds.map(async (processGroupId) => {
				await killAndReapProcessGroup(processGroupId);
				activeProcessGroups.delete(processGroupId);
				sandboxProcessGroups.delete(processGroupId);
			}),
		);
		const failures = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
		if (failures.length > 0) {
			throw new AggregateError(failures, "ISO could not terminate every sandbox process group.");
		}
	};

	const runExecution = async (
		command: string,
		cwd: string,
		executionOptions: {
			onData: (data: Buffer) => void;
			signal?: AbortSignal;
			timeout?: number;
		},
	): Promise<{ exitCode: number | null }> => {
		const executionSignal = executionOptions.signal
			? AbortSignal.any([executionOptions.signal, disposalController.signal])
			: disposalController.signal;
		if (executionSignal.aborted) {
			throw new Error("aborted");
		}
		assertStrictManagerConfiguration();
		const requestedCwd = await canonicalDirectory(cwd, "Sandbox execution cwd");
		if (disposed) {
			throw new Error("Sandboxed shell operations have been disposed.");
		}
		if (requestedCwd !== commandCwd) {
			throw new Error(`Sandbox execution cwd changed from ${commandCwd} to ${requestedCwd}.`);
		}
		const constrainedCommand = `${commandResourceLimitPrefix}; ${command}`;
		const sandboxRuntimeCommand =
			process.platform === "darwin"
				? `: # ISO command ${createHash("sha256").update(constrainedCommand).digest("hex").slice(0, 20)}`
				: constrainedCommand;
		const wrappedCommand = await withPrivateTmpEnvironment(privateDirectory.temp, () =>
			SandboxManager.wrapWithSandbox(sandboxRuntimeCommand, undefined, policy, executionSignal),
		);
		if (disposed) {
			throw new Error("Sandboxed shell operations have been disposed.");
		}
		if (wrappedCommand.trim() === sandboxRuntimeCommand.trim()) {
			throw new Error("Sandbox runtime returned an unwrapped command.");
		}
		const platformWrappedCommand =
			process.platform === "linux" && repositoryIsDetached
				? reopenLinuxReadExceptions(wrappedCommand, repoRoot, readExceptions)
				: wrappedCommand;
		const execute = (commandToExecute: string) =>
			executeInIsolatedProcessGroup(
				commandToExecute,
				commandCwd,
				{
					onData: executionOptions.onData,
					signal: executionSignal,
					timeout: executionOptions.timeout,
					env: environment,
				},
				activeProcessGroups,
			);
		return process.platform === "darwin"
			? withExternalizedMacOSSandboxCommand(
					privateDirectory.root,
					wrappedCommand,
					sandboxRuntimeCommand,
					constrainedCommand,
					additionalProfileRules,
					executionSignal,
					execute,
				)
			: execute(platformWrappedCommand);
	};

	return {
		privateDirectory: privateDirectory.root,
		dispose(): Promise<void> {
			if (disposePromise) {
				return disposePromise;
			}
			disposed = true;
			disposalController.abort();
			disposePromise = (async () => {
				await reapActiveProcessGroups();
				await Promise.allSettled([...activeExecutions]);
				await reapActiveProcessGroups();
				privateDirectories.delete(privateDirectory.root);
				await rm(privateDirectory.root, { force: true, recursive: true });
			})();
			return disposePromise;
		},
		exec(command, cwd, executionOptions) {
			if (disposed) {
				return Promise.reject(new Error("Sandboxed shell operations have been disposed."));
			}
			const execution = runExecution(command, cwd, executionOptions);
			activeExecutions.add(execution);
			void execution.then(
				() => activeExecutions.delete(execution),
				() => activeExecutions.delete(execution),
			);
			return execution;
		},
	};
}

export type SandboxedWorkerTools = [
	ReturnType<typeof createReadToolDefinition>,
	ReturnType<typeof createBashToolDefinition>,
	ReturnType<typeof createEditToolDefinition>,
	ReturnType<typeof createWriteToolDefinition>,
];

const workerToolSandboxes = new WeakMap<SandboxedWorkerTools, SandboxedBashOperations>();

const DEPENDENCY_SNAPSHOT_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const DEPENDENCY_VIEW_MARKER = ".iso-readonly-view";

async function assertNodeOnlyWorkerLayout(repoRoot: string, cwd: string): Promise<void> {
	for (const path of [join(repoRoot, ".venv"), join(repoRoot, "venv"), join(cwd, ".venv"), join(cwd, "venv")]) {
		try {
			await lstat(path);
			throw new Error(
				`ISO local v1 is Node-only and cannot admit Python virtual environments into the worker sandbox: ${path}`,
			);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				continue;
			}
			throw error;
		}
	}
}

async function workerDependencySnapshotRoot(
	repoRoot: string,
	cwd: string,
	requireTrustedView = true,
): Promise<string | undefined> {
	const dependencyView = join(cwd, "node_modules");
	let dependencyViewMetadata: Stats;
	try {
		dependencyViewMetadata = await lstat(dependencyView);
	} catch (error) {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			return undefined;
		}
		throw error;
	}
	if (!dependencyViewMetadata.isDirectory() || dependencyViewMetadata.isSymbolicLink()) {
		throw new Error("ISO worker node_modules must be a generated read-only dependency view.");
	}

	const marker = join(dependencyView, DEPENDENCY_VIEW_MARKER);
	const markerMetadata = await lstat(marker).catch((error: unknown) => {
		if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
			if (!requireTrustedView) {
				return undefined;
			}
			throw new Error("ISO worker node_modules is missing its trusted dependency snapshot marker.", {
				cause: error,
			});
		}
		throw error;
	});
	if (markerMetadata === undefined) {
		return undefined;
	}
	if (!markerMetadata.isSymbolicLink()) {
		throw new Error("ISO worker dependency snapshot marker must be a symbolic link.");
	}

	const [snapshotRoot, dependencyStore] = await Promise.all([
		realpath(marker),
		canonicalDirectory(join(repoRoot, ".iso", "dependencies"), "ISO dependency snapshot store"),
	]);
	const snapshotFromStore = relative(dependencyStore, snapshotRoot);
	const snapshotSegments = snapshotFromStore.split(sep);
	if (
		snapshotSegments.length !== 2 ||
		!DEPENDENCY_SNAPSHOT_DIGEST_PATTERN.test(snapshotSegments[0] ?? "") ||
		snapshotSegments[1] !== "node_modules" ||
		!isWithin(dependencyStore, snapshotRoot)
	) {
		throw new Error("ISO worker dependency view does not target a content-addressed node_modules snapshot.");
	}
	return canonicalDirectory(snapshotRoot, "ISO dependency snapshot");
}

async function workerReadDenyPaths(
	repoRoot: string,
	cwd: string,
	protectedPaths: readonly string[],
	dependencySnapshotRoot: string | undefined,
): Promise<string[]> {
	const denied = new Set<string>();
	const isoRoot = join(repoRoot, ".iso");
	const repositoryKey = createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 20);
	const worktreeRoot = join(tmpdir(), "iso-worktrees", repositoryKey);
	for (const entry of await readdir(repoRoot)) {
		if (entry !== ".iso" || dependencySnapshotRoot === undefined) {
			denied.add(join(repoRoot, entry));
		}
	}
	denied.add(join(cwd, ".git"));
	denied.add(join(cwd, ".iso"));
	denied.add(join(cwd, ".venv"));
	denied.add(join(cwd, "venv"));
	if (dependencySnapshotRoot === undefined) {
		denied.add(isoRoot);
	} else {
		for (const path of await corridorDenyPaths(isoRoot, [dependencySnapshotRoot])) {
			denied.add(path);
		}
		denied.add(join(isoRoot, "dependencies", "active"));
	}
	try {
		for (const entry of await readdir(worktreeRoot)) {
			const sibling = join(worktreeRoot, entry);
			if (!isWithin(sibling, cwd) && !isWithin(cwd, sibling)) {
				denied.add(sibling);
			}
		}
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}
	for (const protectedPath of protectedPaths) {
		const absolute = resolve(repoRoot, protectedPath);
		if (!isWithin(repoRoot, absolute)) {
			throw new Error(`Protected path escapes the repository: ${protectedPath}`);
		}
		if (isWithin(absolute, cwd)) {
			throw new Error(`Protected path would hide the worker checkout: ${protectedPath}`);
		}
		denied.add(absolute);
		denied.add(resolve(cwd, protectedPath));
	}
	for (const entry of await readdir(repoRoot)) {
		if (/^\.env(?:\.|$)/iu.test(entry)) {
			denied.add(join(repoRoot, entry));
			denied.add(join(cwd, entry));
		}
	}
	return [...denied];
}

function lexicalWorkerPath(rawPath: string, cwd: string): string {
	if (rawPath === "~" || rawPath.startsWith("~/")) {
		throw new Error(`Direct file tools cannot access paths outside the worker checkout: ${rawPath}`);
	}
	const withoutAtPrefix = rawPath.startsWith("@") ? rawPath.slice(1) : rawPath;
	const absolute = isAbsolute(withoutAtPrefix) ? resolve(withoutAtPrefix) : resolve(cwd, withoutAtPrefix);
	if (!isWithin(cwd, absolute)) {
		throw new Error(`Direct file tools cannot access paths outside the worker checkout: ${rawPath}`);
	}
	return absolute;
}

async function assertNoSymlinkTraversal(absolutePath: string, cwd: string): Promise<void> {
	const pathFromRoot = relative(cwd, absolutePath);
	let current = cwd;
	for (const component of pathFromRoot.split(sep).filter(Boolean)) {
		current = join(current, component);
		try {
			const metadata = await lstat(current);
			if (metadata.isSymbolicLink()) {
				throw new Error(`Direct file tools cannot traverse symbolic links: ${current}`);
			}
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
				return;
			}
			throw error;
		}
	}
}

async function assertWorkerPath(rawPath: string, cwd: string, denyReadPaths: readonly string[] = []): Promise<string> {
	const absolute = lexicalWorkerPath(rawPath, cwd);
	await assertNoSymlinkTraversal(absolute, cwd);
	if (denyReadPaths.some((deniedPath) => isWithin(resolve(deniedPath), absolute))) {
		throw new Error(`Direct file tools cannot read a protected path: ${rawPath}`);
	}
	return absolute;
}

async function assertWorkerReadablePath(
	rawPath: string,
	cwd: string,
	dependencySnapshotRoots: readonly string[],
	denyReadPaths: readonly string[],
): Promise<string> {
	const absolute = lexicalWorkerPath(rawPath, cwd);
	if (!isWithin(join(cwd, "node_modules"), absolute)) {
		return assertWorkerPath(rawPath, cwd, denyReadPaths);
	}

	let canonical: string;
	try {
		canonical = await realpath(absolute);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
		await assertNoSymlinkTraversal(absolute, cwd);
		canonical = absolute;
	}
	const isSnapshotDependency = dependencySnapshotRoots.some((root) => isWithin(root, canonical));
	if (!isWithin(cwd, canonical) && !isSnapshotDependency) {
		throw new Error(`Direct file tools cannot follow a dependency link outside approved read roots: ${rawPath}`);
	}
	if (
		!isSnapshotDependency &&
		denyReadPaths.some(
			(deniedPath) => isWithin(resolve(deniedPath), absolute) || isWithin(resolve(deniedPath), canonical),
		)
	) {
		throw new Error(`Direct file tools cannot read a protected path: ${rawPath}`);
	}
	return canonical;
}

async function assertWorkerWritablePath(
	rawPath: string,
	cwd: string,
	protectedPaths: readonly string[],
): Promise<string> {
	const absolute = lexicalWorkerPath(rawPath, cwd);
	const pathFromRoot = relative(cwd, absolute);
	const firstComponent = pathFromRoot.split(sep)[0];
	if (firstComponent === ".git" || firstComponent === ".iso" || firstComponent === "node_modules") {
		throw new Error(`Direct file tools cannot modify worker control paths: ${rawPath}`);
	}
	await assertNoSymlinkTraversal(absolute, cwd);
	for (const protectedPath of protectedPaths) {
		const protectedAbsolute = resolve(cwd, protectedPath);
		if (isWithin(protectedAbsolute, absolute)) {
			throw new Error(`Direct file tools cannot modify a protected path: ${rawPath}`);
		}
	}
	try {
		const metadata = await lstat(absolute);
		if (metadata.isFile() && metadata.nlink > 1) {
			throw new Error(`Direct file tools cannot modify multiply-linked files: ${rawPath}`);
		}
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) {
			throw error;
		}
	}
	return absolute;
}

export async function createSandboxedWorkerTools(options: {
	cwd: string;
	repoRoot: string;
	protectedPaths: string[];
}): Promise<SandboxedWorkerTools> {
	const cwd = await canonicalDirectory(options.cwd, "Worker checkout");
	const repoRoot = await canonicalDirectory(options.repoRoot, "Worker repository root");
	if (pathsIntersect(cwd, repoRoot)) {
		throw new Error("ISO workers must run in a checkout disjoint from the control repository.");
	}
	await assertNodeOnlyWorkerLayout(repoRoot, cwd);
	const dependencySnapshotRoot = await workerDependencySnapshotRoot(repoRoot, cwd);
	const denyReadPaths = await workerReadDenyPaths(repoRoot, cwd, options.protectedPaths, dependencySnapshotRoot);
	const dependencySnapshotRoots =
		dependencySnapshotRoot === undefined ? [] : await existingCanonicalPath(dependencySnapshotRoot);
	const bashOperations = await createSandboxedBashOperations({
		cwd,
		repoRoot,
		writablePaths: [cwd],
		denyReadPaths,
	});

	const readOperations: ReadOperations = {
		async access(path) {
			const readablePath = await assertWorkerReadablePath(path, cwd, dependencySnapshotRoots, denyReadPaths);
			await access(readablePath, constants.R_OK);
		},
		async readFile(path) {
			const readablePath = await assertWorkerReadablePath(path, cwd, dependencySnapshotRoots, denyReadPaths);
			return readFile(readablePath);
		},
	};
	const editOperations: EditOperations = {
		async access(path) {
			await assertWorkerWritablePath(path, cwd, options.protectedPaths);
			await access(path, constants.R_OK | constants.W_OK);
		},
		async readFile(path) {
			await assertWorkerWritablePath(path, cwd, options.protectedPaths);
			return readFile(path);
		},
		async writeFile(path, content) {
			await assertWorkerWritablePath(path, cwd, options.protectedPaths);
			await writeFile(path, content, "utf8");
		},
	};
	const writeOperations: WriteOperations = {
		async mkdir(path) {
			await assertWorkerWritablePath(path, cwd, options.protectedPaths);
			await mkdir(path, { recursive: true });
		},
		async writeFile(path, content) {
			await assertWorkerWritablePath(path, cwd, options.protectedPaths);
			await writeFile(path, content, "utf8");
		},
	};

	const baseReadTool = createReadToolDefinition(cwd, { operations: readOperations });
	const readTool: ReturnType<typeof createReadToolDefinition> = {
		...baseReadTool,
		async execute(toolCallId, params, signal, onUpdate, context) {
			await assertWorkerReadablePath(params.path, cwd, dependencySnapshotRoots, denyReadPaths);
			return baseReadTool.execute(toolCallId, params, signal, onUpdate, context);
		},
	};
	const tools: SandboxedWorkerTools = [
		readTool,
		createBashToolDefinition(cwd, {
			exposeSessionEnvironment: false,
			operations: bashOperations,
			spawnHook: (context) => ({ ...context, env: {} }),
		}),
		createEditToolDefinition(cwd, { operations: editOperations }),
		createWriteToolDefinition(cwd, { operations: writeOperations }),
	];
	workerToolSandboxes.set(tools, bashOperations);
	return tools;
}

export async function disposeSandboxedWorkerTools(tools: SandboxedWorkerTools): Promise<void> {
	const sandbox = workerToolSandboxes.get(tools);
	if (sandbox === undefined) {
		return;
	}
	workerToolSandboxes.delete(tools);
	await sandbox.dispose();
}
