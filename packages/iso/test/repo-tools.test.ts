import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRepoInspectionTools, type RepoInspectionTools } from "../src/repo-tools.ts";

const extensionContext = {} as ExtensionContext;

interface RepoFixture {
	root: string;
	outside: string;
	tools: RepoInspectionTools;
}

async function createFixture(): Promise<RepoFixture> {
	const root = await mkdtemp(join(tmpdir(), "iso-repo-tools-"));
	const outside = await mkdtemp(join(tmpdir(), "iso-repo-tools-outside-"));
	await Promise.all([
		mkdir(join(root, "src"), { recursive: true }),
		mkdir(join(root, ".git"), { recursive: true }),
		mkdir(join(root, ".iso"), { recursive: true }),
		mkdir(join(root, "node_modules", "fixture"), { recursive: true }),
		mkdir(join(root, "dist"), { recursive: true }),
	]);
	await Promise.all([
		writeFile(
			join(root, "src", "main.ts"),
			[
				"export const zero = 0;",
				'export const literal = "a.b*";',
				'export const regexOnly = "axb plus";',
				"export const final = true;",
				"",
			].join("\n"),
		),
		writeFile(
			join(root, "src", "matches.txt"),
			`${Array.from({ length: 12 }, (_, index) => `needle ${index + 1}`).join("\n")}\n`,
		),
		writeFile(join(root, ".git", "config"), "excluded-secret\n"),
		writeFile(join(root, ".iso", "state.json"), "excluded-secret\n"),
		writeFile(join(root, "node_modules", "fixture", "index.js"), "excluded-secret\n"),
		writeFile(join(root, "dist", "bundle.js"), "excluded-secret\n"),
		writeFile(join(outside, "secret.txt"), "outside-secret\n"),
	]);
	await symlink(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
	return {
		root,
		outside,
		tools: createRepoInspectionTools(root),
	};
}

async function cleanupFixture(fixture: RepoFixture): Promise<void> {
	await Promise.all([
		rm(fixture.root, { recursive: true, force: true }),
		rm(fixture.outside, { recursive: true, force: true }),
	]);
}

test("reads, searches, and lists safe repository content", async () => {
	const fixture = await createFixture();
	try {
		const readResult = await fixture.tools[0].execute(
			"read",
			{ path: "src/main.ts", offset: 2, limit: 2 },
			undefined,
			undefined,
			extensionContext,
		);
		const readContent = readResult.content[0];
		assert.equal(readContent?.type, "text");
		if (readContent?.type !== "text") {
			throw new Error("Read tool did not return text");
		}
		assert.equal(readContent.text, '2: export const literal = "a.b*";\n3: export const regexOnly = "axb plus";');
		assert.deepEqual(
			{
				path: readResult.details.path,
				startLine: readResult.details.startLine,
				endLine: readResult.details.endLine,
			},
			{ path: "src/main.ts", startLine: 2, endLine: 3 },
		);

		const searchResult = await fixture.tools[1].execute(
			"search",
			{ query: "export const final", path: "src" },
			undefined,
			undefined,
			extensionContext,
		);
		const searchContent = searchResult.content[0];
		assert.equal(searchContent?.type, "text");
		if (searchContent?.type !== "text") {
			throw new Error("Search tool did not return text");
		}
		assert.match(searchContent.text, /^src\/main\.ts:4:\d+:export const final = true;$/u);
		assert.equal(searchResult.details.matches, 1);

		const listResult = await fixture.tools[2].execute("list", { path: "." }, undefined, undefined, extensionContext);
		const listContent = listResult.content[0];
		assert.equal(listContent?.type, "text");
		if (listContent?.type !== "text") {
			throw new Error("List tool did not return text");
		}
		assert.equal(listContent.text, "src/");
		assert.equal(listResult.details.entries, 1);
		assert.equal(listResult.details.truncated, false);
	} finally {
		await cleanupFixture(fixture);
	}
});

test("rejects lexical traversal, absolute paths, and private repository state", async () => {
	const fixture = await createFixture();
	try {
		await assert.rejects(
			fixture.tools[0].execute("traversal", { path: "../outside.txt" }, undefined, undefined, extensionContext),
			/escapes the repository root/u,
		);
		await assert.rejects(
			fixture.tools[0].execute(
				"absolute",
				{ path: join(fixture.root, "src", "main.ts") },
				undefined,
				undefined,
				extensionContext,
			),
			/must be relative/u,
		);
		await assert.rejects(
			fixture.tools[0].execute("git-private", { path: ".git/config" }, undefined, undefined, extensionContext),
			/Repository-private path/u,
		);
		await assert.rejects(
			fixture.tools[1].execute(
				"iso-private",
				{ query: "secret", path: ".iso" },
				undefined,
				undefined,
				extensionContext,
			),
			/Repository-private path/u,
		);
		await assert.rejects(
			fixture.tools[2].execute("git-list", { path: ".git" }, undefined, undefined, extensionContext),
			/Repository-private path/u,
		);
	} finally {
		await cleanupFixture(fixture);
	}
});

test("rejects symlink escapes and omits excluded trees from root inspection", async () => {
	const fixture = await createFixture();
	try {
		await assert.rejects(
			fixture.tools[0].execute(
				"symlink-escape",
				{ path: "escape/secret.txt" },
				undefined,
				undefined,
				extensionContext,
			),
			/symlink resolves outside/u,
		);

		const result = await fixture.tools[1].execute(
			"excluded-search",
			{ query: "excluded-secret", path: "." },
			undefined,
			undefined,
			extensionContext,
		);
		const content = result.content[0];
		assert.equal(content?.type, "text");
		if (content?.type !== "text") {
			throw new Error("Search tool did not return text");
		}
		assert.equal(content.text, "(no matches)");
		assert.equal(result.details.matches, 0);
	} finally {
		await cleanupFixture(fixture);
	}
});

test("searches literally and stops at the requested result cap", async () => {
	const fixture = await createFixture();
	try {
		const literal = await fixture.tools[1].execute(
			"literal-search",
			{ query: "a.b*", path: "src" },
			undefined,
			undefined,
			extensionContext,
		);
		const literalContent = literal.content[0];
		assert.equal(literalContent?.type, "text");
		if (literalContent?.type !== "text") {
			throw new Error("Search tool did not return text");
		}
		assert.match(literalContent.text, /literal = "a\.b\*"/u);
		assert.doesNotMatch(literalContent.text, /regexOnly/u);
		assert.equal(literal.details.matches, 1);

		const bounded = await fixture.tools[1].execute(
			"bounded-search",
			{ query: "needle", path: "src/matches.txt", limit: 3 },
			undefined,
			undefined,
			extensionContext,
		);
		const boundedContent = bounded.content[0];
		assert.equal(boundedContent?.type, "text");
		if (boundedContent?.type !== "text") {
			throw new Error("Search tool did not return text");
		}
		assert.equal(boundedContent.text.split("\n").length, 3);
		assert.equal(bounded.details.matches, 3);
		assert.equal(bounded.details.truncated, true);
	} finally {
		await cleanupFixture(fixture);
	}
});
