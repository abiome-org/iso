import { createHash } from "node:crypto";

export const PRINCIPAL_TOOLS = [
	"iso_read_repo",
	"iso_search_repo",
	"iso_list_repo",
	"iso_write_evaluator",
	"iso_launch",
	"iso_need_input",
	"iso_resume",
	"iso_status",
	"iso_query_evidence",
	"iso_note",
	"iso_champion",
	"iso_dashboard",
	"iso_pause",
	"iso_stop",
	"iso_steer",
	"iso_abort_worker",
].join(",");

const CAPABILITY_FLAGS = new Set([
	"--append-system-prompt",
	"--api-key",
	"--continue",
	"--exclude-tools",
	"--export",
	"--extension",
	"--fork",
	"--mode",
	"--no-builtin-tools",
	"--no-session",
	"--no-tools",
	"--prompt-template",
	"--resume",
	"--session",
	"--session-dir",
	"--session-id",
	"--skill",
	"--system-prompt",
	"--tools",
	"-c",
	"-e",
	"-nbt",
	"-nt",
	"-r",
	"-t",
	"-xt",
]);

export function principalSessionId(repoRoot: string): string {
	return `iso-principal-${createHash("sha256").update(repoRoot).digest("hex").slice(0, 32)}`;
}

export function restrictedPrincipalArgs(args: string[]): string[] {
	const command = args[0];
	if (
		command !== undefined &&
		["auth", "config", "install", "list", "remove", "uninstall", "update"].includes(command)
	) {
		throw new Error(`${command} is unavailable inside ISO's capability-restricted principal entrypoint.`);
	}
	for (const argument of args) {
		if (argument.startsWith("@")) {
			throw new Error("@file arguments are unavailable in ISO's capability-restricted principal session.");
		}
		const flag = argument.includes("=") ? argument.slice(0, argument.indexOf("=")) : argument;
		if (CAPABILITY_FLAGS.has(flag)) {
			throw new Error(`${flag} is unavailable in ISO's capability-restricted principal session.`);
		}
	}
	return [
		...args,
		"--no-extensions",
		"--no-skills",
		"--no-prompt-templates",
		"--no-themes",
		"--no-context-files",
		"--tools",
		PRINCIPAL_TOOLS,
	];
}
