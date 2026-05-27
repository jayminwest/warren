#!/usr/bin/env bun
/**
 * CI <-> `check:all` parity drift detector (warren-6296, plan pl-da5b step 3).
 *
 * Parses the GitHub Actions workflows under `.github/workflows/` (today
 * `ci.yml` + `ci-postgres.yml`) and, for every `bun run <X>` invoked by
 * any `run:` step, verifies that `<X>` is transitively reachable from
 * the `check:all` script in `package.json` — i.e. running
 * `bun run check:all` locally exercises the same gate that CI does.
 *
 * Two structured escape hatches keep the detector usable without
 * collapsing every CI step into `check:all` verbatim:
 *
 *   - `ALIASES` — maps a CI-side script name onto a canonical
 *     check:all-reachable equivalent. Use this for variants that do
 *     "the same gate, formatted differently" (e.g. `check:coverage:ci`
 *     is `check:coverage` plus a JUnit reporter; `check:bundle-size`
 *     is `check:bundle-size:build` minus the embedded `build:ui`).
 *
 *   - `CI_ONLY` — explicit allowlist of scripts that are intentionally
 *     CI-only (summaries / reports / setup steps with no local
 *     equivalent). Adding to this list is the only sanctioned way to
 *     diverge — and each entry should be justified.
 *
 * Anything outside those two sinks is treated as drift: either
 * `check:all` needs to grow to cover the CI step, the workflow needs
 * to invoke a different script, or — if it really is CI-only —
 * `CI_ONLY` needs a new entry.
 *
 * Wired into `bun run check:all` so a PR that adds a CI step without
 * also wiring it into the local gate fails before merge.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import yaml from "js-yaml";

const REPO_ROOT = resolve(import.meta.dir, "..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github/workflows");
const PACKAGE_JSON = resolve(REPO_ROOT, "package.json");
const ROOT_GATE = "check:all";

/**
 * CI-side script names whose semantics are covered (under a different
 * name) by something reachable from `check:all`. Add an entry only
 * when the two scripts truly run the same gate, just with different
 * reporters / preamble / output paths.
 */
const ALIASES: Record<string, string> = {
	// check:coverage:ci is check:coverage + JUnit reporter for the CI
	// test-timing summary. The underlying gate (tests + coverage
	// ratchet) is identical.
	"check:coverage:ci": "check:coverage",
	// check:bundle-size (without :build) assumes `src/ui/dist/` already
	// exists; check:bundle-size:build calls `bun run build:ui` first via
	// spawnSync. The assertion logic — the bundle-size ratchet — is the
	// same. check:all uses the self-contained :build variant.
	"check:bundle-size": "check:bundle-size:build",
};

/**
 * Scripts CI is allowed to invoke without a check:all-side counterpart.
 * These are non-gating (informational summaries) or CI-environment
 * setup (UI dep install, UI build prereqs not needed locally because
 * the :build variants embed them).
 */
const CI_ONLY: ReadonlySet<string> = new Set<string>([
	// UI workspace install — local `bun install` at the repo root +
	// `bun run build:ui` (embedded in check:bundle-size:build) already
	// covers this for the gate path.
	"ui:install",
	// build:ui — invoked by check:bundle-size:build via spawnSync
	// rather than `bun run`, so it doesn't show up in the reachability
	// walk; CI invokes it explicitly so the build step is visible in
	// logs (see warren-5abc design note in check-bundle-size.ts).
	"build:ui",
	// Reporting steps — they post step-summary panels from artifacts
	// produced by the gate proper. Local devs read the same data from
	// `coverage/` and `test-results/` directly.
	"report:test-timing",
	"report:quality-metrics",
]);

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

export function loadScripts(): Record<string, string> {
	const pkg = JSON.parse(readFileSync(PACKAGE_JSON, "utf8")) as PackageJson;
	return pkg.scripts ?? {};
}

export function computeReachable(
	scripts: Record<string, string>,
	root: string,
): { reachable: Set<string>; missing: string[] } {
	const reachable = new Set<string>();
	const missing: string[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const name = stack.pop();
		if (!name || reachable.has(name)) continue;
		reachable.add(name);
		const body = scripts[name];
		if (body === undefined) {
			// Root or referenced-but-undefined script. We tolerate
			// missing-from-package here only for the root (caller's
			// responsibility) — log all of them, the caller decides.
			missing.push(name);
			continue;
		}
		for (const dep of extractBunRunTargets(body)) {
			if (!reachable.has(dep)) stack.push(dep);
		}
	}
	return { reachable, missing };
}

type WorkflowStep = { run?: unknown };
type WorkflowJob = { steps?: WorkflowStep[] };
type WorkflowFile = { jobs?: Record<string, WorkflowJob> };

export type CiInvocation = { workflow: string; job: string; step: number; script: string };

export function extractCiInvocations(filePath: string): CiInvocation[] {
	const text = readFileSync(filePath, "utf8");
	const doc = yaml.load(text) as WorkflowFile | null;
	const workflow = relative(REPO_ROOT, filePath);
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

export function listWorkflows(dir: string = WORKFLOWS_DIR): string[] {
	if (!existsSync(dir)) return [];
	return readdirSync(dir)
		.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))
		.map((f) => join(dir, f))
		.sort();
}

export type ParityFailure = CiInvocation & { canonical: string; reason: string };

export function checkParity(): {
	invocations: CiInvocation[];
	reachable: Set<string>;
	failures: ParityFailure[];
} {
	const scripts = loadScripts();
	const { reachable } = computeReachable(scripts, ROOT_GATE);
	const failures: ParityFailure[] = [];
	const invocations: CiInvocation[] = [];
	for (const wf of listWorkflows()) {
		// Skip release.yml: release-time orchestration (tag, publish,
		// changelog) is intentionally out-of-band from the per-PR gate.
		// We only check the gate workflows (anything matching ci*.yml).
		const base = wf.split("/").pop() ?? wf;
		if (!base.startsWith("ci")) continue;
		invocations.push(...extractCiInvocations(wf));
	}
	for (const inv of invocations) {
		const canonical = ALIASES[inv.script] ?? inv.script;
		if (CI_ONLY.has(canonical)) continue;
		if (reachable.has(canonical)) continue;
		const reason =
			canonical === inv.script
				? `not reachable from ${ROOT_GATE}`
				: `aliased to "${canonical}", which is not reachable from ${ROOT_GATE}`;
		failures.push({ ...inv, canonical, reason });
	}
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
			`  - Wire the script into the "${ROOT_GATE}" chain in package.json.\n` +
			`  - Change CI to invoke a script that is already in the chain.\n` +
			`  - If the step is intentionally CI-only (summary / setup with no local\n` +
			`    equivalent), add the canonical name to CI_ONLY in scripts/check-ci-parity.ts\n` +
			`    with a justification comment.\n` +
			`  - If two scripts run the same gate under different names, map the CI name\n` +
			`    to its canonical equivalent in ALIASES.`,
	);
	process.exit(1);
}

if (import.meta.main) {
	main();
}
