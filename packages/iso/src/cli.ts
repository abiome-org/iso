#!/usr/bin/env node

import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { KernelClient } from "./client.ts";
import { restrictedPrincipalArgs } from "./principal-policy.ts";
import { findRepoRoot } from "./repo-root.ts";
import type { CampaignSummary, DashboardSnapshot, MetricDirection, MissionReceipt } from "./types.ts";

interface ParsedArgs {
	positionals: string[];
	flags: Map<string, string | true>;
}

const HELP = `ISO — autonomous parallel software research

Talk to ISO:
  iso
  iso -p "Make this parser 30% faster without changing behavior"
  iso agent [Pi options]

Observe and control the durable local kernel:
  iso status [--json]
  iso start
  iso pause
  iso resume
  iso stop [--reason "..."]
  iso steer --worker <id> --message "..."
  iso abort --worker <id>
  iso note --message "Try the indexed parser next"
  iso champion [--json]
  iso dashboard [--no-open]
  iso graph [--json]

Non-conversational durable launch:
  iso launch --goal "..." --metric score --direction maximize --eval "trusted command"
    [--minimum-improvement 0] [--workers 4] [--samples 5] [--warmups 1]
    [--score-min <guaranteed-bound> --score-max <guaranteed-bound>]
    [--evaluator-timeout 600] [--agent-timeout 30] [--generations 12]
    [--experiments 48] [--hours 8] [--plateaus 4] [--failures 12]
    [--control-cwd .] [--protect path1,path2]

Advanced calibration-only alias:
  iso calibrate [same options as launch]

Internal daemon lifecycle:
  iso kernel run --repo <absolute-path>
  iso kernel stop

Evaluator contract:
  The command runs from the trusted control directory with ISO_EXPERIMENT_DIR set
  to the candidate checkout. It must exit successfully and print a final line:
  ISO_RESULT {"score":0.91,"metrics":{"latency_ms":42},"constraints":{"tests":true}}
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
		const equals = value.indexOf("=");
		if (equals > 2) {
			flags.set(value.slice(2, equals), value.slice(equals + 1));
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

function numberFlag(
	args: ParsedArgs,
	name: string,
	fallback: number,
	options: { minimum?: number; integer?: boolean } = {},
): number {
	const raw = stringFlag(args, name);
	if (raw === undefined) {
		return fallback;
	}
	const value = Number(raw);
	if (
		!Number.isFinite(value) ||
		value < (options.minimum ?? 0) ||
		(options.integer === true && !Number.isSafeInteger(value))
	) {
		throw new Error(
			`--${name} must be ${options.integer === true ? "an integer" : "a number"} >= ${options.minimum ?? 0}.`,
		);
	}
	return value;
}

function optionalFiniteNumberFlag(args: ParsedArgs, name: string): number | undefined {
	const raw = stringFlag(args, name);
	if (raw === undefined) {
		return undefined;
	}
	const value = Number(raw);
	if (!Number.isFinite(value)) {
		throw new Error(`--${name} must be a finite number.`);
	}
	return value;
}

function directionFlag(args: ParsedArgs): MetricDirection {
	const value = stringFlag(args, "direction") ?? "maximize";
	if (value !== "maximize" && value !== "minimize") {
		throw new Error("--direction must be maximize or minimize.");
	}
	return value;
}

function formatStatus(summary: CampaignSummary): string {
	const campaign = summary.campaign;
	if (!campaign) {
		return summary.mission
			? `${summary.mission.phase.toUpperCase()} — ${summary.mission.goal}`
			: "ISO kernel is ready. No active mission.";
	}
	const score = summary.champion?.championScore ?? campaign.baselineScore;
	const label = summary.champion ? "champion" : "baseline";
	const lines = [
		`${campaign.status.toUpperCase()} — ${campaign.goal}`,
		`${campaign.metric.name}: ${score} (${label}, ${campaign.metric.direction})`,
		`${campaign.generationsCompleted} generations · ${campaign.experimentsStarted} experiments · ${summary.workers.length} active workers`,
		`${summary.agentUsage.inputTokens} input tokens · ${summary.agentUsage.outputTokens} output tokens · $${summary.agentUsage.costUsd.toFixed(4)}`,
	];
	if (campaign.stopReason) {
		lines.push(`Reason: ${campaign.stopReason}`);
	}
	for (const worker of summary.workers) {
		lines.push(`  ${worker.id} · ${worker.label} · ${worker.activity}`);
	}
	return lines.join("\n");
}

function formatResearchReceipt(receipt: { runId: string; started: boolean }, resumed: boolean): string {
	if (receipt.started) {
		return `Research ${resumed ? "resumed" : "started"} in the background (${receipt.runId}).`;
	}
	if (receipt.runId === "none") {
		return "No calibrated campaign is available. Calibrate an objective first.";
	}
	if (receipt.runId === "external") {
		return "Another ISO kernel owns the active research run.";
	}
	return `Research is already running (${receipt.runId}).`;
}

function siblingEntryPath(name: string): string {
	const extension = fileURLToPath(import.meta.url).endsWith(".ts") ? ".ts" : ".js";
	return fileURLToPath(new URL(`./${name}${extension}`, import.meta.url));
}

async function runNodeEntry(entryPath: string, args: string[], environment: NodeJS.ProcessEnv): Promise<void> {
	const exitCode = await new Promise<number>((resolveExit, reject) => {
		const child = spawn(process.execPath, [entryPath, ...args], {
			env: environment,
			stdio: "inherit",
		});
		child.once("error", reject);
		child.once("close", (code) => resolveExit(code ?? 1));
	});
	if (exitCode !== 0) {
		process.exitCode = exitCode;
	}
}

async function runAgent(repoRoot: string, args: string[]): Promise<void> {
	restrictedPrincipalArgs(args);
	await runNodeEntry(siblingEntryPath("principal-entry"), args, {
		...process.env,
		ISO_PRINCIPAL_REPO_ROOT: repoRoot,
	});
}

async function runAutomation(args: ParsedArgs, rawArgs: string[]): Promise<boolean> {
	const [command, subcommand] = args.positionals;
	if (command === "agent") {
		const agentIndex = rawArgs.indexOf("agent");
		restrictedPrincipalArgs(rawArgs.slice(agentIndex + 1));
		const repoRoot = await findRepoRoot(process.cwd());
		await runAgent(repoRoot, rawArgs.slice(agentIndex + 1));
		return true;
	}
	if (command === "kernel" && subcommand === "run") {
		const repoRoot = stringFlag(args, "repo") ?? (await findRepoRoot(process.cwd()));
		await runNodeEntry(siblingEntryPath("kernel-entry"), [repoRoot], process.env);
		return true;
	}
	if (command === "help" || command === "--help" || command === "-h") {
		console.log(HELP);
		return true;
	}
	const automationCommands = new Set([
		"status",
		"start",
		"pause",
		"resume",
		"stop",
		"steer",
		"abort",
		"note",
		"champion",
		"dashboard",
		"graph",
		"launch",
		"calibrate",
		"init",
		"research",
		"kernel",
	]);
	if (!command || !automationCommands.has(command)) {
		return false;
	}

	const repoRoot = await findRepoRoot(process.cwd());
	const client = new KernelClient(repoRoot);
	await client.ensure();

	if (command === "status") {
		const summary = await client.request<CampaignSummary>("summary");
		console.log(args.flags.has("json") ? JSON.stringify(summary, null, 2) : formatStatus(summary));
		return true;
	}
	if (command === "graph") {
		const snapshot = await client.request<DashboardSnapshot>("status");
		if (args.flags.has("json")) {
			console.log(JSON.stringify(snapshot.graph, null, 2));
		} else {
			for (const node of snapshot.graph.nodes) {
				console.log(`${node.kind.padEnd(10)} ${node.status.padEnd(14)} ${node.label}`);
			}
		}
		return true;
	}
	if (command === "dashboard") {
		const response = await client.request<{ url: string }>("dashboard", {});
		console.log(`ISO dashboard: ${response.url}`);
		if (!args.flags.has("no-open")) {
			const opener = process.platform === "darwin" ? "open" : "xdg-open";
			const child = spawn(opener, [response.url], { detached: true, stdio: "ignore" });
			child.once("error", () => undefined);
			child.unref();
		}
		return true;
	}
	if (command === "start" || (command === "research" && subcommand === "run")) {
		const response = await client.request<{ research: { runId: string; started: boolean } }>("start", {});
		console.log(formatResearchReceipt(response.research, false));
		return true;
	}
	if (command === "resume") {
		const response = await client.request<{
			mission?: MissionReceipt;
			research?: { runId: string; started: boolean };
		}>("resume", {});
		console.log(
			response.mission
				? `Mission ${response.mission.missionId} resume requested (${response.mission.phase}).`
				: formatResearchReceipt(response.research ?? { runId: "none", started: false }, true),
		);
		return true;
	}
	if (command === "pause") {
		await client.request("pause", {});
		console.log("Research will pause at the next durable boundary.");
		return true;
	}
	if (command === "stop" && subcommand !== "kernel") {
		await client.request("stop", { reason: stringFlag(args, "reason") });
		console.log("Research stopped.");
		return true;
	}
	if (command === "steer") {
		await client.request("steer", {
			workerId: stringFlag(args, "worker", true),
			message: stringFlag(args, "message", true),
		});
		console.log("Worker steered.");
		return true;
	}
	if (command === "abort") {
		await client.request("abort", { workerId: stringFlag(args, "worker", true) });
		console.log("Worker cancellation requested.");
		return true;
	}
	if (command === "note") {
		const response = await client.request<{ note: { id: string } }>("note", {
			message: stringFlag(args, "message", true),
		});
		console.log(`Queued mission guidance ${response.note.id}.`);
		return true;
	}
	if (command === "champion") {
		const response = await client.request<{ champion: unknown }>("champion", {});
		console.log(JSON.stringify(response.champion ?? null, null, 2));
		return true;
	}
	if (command === "kernel" && subcommand === "stop") {
		await client.request("shutdown", {});
		console.log("ISO kernel stopped. An in-flight campaign will reconcile and resume automatically on restart.");
		return true;
	}
	if (command === "launch" || command === "calibrate" || command === "init") {
		const workers = numberFlag(args, "workers", 4, { minimum: 1, integer: true });
		const maxGenerations = numberFlag(args, "generations", 12, { minimum: 1, integer: true });
		const evaluatorCommand = stringFlag(args, "eval", true) ?? "";
		const scoreMinimum = optionalFiniteNumberFlag(args, "score-min");
		const scoreMaximum = optionalFiniteNumberFlag(args, "score-max");
		if ((scoreMinimum === undefined) !== (scoreMaximum === undefined)) {
			throw new Error("--score-min and --score-max must be supplied together.");
		}
		if (scoreMinimum !== undefined && scoreMaximum !== undefined && scoreMinimum >= scoreMaximum) {
			throw new Error("--score-min must be less than --score-max.");
		}
		const scoreBounds =
			scoreMinimum !== undefined && scoreMaximum !== undefined
				? { min: scoreMinimum, max: scoreMaximum }
				: undefined;
		const inferredEvaluatorPath = evaluatorCommand.match(/\.iso\/evaluators\/[a-z0-9._-]+\.mjs/)?.[0];
		const explicitProtected = (stringFlag(args, "protect") ?? "")
			.split(",")
			.map((path) => path.trim())
			.filter(Boolean);
		const calibrationPayload = {
			goal: stringFlag(args, "goal", true),
			metric: {
				name: stringFlag(args, "metric", true),
				direction: directionFlag(args),
				minimumImprovement: numberFlag(args, "minimum-improvement", 0),
			},
			config: {
				workers,
				agentTimeoutMs: numberFlag(args, "agent-timeout", 30, { minimum: 1, integer: true }) * 60_000,
				evaluator: {
					command: evaluatorCommand,
					controlCwd: stringFlag(args, "control-cwd") ?? ".",
					samples: numberFlag(args, "samples", 5, { minimum: 2, integer: true }),
					warmups: numberFlag(args, "warmups", 1, { minimum: 0, integer: true }),
					timeoutMs:
						numberFlag(args, "evaluator-timeout", 600, {
							minimum: 1,
							integer: true,
						}) * 1_000,
					scoreBounds,
					protectedPaths: [...explicitProtected, ...(inferredEvaluatorPath ? [inferredEvaluatorPath] : [])].filter(
						(path, index, paths) => paths.indexOf(path) === index,
					),
				},
				budget: {
					maxGenerations,
					maxExperiments: numberFlag(args, "experiments", workers * maxGenerations, {
						minimum: 1,
						integer: true,
					}),
					maxWallClockMs: numberFlag(args, "hours", 8, { minimum: 0.01 }) * 60 * 60 * 1_000,
					maxConsecutivePlateaus: numberFlag(args, "plateaus", 4, {
						minimum: 1,
						integer: true,
					}),
					maxFailures: numberFlag(args, "failures", 12, { minimum: 1, integer: true }),
				},
			},
		};
		const response = await client.request<{
			campaign?: DashboardSnapshot["activeCampaign"];
			mission?: MissionReceipt;
		}>(command === "launch" ? "launch" : "calibrate", calibrationPayload, {
			timeoutMs: command === "launch" ? 10_000 : 24 * 60 * 60 * 1_000,
			retryAmbiguousTransportOnce: command === "launch",
		});
		if (response.mission) {
			console.log(
				`Mission ${response.mission.missionId} ${response.mission.accepted ? "accepted" : "already active"} (${response.mission.phase}).`,
			);
			return true;
		}
		const campaign = response.campaign;
		console.log(
			campaign
				? `Calibrated ${campaign.id}. Baseline ${campaign.metric.name}: ${campaign.baseline.evaluation.score.mean}`
				: "Campaign calibrated.",
		);
		return true;
	}
	throw new Error(`Unknown ISO command.\n\n${HELP}`);
}

async function main(): Promise<void> {
	const rawArgs = process.argv.slice(2);
	if (rawArgs.length === 1 && (rawArgs[0] === "--help" || rawArgs[0] === "-h")) {
		console.log(HELP);
		return;
	}
	const parsed = parseArgs(rawArgs);
	if (await runAutomation(parsed, rawArgs)) {
		return;
	}
	restrictedPrincipalArgs(rawArgs);
	const repoRoot = await findRepoRoot(process.cwd());
	await runAgent(repoRoot, rawArgs);
}

main().catch((error: unknown) => {
	console.error(`iso: ${error instanceof Error ? error.message : String(error)}`);
	process.exitCode = 1;
});
