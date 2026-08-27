#!/usr/bin/env bun
/**
 * Runtime-id literal guard (warren-c80e phase 1 item 5).
 *
 * The adapter registry (`src/runtime/adapters/`) is the seam that owns
 * per-runtime behavior. Before it existed, logic that varies by runtime was
 * scattered: the provider-error classifier baked pi's semantics into generic
 * code, and the harness-state prefix list was a flat `[".claude/"]` with no
 * per-runtime dispatch. Those two moved behind the seam in #887.
 *
 * A seam nothing defends erodes. Nothing stopped the next
 * `if (runtimeId === "claude-code")` from landing in a fresh module, and the
 * scattering would rebuild itself one branch at a time. This guard fails the
 * `lint` gate when a runtime-id literal is written outside the registry, so
 * new runtime-conditional code has to go through the adapter.
 *
 * Two false-positive controls, both borrowed from `check-wire-types.ts`:
 *
 *   1. The enforced literal list is DERIVED from `KNOWN_RUNTIME_IDS` in the
 *      canonical home at run time, never hand-copied. A second hard-coded
 *      list is itself the drift class this guard exists to prevent, and it
 *      would go stale the day a runtime is added or removed (sapling was
 *      removed while this issue was open).
 *   2. Every allowed file is listed explicitly with a reason. The gate is
 *      useless if it passes vacuously, so there is no wildcard.
 *
 * The allowlist is deliberately split in two, because the entries mean
 * opposite things:
 *
 *   - {@link DELIBERATE} names a runtime because that IS the file's job. A
 *     built-in agent definition declares which runtime it dispatches onto;
 *     a per-runtime shape record is keyed by runtime id by design. These
 *     entries are permanent.
 *   - {@link PENDING_ADAPTER} is runtime-conditional logic that predates the
 *     registry and has not moved behind it yet. These are the sites phase 2
 *     absorbs. Freezing them here means the residue can shrink but never
 *     grow: deleting an entry once its logic moves is the intended edit,
 *     adding one needs a maintainer to agree in review.
 *
 * Test files and test helpers are exempt, matching `check-wire-types.ts`: a
 * fixture legitimately names a runtime to build a case.
 *
 * Chained into `bun run lint` rather than taking a manifest slot, because
 * `scripts/check-all.ts` is byte-identical to the l5-toolkit template and its
 * gate vocabulary is frozen. Also runnable directly: `bun run check:runtime-ids`.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");

/**
 * Where the enforced literals are read from. The vocabulary lives in
 * `wire-runtime.ts`; `wire.ts` re-exports it, and both are exempt for the
 * obvious reason that the list has to be spelled somewhere.
 */
export const VOCABULARY_HOME = "src/core/wire-runtime.ts";

/** The seam that owns per-runtime behavior, and is therefore exempt. */
export const ADAPTER_ROOT = "src/runtime/adapters/";

/** Files exempt because naming a runtime is the file's whole purpose. */
const DELIBERATE: Readonly<Record<string, string>> = {
	"src/core/file-shape.ts": "per-runtime shape record, keyed by runtime id by design",
	"src/core/tool-shape.ts": "per-runtime shape record, keyed by runtime id by design",
	"src/core/usage-shape.ts": "per-runtime shape record, keyed by runtime id by design",
	"src/registry/schema.ts": "declares DEFAULT_RUNTIME_ID, the id agents fall back to",
	"src/registry/builtins/bugwatch.ts": "built-in agent declaring the runtime it dispatches onto",
	"src/registry/builtins/claude-code.ts": "built-in agent declaring the runtime it dispatches onto",
	"src/registry/builtins/healer.ts": "built-in agent declaring the runtime it dispatches onto",
	"src/registry/builtins/nightwatch.ts": "built-in agent declaring the runtime it dispatches onto",
	"src/registry/builtins/pi.ts": "built-in agent declaring the runtime it dispatches onto",
	"src/registry/builtins/planner.ts": "built-in agent declaring the runtime it dispatches onto",
	"src/registry/builtins/pr-fixer.ts": "built-in agent declaring the runtime it dispatches onto",
	"src/ui/src/pages/setup.helpers.ts":
		"onboarding starter prefill names the default shipped agent (warren-ed11)",
};

/**
 * Runtime-conditional logic that predates the adapter registry. Every entry
 * is a phase-2 candidate, not an endorsement. Shrink this list; do not grow
 * it.
 */
const PENDING_ADAPTER: Readonly<Record<string, string>> = {
	"src/runs/usage-aggregate.ts": "picks the usage shape by runtime; the adapter should answer",
	"src/runs/stream/bridge.ts": "tags in-stream usage by runtime at three call sites",
	"src/runs/stream/budget.ts": "same usage tag on the budget path",
	"src/runtime/local/drive-prepare.ts": "branches on claude-code for the local drive loop",
	"src/runtime/local/profile.ts": "per-runtime env passthrough and binary probe list",
};

export interface Violation {
	readonly file: string;
	readonly line: number;
	readonly literal: string;
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

/** True when the file is exempt, for either reason. */
export function isAllowed(rel: string): boolean {
	return rel in DELIBERATE || rel in PENDING_ADAPTER;
}

/**
 * The enforced literals, read from the vocabulary home's own source. Matches
 * the ids inside `KNOWN_RUNTIME_IDS = [...] as const`, so the list follows the
 * declaration instead of shadowing it.
 */
export function enforcedLiterals(repoRoot: string = REPO_ROOT): string[] {
	const text = readFileSync(resolve(repoRoot, VOCABULARY_HOME), "utf8");
	const found = /KNOWN_RUNTIME_IDS\s*=\s*\[([^\]]*)\]/.exec(text);
	if (found?.[1] === undefined) {
		throw new Error(
			`${VOCABULARY_HOME}: could not read KNOWN_RUNTIME_IDS. The guard derives its literal ` +
				"list from that declaration and refuses to fall back to a hand-copied one.",
		);
	}
	const ids = [...found[1].matchAll(/"([^"]+)"/g)].map((m) => m[1] ?? "");
	if (ids.length === 0) throw new Error(`${VOCABULARY_HOME}: KNOWN_RUNTIME_IDS is empty`);
	return ids;
}

/** Runtime-id literals written in one file's text. */
export function scanText(rel: string, text: string, literals: readonly string[]): Violation[] {
	const violations: Violation[] = [];
	const lines = text.split("\n");
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (isCommentLine(line.trim())) continue;
		for (const id of literals) {
			if (line.includes(`"${id}"`)) violations.push({ file: rel, line: i + 1, literal: id });
		}
	}
	return violations;
}

function* walk(dir: string): Generator<string> {
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) {
			if (entry === "node_modules" || entry === "dist" || entry === "__golden__") continue;
			yield* walk(abs);
		} else if (abs.endsWith(".ts") || abs.endsWith(".tsx")) {
			yield abs;
		}
	}
}

/** Walk `<repoRoot>/src` and collect every literal written outside the seam. */
export function scan(repoRoot: string = REPO_ROOT): Violation[] {
	const literals = enforcedLiterals(repoRoot);
	const violations: Violation[] = [];
	for (const abs of walk(resolve(repoRoot, "src"))) {
		const rel = relative(repoRoot, abs).split("\\").join("/");
		if (rel === VOCABULARY_HOME || rel.startsWith(ADAPTER_ROOT)) continue;
		if (isTestFile(rel) || isAllowed(rel)) continue;
		violations.push(...scanText(rel, readFileSync(abs, "utf8"), literals));
	}
	return violations;
}

/**
 * Allowlist entries whose file no longer writes any runtime-id literal. A
 * stale exemption is how an allowlist quietly becomes a wildcard, and a
 * `PENDING_ADAPTER` entry going stale is the good news this gate should
 * report rather than swallow.
 */
export function staleAllowEntries(repoRoot: string = REPO_ROOT): string[] {
	const literals = enforcedLiterals(repoRoot);
	const stale: string[] = [];
	for (const rel of [...Object.keys(DELIBERATE), ...Object.keys(PENDING_ADAPTER)]) {
		let text: string;
		try {
			text = readFileSync(resolve(repoRoot, rel), "utf8");
		} catch {
			stale.push(rel);
			continue;
		}
		if (scanText(rel, text, literals).length === 0) stale.push(rel);
	}
	return stale;
}

function main(): void {
	const literals = enforcedLiterals();

	const stale = staleAllowEntries();
	if (stale.length > 0) {
		console.error(`check:runtime-ids — ${stale.length} stale allowlist entr(ies):\n`);
		for (const rel of stale) console.error(`  ${rel} — no runtime-id literal left, or file gone`);
		console.error(
			"\nRemove the entry from DELIBERATE or PENDING_ADAPTER in\n" +
				"scripts/check-runtime-ids.ts. An exemption that guards nothing is how an\n" +
				"allowlist turns into a wildcard.",
		);
		process.exit(1);
	}

	const violations = scan();
	if (violations.length === 0) {
		const pending = Object.keys(PENDING_ADAPTER).length;
		console.log(
			`check:runtime-ids — ok (${literals.length} ids, ${pending} file(s) pending the adapter)`,
		);
		return;
	}

	console.error(
		`check:runtime-ids — ${violations.length} runtime-id literal(s) outside ${ADAPTER_ROOT}:\n`,
	);
	for (const v of violations) {
		console.error(`  ${v.file}:${v.line} — writes "${v.literal}"`);
	}
	console.error(
		`\nPer-runtime behavior belongs behind the adapter registry (${ADAPTER_ROOT}), so\n` +
			"the logic that varies by runtime lives in one place instead of scattering the\n" +
			"way the provider-error classifier and the harness-state prefixes did\n" +
			"(warren-c80e). Ask the run's adapter for the answer rather than branching on\n" +
			"the id. If the file genuinely names a runtime on purpose, add it to DELIBERATE\n" +
			"in scripts/check-runtime-ids.ts with a reason.",
	);
	process.exit(1);
}

if (import.meta.main) main();
