#!/usr/bin/env node

import { findRepoRoot } from "./git.ts";
import { buildIdeaGraph } from "./graph.ts";
import { IsoRuntime } from "./runtime.ts";
import { serveDashboard } from "./server.ts";
import { getActiveCampaign, IsoStore } from "./store.ts";
import type { MetricDirection } from "./types.ts";

interface ParsedArgs {
	positionals: string[];
	flags: Map<string, string | true>;
}

const HELP = `ISO — parallel autoresearch on the Pi agent harness

Usage:
  iso init --goal "..." --metric score --direction maximize --eval "command"
  iso idea add --title "..." --hypothesis "..." --plan "..."
  iso research run [--iterations 3] [--workers 4]
  iso serve [--port 4010] [--host 127.0.0.1] [--run]
  iso status [--json]
  iso graph [--json]

Evaluator contract:
  Exit successfully and print a final line such as:
  ISO_RESULT {"score": 0.91, "metrics": {"latency_ms": 42}, "summary": "optional"}
`;

function parseArgs(values: string[]): ParsedArgs {
	const positionals: string[] = [];
	const flags = new Map<string, string | true>();
	for (let index = 0; index < values.length; index += 1) {
		const value = values[index];
		if (!value.startsWith("--")) {
			positionals.push(value);
			continue;
		}
		const key = value.slice(2);
		const next = values[index + 1];
		if (next && !next.startsWith("--")) {
			flags.set(key, next);
			index += 1;
		} else {
			flags.set(key, true);
		}
	}
	return { positionals, flags };
}

function stringFlag(args: ParsedArgs, name: string, required = false): string | undefined {
	const value = args.flags.get(name);
	if (typeof value === "string") {
		return value;
	}
	if (required) {
		throw new Error(`Missing required --${name}.`);
	}
	return undefined;
}

function numberFlag(args: ParsedArgs, name: string, fallback: number): number {
	const value = stringFlag(args, name);
	if (!value) {
		return fallback;
	}
	const parsed = Number.parseInt(value, 10);
	if (!Number.isSafeInteger(parsed) || parsed < 1) {
		throw new Error(`--${name} must be a positive integer.`);
	}
	return parsed;
}

function directionFlag(args: ParsedArgs): MetricDirection {
	const value = stringFlag(args, "direction") ?? "maximize";
	if (value !== "maximize" && value !== "minimize") {
		throw new Error("--direction must be maximize or minimize.");
	}
	return value;
}

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	const [command, subcommand] = args.positionals;
	if (!command || command === "help" || args.flags.has("help")) {
		console.log(HELP);
		return;
	}
	const repoRoot = await findRepoRoot(process.cwd());
	const store = new IsoStore(repoRoot);
	const runtime = new IsoRuntime(repoRoot, store);

	if (command === "init") {
		const campaign = await store.initialize({
			goal: stringFlag(args, "goal", true) ?? "",
			metric: {
				name: stringFlag(args, "metric", true) ?? "",
				direction: directionFlag(args),
			},
			config: {
				evaluator: stringFlag(args, "eval", true) ?? "",
				defaultIterations: numberFlag(args, "iterations", 3),
				defaultWorkers: numberFlag(args, "workers", 4),
			},
		});
		console.log(`Initialized ${campaign.id}`);
		console.log(`Goal: ${campaign.goal}`);
		console.log(`Run: iso serve --run`);
		return;
	}

	if (!(await store.exists())) {
		throw new Error("ISO is not initialized in this repository. Run `iso init` first.");
	}

	if (command === "idea" && subcommand === "add") {
		const idea = await runtime.addIdea({
			title: stringFlag(args, "title", true) ?? "",
			hypothesis: stringFlag(args, "hypothesis", true) ?? "",
			implementationPlan: stringFlag(args, "plan", true) ?? "",
		});
		console.log(`Queued ${idea.id}: ${idea.title}`);
		return;
	}

	if (command === "research" && subcommand === "run") {
		await runtime.startResearch({
			iterations: numberFlag(args, "iterations", 3),
			workers: numberFlag(args, "workers", 4),
		});
		const state = await store.read();
		const campaign = getActiveCampaign(state);
		const champion = state.experiments.find((experiment) => experiment.id === campaign?.championExperimentId);
		console.log(
			champion?.evaluation
				? `Champion: ${champion.branch} at ${champion.evaluation.score}`
				: "Research finished without a measured champion.",
		);
		return;
	}

	if (command === "serve") {
		await serveDashboard(runtime, {
			host: stringFlag(args, "host") ?? "127.0.0.1",
			port: numberFlag(args, "port", 4010),
			startResearch: args.flags.has("run"),
		});
		return;
	}

	if (command === "status") {
		const snapshot = await runtime.snapshot();
		if (args.flags.has("json")) {
			console.log(JSON.stringify(snapshot, null, 2));
			return;
		}
		const campaign = snapshot.activeCampaign;
		console.log(campaign ? `${campaign.status.toUpperCase()} — ${campaign.goal}` : "No active campaign");
		console.log(
			`${snapshot.state.ideas.length} ideas · ${snapshot.state.experiments.length} experiments · ${snapshot.workers.length} active`,
		);
		return;
	}

	if (command === "graph") {
		const state = await store.read();
		const graph = buildIdeaGraph(state, getActiveCampaign(state)?.id);
		if (args.flags.has("json")) {
			console.log(JSON.stringify(graph, null, 2));
			return;
		}
		for (const node of graph.nodes) {
			console.log(`${node.kind.padEnd(10)} ${node.status.padEnd(10)} ${node.label}`);
		}
		return;
	}

	throw new Error(`Unknown command. Run \`iso help\`.\n\n${HELP}`);
}

main().catch((error: unknown) => {
	console.error(`iso: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
