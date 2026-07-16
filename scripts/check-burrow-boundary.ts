#!/usr/bin/env bun
/**
 * Burrow import-boundary guard (warren-f796).
 *
 * The burrow-client eviction (buckets 1–9) re-homed every direct coupling to
 * warren's `src/burrow-client/` facade and burrow's own `@os-eco/burrow-cli`
 * package into a small set of local-topology modules. This guard MECHANICALLY
 * enforces that boundary so it can't silently regress: a new `import ... from
 * ".../burrow-client/..."` or `import ... from "@os-eco/burrow-cli"` outside the
 * allowlist fails the `lint` gate (this script is chained into `bun run lint`,
 * so `bun run check:all` and CI both catch it).
 *
 * Two boundaries, two allowlists:
 *
 *   1. The `src/burrow-client/` FACADE — the local burrow HTTP-over-unix-socket
 *      client. Local-topology only. Allowed in:
 *        - src/burrow-client/          (the facade itself)
 *        - src/runtime/local/          (the LocalProvider + its seams, incl.
 *                                        diagnostics/burrow.ts + boot-backend.ts)
 *        - src/runtime/registry.ts     (the `() => BurrowClient` factory seam)
 *        - src/supervisor/             (local-topology by definition)
 *
 *   2. The `@os-eco/burrow-cli` PACKAGE — burrow's library (transport/error
 *      types AND the in-pod agent framework). Allowed in the facade's homes PLUS
 *        - src/runtime/k8s/            (the pod agent harness uses burrow-cli's
 *                                        AgentRegistry / AgentRuntime — residual
 *                                        burrow surface, deliberately left).
 *
 * Test files + test helpers are exempt: they legitimately construct a real
 * BurrowClient to build a LocalProvider under test.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const SRC_ROOT = resolve(REPO_ROOT, "src");

/** Dirs (relative to repo root, POSIX) where the burrow-client FACADE is allowed. */
const FACADE_ALLOW = ["src/burrow-client/", "src/runtime/local/", "src/supervisor/"];
/** Exact files where the facade is allowed (beyond the dir prefixes above). */
const FACADE_ALLOW_FILES = ["src/runtime/registry.ts"];

/** Dirs where the `@os-eco/burrow-cli` PACKAGE is allowed. */
const PACKAGE_ALLOW = [...FACADE_ALLOW, "src/runtime/k8s/"];

const FROM_RE = /\bfrom\s*["']([^"']+)["']/;
const BARE_IMPORT_RE = /^import\s*["']([^"']+)["']/;

interface Violation {
	readonly file: string;
	readonly line: number;
	readonly spec: string;
	readonly kind: "facade" | "package";
}

function isTestFile(rel: string): boolean {
	return (
		rel.endsWith(".test.ts") ||
		rel.endsWith(".test.tsx") ||
		rel.includes("test-helper") ||
		rel.includes("test-support") ||
		rel.includes(".harness.") ||
		rel.includes("__golden__")
	);
}

function isCommentLine(trimmed: string): boolean {
	return trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*");
}

function importSpec(line: string): string | undefined {
	const trimmed = line.trim();
	if (isCommentLine(trimmed)) return undefined;
	const bare = BARE_IMPORT_RE.exec(trimmed);
	if (bare?.[1] !== undefined) return bare[1];
	// `from "X"` covers single-line and the closing line of a multi-line import.
	const from = FROM_RE.exec(line);
	return from?.[1];
}

function classify(spec: string): "facade" | "package" | undefined {
	if (spec === "@os-eco/burrow-cli" || spec.startsWith("@os-eco/burrow-cli/")) return "package";
	if (/(^|\/)burrow-client(\/|$)/.test(spec)) return "facade";
	return undefined;
}

function allowed(rel: string, kind: "facade" | "package"): boolean {
	if (kind === "facade") {
		return FACADE_ALLOW.some((d) => rel.startsWith(d)) || FACADE_ALLOW_FILES.includes(rel);
	}
	return PACKAGE_ALLOW.some((d) => rel.startsWith(d));
}

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) {
			if (entry === "node_modules" || entry === "__golden__") continue;
			yield* walk(abs);
		} else if (abs.endsWith(".ts") || abs.endsWith(".tsx")) {
			yield abs;
		}
	}
}

function scan(): Violation[] {
	const violations: Violation[] = [];
	for (const abs of walk(SRC_ROOT)) {
		const rel = relative(REPO_ROOT, abs).split("\\").join("/");
		if (isTestFile(rel)) continue;
		const lines = readFileSync(abs, "utf8").split("\n");
		for (let i = 0; i < lines.length; i++) {
			const spec = importSpec(lines[i] ?? "");
			if (spec === undefined) continue;
			const kind = classify(spec);
			if (kind === undefined) continue;
			if (allowed(rel, kind)) continue;
			violations.push({ file: rel, line: i + 1, spec, kind });
		}
	}
	return violations;
}

const violations = scan();
if (violations.length === 0) {
	console.log("check:burrow-boundary — ok (no out-of-boundary burrow imports)");
	process.exit(0);
}

console.error(
	`check:burrow-boundary — ${violations.length} forbidden burrow import(s) outside the allowlist:\n`,
);
for (const v of violations) {
	console.error(`  ${v.file}:${v.line} — ${v.kind} import "${v.spec}"`);
}
console.error(
	"\nThe burrow client / @os-eco/burrow-cli is local-topology only. Route runtime\n" +
		"calls through the RuntimeProvider seam (src/runtime/contract.ts) instead, or move\n" +
		"the coupling under src/runtime/local/ (see warren-f796).",
);
process.exit(1);
