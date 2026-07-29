#!/usr/bin/env node

import { runKernel } from "./kernel.ts";

const repoRoot = process.argv[2];
if (!repoRoot) {
	console.error("iso: kernel entrypoint requires an absolute repository path.");
	process.exitCode = 1;
} else {
	runKernel(repoRoot).catch((error: unknown) => {
		console.error(`iso: ${error instanceof Error ? error.message : String(error)}`);
		process.exitCode = 1;
	});
}
