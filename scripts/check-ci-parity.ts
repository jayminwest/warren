#!/usr/bin/env bun
/**
 * CI <-> `check:all` parity drift detector — fleet-canonical port of
 * warren's original (warren-6296), generalized for the os-eco
 * check:all standard (docs/check-all-standard.md, os-eco-5db7).
 *
 * This file is BYTE-IDENTICAL across every conforming repo — do not
 * edit it in place. It imports the resolved GATES manifest from
 * ./check-all.ts as the single source of truth, parses every
 * `.github/workflows/ci*.yml`, and asserts parity in BOTH directions
 * (warren-da69):
 *
 *   - CI -> local: every `bun run <X>` invoked by a CI `run:` step is
 *     transitively reachable from the gate manifest — i.e. CI never
 *     enforces something `bun run check:all` does not exercise.
 *   - local -> CI: every gate in the manifest is transitively invoked
 *     by some CI step — i.e. a gate can never silently vanish from
 *     (or never reach) CI.
 *
 * Per-repo escape hatches live OUTSIDE this file, in an optional
 * `scripts/ci-parity-config.json`:
 *
 *   {
 *     "aliases": { "check:coverage:ci": "check:coverage" },
 *     "ciOnly": ["report:test-timing", "report:quality-metrics"],
 *     "localOnly": []
 *   }
 *
 *   - `aliases` maps a CI-side script name onto a canonical
 *     gate-reachable equivalent. Use for variants that run the same
 *     gate with a different reporter / preamble (e.g. a junit
 *     emitter). It applies in both directions.
 *   - `ciOnly` is the explicit allowlist of scripts that are
 *     intentionally CI-only (summaries / setup with no local
 *     equivalent).
 *   - `localOnly` is its inverse: the explicit allowlist of manifest
 *     gates deliberately not run in CI (too slow, or needing tooling
 *     CI does not have). Adding to either list is the only sanctioned
 *     way to diverge; justify each entry in the config's "$comment".
 *
 * Anything outside those sinks is drift: grow the manifest, change the
 * workflow, or add a justified escape-hatch entry.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parse } from "yaml";
import { GATES } from "./check-all.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");
const PACKAGE_JSON = resolve(REPO_ROOT, "package.json");
const PARITY_CONFIG = resolve(import.meta.dir, "ci-parity-config.json");
const ROOT_GATE = "check:all";

export type ParityConfig = {
	aliases: Record<string, string>;
	ciOnly: ReadonlySet<string>;
	localOnly: ReadonlySet<string>;
};

type RawParityConfig = { aliases?: Record<string, string>; ciOnly?: string[]; localOnly?: string[] };

export function loadParityConfig(configPath: string = PARITY_CONFIG): ParityConfig {
	if (!existsSync(configPath)) return { aliases: {}, ciOnly: new Set(), localOnly: new Set() };
	const raw = JSON.parse(readFileSync(configPath, "utf8")) as RawParityConfig;
	return {
		aliases: raw.aliases ?? {},
		ciOnly: new Set(raw.ciOnly ?? []),
		localOnly: new Set(raw.localOnly ?? []),
	};
}

type PackageJson = { scripts?: Record<string, string> };

/** Tokens of the form `bun run <name>` that target a package script.
 *  `bun run scripts/foo.ts` (file invocation) is deliberately excluded. */
const BUN_RUN_RE = /\bbun\s+run\s+([A-Za-z][\w:-]*)(?![\w./:-])/g;

export function extractBunRunTargets(command: string): string[] {
	const out: string[] = [];
	for (const match of command.matchAll(BUN_RUN_RE)) {
		const name = match[1];
		if (name) out.push(name);
	}
	return out;
}

export function loadScripts(packageJsonPath: string = PACKAGE_JSON): Record<string, string> {
	if (!existsSync(packageJsonPath)) return {};
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
	return pkg.scripts ?? {};
}

/** Transitive closure of `bun run <x>` references in script bodies,
 *  seeded with `seeds` (which are themselves part of the result). */
function closeOver(scripts: Record<string, string>, seeds: readonly string[]): Set<string> {
	const seen = new Set<string>();
	const stack: string[] = [...seeds];
	while (stack.length > 0) {
		const name = stack.pop();
		if (!name || seen.has(name)) continue;
		seen.add(name);
		const body = scripts[name];
		if (body === undefined) continue;
		for (const dep of extractBunRunTargets(body)) {
			if (!seen.has(dep)) stack.push(dep);
		}
	}
	return seen;
}

/**
 * Everything reachable from the gate manifest: the manifest itself,
 * the check:all / verify entry points, and the transitive closure of
 * `bun run <x>` references in script bodies.
 */
export function computeReachable(
	scripts: Record<string, string>,
	gates: readonly string[],
): Set<string> {
	return closeOver(scripts, [ROOT_GATE, "verify", ...gates]);
}

type WorkflowStep = { run?: unknown };
type WorkflowJob = { steps?: WorkflowStep[] };
type WorkflowFile = { jobs?: Record<string, WorkflowJob> };

export type CiInvocation = { workflow: string; job: string; step: number; script: string };

export function extractCiInvocations(filePath: string, repoRoot: string = REPO_ROOT): CiInvocation[] {
	const text = readFileSync(filePath, "utf8");
	const doc = parse(text) as WorkflowFile | null;
	const workflow = relative(repoRoot, filePath);
	const out: CiInvocation[] = [];
	if (!doc || typeof doc !== "object" || !doc.jobs) return out;
	for (const [jobName, job] of Object.entries(doc.jobs)) {
		const steps = job?.steps;
		if (!Array.isArray(steps)) continue;
		steps.forEach((step, idx) => {
			const run = step?.run;
			if (typeof run !== "string") return;
			for (const script of extractBunRunTargets(run)) {
				out.push({ workflow, job: jobName, step: idx, script });
			}
		});
	}
	return out;
}

/** Gate workflows only (ci*.yml / ci*.yaml) — release/publish
 *  orchestration is intentionally out-of-band from the per-PR gate. */
export function listCiWorkflows(dir: string = WORKFLOWS_DIR): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => (f.endsWith(".yml") || f.endsWith(".yaml")) && f.startsWith("ci"))
		.map((f) => join(dir, f))
		.sort();
}

export type ParityFailure = CiInvocation & { canonical: string; reason: string };

export function evaluateParity(
	invocations: CiInvocation[],
	reachable: ReadonlySet<string>,
	config: ParityConfig,
): ParityFailure[] {
	const failures: ParityFailure[] = [];
	for (const inv of invocations) {
		const canonical = config.aliases[inv.script] ?? inv.script;
		if (config.ciOnly.has(canonical)) continue;
		if (reachable.has(canonical)) continue;
		const reason =
			canonical === inv.script
				? `not reachable from ${ROOT_GATE}`
				: `aliased to "${canonical}", which is not reachable from ${ROOT_GATE}`;
		failures.push({ ...inv, canonical, reason });
	}
	return failures;
}

/**
 * Everything CI transitively exercises: each script a CI step invokes
 * (mapped through `aliases`), plus the closure of `bun run <x>`
 * references in those script bodies.
 */
export function computeCiCoverage(
	scripts: Record<string, string>,
	invocations: readonly CiInvocation[],
	config: ParityConfig,
): Set<string> {
	return closeOver(
		scripts,
		invocations.map((inv) => config.aliases[inv.script] ?? inv.script),
	);
}

/** Manifest gates no CI workflow invokes, minus the `localOnly` allowlist. */
export function evaluateCoverage(
	gates: readonly string[],
	covered: ReadonlySet<string>,
	config: ParityConfig,
): string[] {
	return gates.filter((gate) => !covered.has(gate) && !config.localOnly.has(gate));
}

export function checkParity(): {
	invocations: CiInvocation[];
	reachable: Set<string>;
	failures: ParityFailure[];
	missingGates: string[];
} {
	const scripts = loadScripts();
	const config = loadParityConfig();
	const reachable = computeReachable(scripts, GATES);
	const invocations: CiInvocation[] = [];
	for (const wf of listCiWorkflows()) {
		invocations.push(...extractCiInvocations(wf));
	}
	const failures = evaluateParity(invocations, reachable, config);
	const missingGates = evaluateCoverage(
		GATES,
		computeCiCoverage(scripts, invocations, config),
		config,
	);
	return { invocations, reachable, failures, missingGates };
}

function formatFailure(f: ParityFailure): string {
	return `  ${f.workflow} (job=${f.job}, step=${f.step}): bun run ${f.script} — ${f.reason}`;
}

function reportUnreachable(failures: ParityFailure[]): void {
	console.error(
		`✗ CI parity drift: ${failures.length} CI step(s) invoke a script that is not ` +
			`reachable from "${ROOT_GATE}":\n`,
	);
	for (const f of failures) console.error(formatFailure(f));
	console.error(
		`\nFix one of:\n` +
			`  - Wire the script into the GATES manifest / a gate's script body.\n` +
			`  - Change CI to invoke a script that is already reachable.\n` +
			`  - If the step is intentionally CI-only (summary / setup with no local\n` +
			`    equivalent), add it to "ciOnly" in scripts/ci-parity-config.json with a\n` +
			`    justification in the config's "$comment".\n` +
			`  - If two scripts run the same gate under different names, map the CI name\n` +
			`    to its canonical equivalent in "aliases" in scripts/ci-parity-config.json.`,
	);
}

function reportUncovered(missingGates: string[], separator: string): void {
	console.error(
		`${separator}✗ CI parity drift: ${missingGates.length} manifest gate(s) are not ` +
			`invoked by any CI workflow:\n`,
	);
	for (const gate of missingGates) console.error(`  bun run ${gate}`);
	console.error(
		`\nFix one of:\n` +
			`  - Add a "bun run <gate>" step to a .github/workflows/ci*.yml job.\n` +
			`  - Point CI at a script that transitively runs the gate, mapping the CI-side\n` +
			`    name in "aliases" in scripts/ci-parity-config.json if it differs.\n` +
			`  - If the gate is intentionally local-only (too slow, or needing tooling CI\n` +
			`    does not have), add it to "localOnly" in scripts/ci-parity-config.json with\n` +
			`    a justification in the config's "$comment".`,
	);
}

function main(): void {
	const { invocations, reachable, failures, missingGates } = checkParity();
	if (failures.length === 0 && missingGates.length === 0) {
		console.log(
			`✓ CI parity: ${invocations.length} bun-run invocation(s) across CI workflows, ` +
				`all reachable from "${ROOT_GATE}" (${reachable.size} scripts in graph); ` +
				`all ${GATES.length} manifest gate(s) invoked by CI.`,
		);
		return;
	}
	if (failures.length > 0) reportUnreachable(failures);
	if (missingGates.length > 0) reportUncovered(missingGates, failures.length > 0 ? "\n" : "");
	process.exit(1);
}

if (import.meta.main) {
	main();
}
