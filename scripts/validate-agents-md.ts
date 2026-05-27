#!/usr/bin/env bun
/**
 * Validate that the commands and file references in AGENTS.md (and CLAUDE.md)
 * still resolve. Static check — no commands are executed here, since the
 * `bun test && bun run lint && bun run typecheck` trinity is already exercised
 * by the rest of the CI pipeline (.github/workflows/ci.yml).
 *
 * Fails CI if AGENTS.md drifts out of sync with the repo: any `bun run <X>`
 * referenced inside a fenced bash block must exist in package.json's scripts,
 * and any backticked path-shaped string must resolve on disk.
 *
 * Seed: warren-9d2f (plan pl-7b06 step 3).
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const TARGETS = ["AGENTS.md"];

/**
 * Paths that AGENTS.md may reference as documentation but that are
 * intentionally not part of the checked-in tree (build artifacts, per-project
 * config files written at runtime, sibling-repo paths). Keep this list short
 * and explicit — every entry is a deliberate exception.
 */
const KNOWN_MISSING_PATHS = new Set<string>([
	"src/ui/dist", // built by `bun run build:ui`
	"../burrow/SPEC.md", // sibling repo, not vendored
	".warren/config.yaml", // per-project file, written at runtime
]);

type Failure = { file: string; kind: string; detail: string };

export function loadPackageScripts(): Set<string> {
	const pkg = JSON.parse(readFileSync(resolve(REPO_ROOT, "package.json"), "utf8")) as {
		scripts?: Record<string, string>;
	};
	return new Set(Object.keys(pkg.scripts ?? {}));
}

export function extractFencedBashBlocks(markdown: string): string[] {
	const blocks: string[] = [];
	const fence = /```(?:bash|sh|shell)\n([\s\S]*?)```/g;
	let match: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
	while ((match = fence.exec(markdown)) !== null) {
		const body = match[1];
		if (body !== undefined) blocks.push(body);
	}
	return blocks;
}

export function stripShellComments(block: string): string {
	return block
		.split("\n")
		.map((line) => {
			const hash = line.indexOf("#");
			return hash === -1 ? line : line.slice(0, hash);
		})
		.join("\n");
}

export function extractBunRunScripts(blocks: string[]): Set<string> {
	const scripts = new Set<string>();
	const pattern = /\bbun\s+run\s+([a-zA-Z0-9:_-]+)/g;
	for (const rawBlock of blocks) {
		const block = stripShellComments(rawBlock);
		let m: RegExpExecArray | null;
		// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
		while ((m = pattern.exec(block)) !== null) {
			const name = m[1];
			if (name !== undefined) scripts.add(name);
		}
	}
	return scripts;
}

/**
 * Pull every backtick-quoted token that looks like a repo path (has a "/" or
 * ends in a known doc/config extension) and check it exists on disk. Trailing
 * punctuation and globs are tolerated.
 */
export function extractBacktickedPaths(markdown: string): string[] {
	const paths: string[] = [];
	const inline = /`([^`\n]+)`/g;
	let m: RegExpExecArray | null;
	// biome-ignore lint/suspicious/noAssignInExpressions: idiomatic regex loop
	while ((m = inline.exec(markdown)) !== null) {
		const raw = m[1];
		if (raw === undefined) continue;
		const token = raw.trim();
		// Heuristic: path-shaped if it contains a slash and starts with a path
		// char, or is a top-level doc/config file we care about. Skip URLs,
		// commands, code expressions, version pins.
		if (/^https?:\/\//.test(token)) continue;
		if (/\s/.test(token)) continue; // multi-token snippets are code, not paths
		if (token.startsWith("@")) continue; // npm scoped package name
		if (token.endsWith("...")) continue; // ellipsis placeholder, e.g. src/runs/...
		if (/^\.[A-Za-z0-9]+$/.test(token)) continue; // bare extension, e.g. `.ts`
		if (!/^[.A-Za-z0-9_][A-Za-z0-9_.\-/]*\/?$/.test(token)) continue;
		const looksLikePath =
			token.includes("/") || /\.(md|json|ya?ml|toml|ts|tsx|js|sh|lock)$/.test(token);
		if (!looksLikePath) continue;
		const cleaned = token.replace(/\/+$/, "");
		if (cleaned.includes("<") || cleaned.includes(">")) continue; // placeholder
		if (cleaned.includes("*")) continue; // glob
		paths.push(cleaned);
	}
	return paths;
}

function main(): number {
	const scripts = loadPackageScripts();
	const failures: Failure[] = [];

	for (const rel of TARGETS) {
		const abs = resolve(REPO_ROOT, rel);
		if (!existsSync(abs)) {
			failures.push({ file: rel, kind: "missing-doc", detail: `${rel} not found` });
			continue;
		}
		const src = readFileSync(abs, "utf8");

		const bunRunScripts = extractBunRunScripts(extractFencedBashBlocks(src));
		for (const name of bunRunScripts) {
			if (!scripts.has(name)) {
				failures.push({
					file: rel,
					kind: "missing-script",
					detail: `\`bun run ${name}\` referenced but not defined in package.json scripts`,
				});
			}
		}

		for (const p of extractBacktickedPaths(src)) {
			if (KNOWN_MISSING_PATHS.has(p)) continue;
			if (!existsSync(resolve(REPO_ROOT, p))) {
				failures.push({
					file: rel,
					kind: "missing-path",
					detail: `referenced path \`${p}\` does not exist`,
				});
			}
		}
	}

	if (failures.length === 0) {
		console.log(`✓ AGENTS.md validation passed (${TARGETS.join(", ")})`);
		return 0;
	}

	console.error("✗ AGENTS.md validation failed:");
	for (const f of failures) {
		console.error(`  [${f.kind}] ${f.file}: ${f.detail}`);
	}
	return 1;
}

if (import.meta.main) {
	process.exit(main());
}
