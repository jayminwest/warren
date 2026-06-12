#!/usr/bin/env bun
/**
 * CI <-> `check:all` parity drift detector — fleet-canonical port of
 * warren's original (warren-6296), generalized for the os-eco
 * check:all standard (docs/check-all-standard.md, os-eco-5db7).
 *
 * This file is BYTE-IDENTICAL across every conforming repo — do not
 * edit it in place. It imports the resolved GATES manifest from
 * ./check-all.ts as the single source of truth, parses every
 * `.github/workflows/ci*.yml`, and fails when any `bun run <X>`
 * invoked by a CI `run:` step is not transitively reachable from the
 * gate manifest — i.e. when CI enforces something `bun run check:all`
 * does not exercise locally.
 *
 * Per-repo escape hatches live OUTSIDE this file, in an optional
 * `scripts/ci-parity-config.json`:
 *
 *   {
 *     "aliases": { "check:coverage:ci": "check:coverage" },
 *     "ciOnly": ["report:test-timing", "report:quality-metrics"]
 *   }
 *
 *   - `aliases` maps a CI-side script name onto a canonical
 *     gate-reachable equivalent. Use for variants that run the same
 *     gate with a different reporter / preamble (e.g. a junit
 *     emitter).
 *   - `ciOnly` is the explicit allowlist of scripts that are
 *     intentionally CI-only (summaries / setup with no local
 *     equivalent). Adding here is the only sanctioned way to diverge;
 *     justify each entry in the config's "$comment".
 *
 * Anything outside those two sinks is drift: grow the manifest, change
 * the workflow, or add a justified escape-hatch entry.
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

export type ParityConfig = { aliases: Record<string, string>; ciOnly: ReadonlySet<string> };

type RawParityConfig = { aliases?: Record<string, string>; ciOnly?: string[] };

export function loadParityConfig(configPath: string = PARITY_CONFIG): ParityConfig {
	if (!existsSync(configPath)) return { aliases: {}, ciOnly: new Set() };
	const raw = JSON.parse(readFileSync(configPath, "utf8")) as RawParityConfig;
	return { aliases: raw.aliases ?? {}, ciOnly: new Set(raw.ciOnly ?? []) };
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

/**
 * Everything reachable from the gate manifest: the manifest itself,
 * the check:all / verify entry points, and the transitive closure of
 * `bun run <x>` references in script bodies.
 */
export function computeReachable(
	scripts: Record<string, string>,
	gates: readonly string[],
): Set<string> {
	const reachable = new Set<string>();
	const stack: string[] = [ROOT_GATE, "verify", ...gates];
	while (stack.length > 0) {
		const name = stack.pop();
		if (!name || reachable.has(name)) continue;
		reachable.add(name);
		const body = scripts[name];
		if (body === undefined) continue;
		for (const dep of extractBunRunTargets(body)) {
			if (!reachable.has(dep)) stack.push(dep);
		}
	}
	return reachable;
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

export function checkParity(): {
	invocations: CiInvocation[];
	reachable: Set<string>;
	failures: ParityFailure[];
} {
	const reachable = computeReachable(loadScripts(), GATES);
	const invocations: CiInvocation[] = [];
	for (const wf of listCiWorkflows()) {
		invocations.push(...extractCiInvocations(wf));
	}
	const failures = evaluateParity(invocations, reachable, loadParityConfig());
	return { invocations, reachable, failures };
}

function formatFailure(f: ParityFailure): string {
	return `  ${f.workflow} (job=${f.job}, step=${f.step}): bun run ${f.script} — ${f.reason}`;
}

function main(): void {
	const { invocations, reachable, failures } = checkParity();
	if (failures.length === 0) {
		console.log(
			`✓ CI parity: ${invocations.length} bun-run invocation(s) across CI workflows, ` +
				`all reachable from "${ROOT_GATE}" (${reachable.size} scripts in graph).`,
		);
		return;
	}
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
	process.exit(1);
}

if (import.meta.main) {
	main();
}
