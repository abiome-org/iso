#!/usr/bin/env node

import { type InlineExtension, main as piMain } from "@earendil-works/pi-coding-agent";
import { createIsoExtension } from "./extension.ts";
import { principalSessionId, restrictedPrincipalArgs } from "./principal-policy.ts";

async function main(): Promise<void> {
	const repoRoot = process.env.ISO_PRINCIPAL_REPO_ROOT;
	if (!repoRoot) {
		throw new Error("Principal entrypoint requires ISO_PRINCIPAL_REPO_ROOT.");
	}
	const extension: InlineExtension = {
		name: "iso",
		hidden: true,
		factory: createIsoExtension(repoRoot),
	};
	await piMain([...restrictedPrincipalArgs(process.argv.slice(2)), "--session-id", principalSessionId(repoRoot)], {
		extensionFactories: [extension],
	});
}

main().catch((error: unknown) => {
	console.error(`iso: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
