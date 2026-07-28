import { spawn } from "node:child_process";
import type { Evaluation } from "./types.ts";

const OUTPUT_LIMIT = 1_000_000;

function trimOutput(value: string): string {
	return value.length <= OUTPUT_LIMIT ? value : value.slice(value.length - OUTPUT_LIMIT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function parseEvaluation(stdout: string, stderr: string): Evaluation {
	const lines = stdout
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.reverse();
	const resultLine = lines.find((line) => line.startsWith("ISO_RESULT "));
	const raw = resultLine ? resultLine.slice("ISO_RESULT ".length) : lines[0];
	if (!raw) {
		throw new Error('Evaluator produced no result. Expected ISO_RESULT {"score": number}.');
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new Error('Evaluator result was not valid JSON. Expected ISO_RESULT {"score": number}.');
	}
	if (!isRecord(parsed) || typeof parsed.score !== "number" || !Number.isFinite(parsed.score)) {
		throw new Error("Evaluator result must contain a finite numeric score.");
	}
	const metrics: Record<string, number> = {};
	if (isRecord(parsed.metrics)) {
		for (const [key, value] of Object.entries(parsed.metrics)) {
			if (typeof value === "number" && Number.isFinite(value)) {
				metrics[key] = value;
			}
		}
	}
	return {
		score: parsed.score,
		metrics,
		summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
		stdout: trimOutput(stdout),
		stderr: trimOutput(stderr),
	};
}

export function runEvaluator(command: string, cwd: string): Promise<Evaluation> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, {
			cwd,
			env: { ...process.env, ISO_EXPERIMENT_DIR: cwd },
			shell: true,
			stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => {
			stdout = trimOutput(stdout + chunk);
		});
		child.stderr.on("data", (chunk: string) => {
			stderr = trimOutput(stderr + chunk);
		});
		child.once("error", reject);
		child.once("exit", (code) => {
			if (code !== 0) {
				reject(new Error(`Evaluator exited with ${code}: ${stderr.trim()}`));
				return;
			}
			try {
				resolve(parseEvaluation(stdout, stderr));
			} catch (error) {
				reject(error);
			}
		});
	});
}
