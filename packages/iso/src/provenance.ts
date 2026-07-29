import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeProvenance } from "./types.ts";

interface PackageManifest {
	version?: unknown;
	dependencies?: Record<string, unknown>;
}

const manifest: PackageManifest = JSON.parse(
	readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as PackageManifest;

function manifestVersion(value: unknown, label: string): string {
	if (typeof value !== "string" || value.trim() === "") {
		throw new Error(`ISO package manifest is missing an exact ${label} version.`);
	}
	return value;
}

const ISO_VERSION = manifestVersion(manifest.version, "ISO");
const SANDBOX_RUNTIME_VERSION = manifestVersion(
	manifest.dependencies?.["@anthropic-ai/sandbox-runtime"],
	"@anthropic-ai/sandbox-runtime",
);
const PI_CODING_AGENT_VERSION = manifestVersion(
	manifest.dependencies?.["@earendil-works/pi-coding-agent"],
	"@earendil-works/pi-coding-agent",
);

function findPackageRoot(expectedName: string): string {
	let current = dirname(fileURLToPath(import.meta.url));
	for (;;) {
		const candidateRoot = join(current, "node_modules", expectedName);
		const packageManifest = join(candidateRoot, "package.json");
		if (existsSync(packageManifest)) {
			const candidate = JSON.parse(readFileSync(packageManifest, "utf8")) as { name?: unknown };
			if (candidate.name === expectedName) {
				return realpathSync(candidateRoot);
			}
		}
		const parent = dirname(current);
		if (parent === current) {
			throw new Error(`Unable to locate the installed ${expectedName} package.`);
		}
		current = parent;
	}
}

function hashTree(hash: ReturnType<typeof createHash>, label: string, root: string): void {
	const canonicalRoot = realpathSync(root);
	const visit = (path: string): void => {
		const metadata = lstatSync(path);
		const logicalPath = relative(canonicalRoot, path) || ".";
		if (metadata.isSymbolicLink()) {
			hash.update(`${label}:link:${logicalPath}:${realpathSync(path)}\0`);
			return;
		}
		if (metadata.isDirectory()) {
			hash.update(`${label}:directory:${logicalPath}\0`);
			for (const entry of readdirSync(path).sort()) {
				if (entry !== "node_modules" && entry !== ".git") {
					visit(join(path, entry));
				}
			}
			return;
		}
		if (metadata.isFile()) {
			hash.update(`${label}:file:${logicalPath}:${metadata.mode & 0o777}\0`);
			hash.update(readFileSync(path));
			hash.update("\0");
		}
	};
	visit(canonicalRoot);
}

function runtimeArtifactDigest(): string {
	const hash = createHash("sha256");
	const isoCodeRoot = dirname(fileURLToPath(import.meta.url));
	const repositoryLock = fileURLToPath(new URL("../../../package-lock.json", import.meta.url));
	hashTree(hash, "iso-runtime", isoCodeRoot);
	hashTree(hash, "pi-coding-agent", join(findPackageRoot("@earendil-works/pi-coding-agent"), "dist"));
	hashTree(hash, "pi-ai", join(findPackageRoot("@earendil-works/pi-ai"), "dist"));
	const sandboxRoot = findPackageRoot("@anthropic-ai/sandbox-runtime");
	hashTree(hash, "sandbox-runtime", join(sandboxRoot, "dist"));
	const sandboxVendor = join(sandboxRoot, "vendor");
	if (existsSync(sandboxVendor)) {
		hashTree(hash, "sandbox-vendor", sandboxVendor);
	}
	hash.update("iso-package-manifest\0");
	hash.update(readFileSync(new URL("../package.json", import.meta.url)));
	hash.update("\0workspace-lock\0");
	hash.update(readFileSync(repositoryLock));
	return hash.digest("hex");
}

export function currentRuntimeProvenance(): RuntimeProvenance {
	return {
		isoVersion: ISO_VERSION,
		nodeVersion: process.version,
		platform: process.platform,
		architecture: process.arch,
		sandboxRuntimeVersion: SANDBOX_RUNTIME_VERSION,
		piCodingAgentVersion: PI_CODING_AGENT_VERSION,
		artifactDigest: runtimeArtifactDigest(),
		evaluatorContract: "iso-result-line-v1",
		selectionMethod: "paired-postselection-bonferroni-v1",
	};
}

export function sameRuntimeProvenance(left: RuntimeProvenance, right: RuntimeProvenance): boolean {
	return (
		left.isoVersion === right.isoVersion &&
		left.nodeVersion === right.nodeVersion &&
		left.platform === right.platform &&
		left.architecture === right.architecture &&
		left.sandboxRuntimeVersion === right.sandboxRuntimeVersion &&
		left.piCodingAgentVersion === right.piCodingAgentVersion &&
		left.artifactDigest === right.artifactDigest &&
		left.evaluatorContract === right.evaluatorContract &&
		left.selectionMethod === right.selectionMethod
	);
}
