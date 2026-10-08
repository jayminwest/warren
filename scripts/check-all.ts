#!/usr/bin/env bun
/**
 * Canonical quiet runner for the os-eco fleet `check:all` standard
 * (docs/check-all-standard.md at the os-eco root, os-eco-5db7).
 *
 * This file is BYTE-IDENTICAL across every conforming repo — do not
 * edit it in place. Per-repo variation comes exclusively from
 * package.json: the runner resolves its gate manifest by filtering the
 * canonical ordered gate list against the scripts the host repo
 * actually defines. Core gates are mandatory (a repo missing one fails
 * the run); conditional gates (check:bundle-size, gen:docs:check,
 * gen:openapi:check) run only where package.json defines them.
 *
 * Output contract ("quiet"):
 *   - one aligned `<status> <gate> (N.Ns)` line per gate
 *   - a one-line tally on success
 *   - on failure: the failing gate names plus parsed failure
 *     signatures from the captured output — never the full log — and
 *     the path of each failing gate's retained full log
 *   - CHECK_ALL_VERBOSE=1 streams every gate's full output instead
 *   - --bail stops at the first failing gate
 *
 * Log retention (warren-7e82): every captured gate's full stdout+stderr
 * is written to `<log dir>/<gate>.log`, with exit codes and timings in
 * `<log dir>/summary.json`, so a failure is diagnosable from the saved
 * output instead of a re-run. The log dir is `$CHECK_ALL_LOG_DIR` when
 * set, else a per-checkout directory under the OS temp dir. Each run
 * clears it first, so it only ever holds the latest run. A log write
 * failure warns and never changes the gate result.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const PACKAGE_JSON = resolve(REPO_ROOT, "package.json");

export type CanonicalGate = { name: string; conditional: boolean };

/**
 * The frozen, ordered gate vocabulary. Cheap static gates first,
 * conditional gates next, the expensive test+coverage gate
 * second-to-last, and the CI-parity meta-gate always LAST so it sees
 * the final manifest.
 */
export const CANONICAL_GATES: readonly CanonicalGate[] = [
	{ name: "lint", conditional: false },
	{ name: "typecheck", conditional: false },
	{ name: "check:agents", conditional: false },
	{ name: "check:dups", conditional: false },
	{ name: "check:deps", conditional: false },
	{ name: "check:size", conditional: false },
	{ name: "check:debt", conditional: false },
	{ name: "check:bundle-size", conditional: true },
	{ name: "gen:docs:check", conditional: true },
	{ name: "gen:openapi:check", conditional: true },
	{ name: "check:coverage", conditional: false },
	{ name: "check:ci-parity", conditional: false },
];

type PackageJson = { scripts?: Record<string, string> };

export function loadScripts(packageJsonPath: string = PACKAGE_JSON): Record<string, string> {
	if (!existsSync(packageJsonPath)) return {};
	const pkg = JSON.parse(readFileSync(packageJsonPath, "utf8")) as PackageJson;
	return pkg.scripts ?? {};
}

/**
 * Resolve the host repo's gate manifest: every core gate (whether or
 * not the repo defines it — a missing core gate must fail loudly, not
 * silently narrow the manifest) plus each conditional gate the repo's
 * package.json defines.
 */
export function resolveGates(scripts: Record<string, string>): string[] {
	return CANONICAL_GATES.filter((g) => !g.conditional || scripts[g.name] !== undefined).map(
		(g) => g.name,
	);
}

/** The host repo's resolved manifest — the single source of truth that
 *  check-ci-parity.ts imports. */
export const GATES: readonly string[] = resolveGates(loadScripts());

export function formatGateLine(
	status: "ok" | "fail",
	gate: string,
	seconds: number,
	width: number,
): string {
	const mark = status === "ok" ? "✓" : "✗";
	return `${mark} ${gate.padEnd(width)} (${seconds.toFixed(1)}s)`;
}

const SIGNATURE_RE =
	/^\(fail\) |^✗ |error TS\d+|: error |^✖|^Error: |\berror\b.*\bbudget\b|exceeds? .*budget|\bis below floor\b|could not find 'All files' row/i;
/**
 * Lines that can look like a signature but never are one: a passing,
 * skipped, or todo test (its NAME may describe the failure it checks
 * for, e.g. "fails when a file exceeds its frozen budget"), the package
 * manager's `$ <command>` echo, and its generic
 * `error: script "x" exited with code N` trailer, which every failing
 * gate prints and which says nothing about why it failed.
 */
const NOISE_RE = /^\((?:pass|skip|todo)\) |^✓ |^\$ |^error: script ".*" exited with code \d+/i;
const MAX_SIGNATURE_LINES = 50;
const TAIL_FALLBACK_LINES = 25;

/**
 * Pull the failure-relevant lines out of a gate's captured output:
 * known failure signatures (bun test `(fail)` lines, tsc/biome error
 * lines, budget-ratchet violations, coverage below-floor messages) when
 * present, otherwise the tail of the output.
 */
export function extractFailureSignatures(output: string): string[] {
	const lines = output.split("\n");
	const matched = lines.filter((l) => {
		const t = l.trim();
		return !NOISE_RE.test(t) && SIGNATURE_RE.test(t);
	});
	if (matched.length > 0) return matched.slice(0, MAX_SIGNATURE_LINES);
	return lines.filter((l) => l.trim() !== "").slice(-TAIL_FALLBACK_LINES);
}

/**
 * The directory that holds the latest run's per-gate logs:
 * `$CHECK_ALL_LOG_DIR` when set, else
 * `<os tmpdir>/check-all/<repo basename>-<hash of repo path>`. That is
 * stable per checkout and distinct across checkouts and worktrees.
 */
export function resolveLogDir(
	repoRoot: string = REPO_ROOT,
	env: Record<string, string | undefined> = process.env,
): string {
	const override = env.CHECK_ALL_LOG_DIR;
	if (override) return resolve(override);
	const hash = new Bun.CryptoHasher("sha1").update(repoRoot).digest("hex").slice(0, 8);
	return join(tmpdir(), "check-all", `${basename(repoRoot)}-${hash}`);
}

/** File name for a gate's log: `check:coverage` → `check-coverage.log`. */
export function gateLogName(gate: string): string {
	return `${gate.replace(/[^A-Za-z0-9._-]/g, "-")}.log`;
}

type GateResult = {
	gate: string;
	ok: boolean;
	exitCode: number | null;
	seconds: number;
	output: string;
	log?: string;
};

function runGate(gate: string, verbose: boolean): GateResult {
	const start = performance.now();
	const proc = Bun.spawnSync(["bun", "run", gate], {
		cwd: REPO_ROOT,
		stdout: verbose ? "inherit" : "pipe",
		stderr: verbose ? "inherit" : "pipe",
		env: process.env,
	});
	const seconds = (performance.now() - start) / 1000;
	const output = verbose
		? ""
		: `${proc.stdout?.toString() ?? ""}\n${proc.stderr?.toString() ?? ""}`;
	return { gate, ok: proc.exitCode === 0, exitCode: proc.exitCode, seconds, output };
}

/** Best-effort log I/O: a failure warns and never fails the gate. */
function tryLogIo(action: () => void): boolean {
	try {
		action();
		return true;
	} catch (err) {
		console.error(`check-all: log retention disabled (${String(err)})`);
		return false;
	}
}

function writeSummary(logDir: string, results: GateResult[]): void {
	const gates = results.map(({ gate, ok, exitCode, seconds, log }) => ({
		gate,
		ok,
		exitCode,
		seconds: Number(seconds.toFixed(3)),
		log: log ?? null,
	}));
	writeFileSync(join(logDir, "summary.json"), `${JSON.stringify({ gates }, null, "\t")}\n`);
}

/**
 * Retains each gate's captured output under `logDir`. Disabled in
 * verbose mode (nothing is captured) and after the first I/O failure.
 */
function createLogSink(logDir: string, enabled: boolean) {
	let active =
		enabled &&
		tryLogIo(() => {
			rmSync(logDir, { recursive: true, force: true });
			mkdirSync(logDir, { recursive: true });
		});
	return {
		write(result: GateResult): void {
			if (!active) return;
			const log = join(logDir, gateLogName(result.gate));
			active = tryLogIo(() => writeFileSync(log, result.output));
			if (active) result.log = log;
		},
		finish(results: GateResult[]): void {
			if (active) tryLogIo(() => writeSummary(logDir, results));
		},
	};
}

function reportFailures(failures: GateResult[]): void {
	console.error(
		`\n${failures.length} gate(s) failed: ${failures.map((f) => f.gate).join(", ")}\n`,
	);
	for (const f of failures) {
		console.error(`── ${f.gate} ──`);
		for (const line of extractFailureSignatures(f.output)) console.error(`  ${line}`);
		if (f.log) console.error(`  ↳ full log: ${f.log}  (search it instead of re-running)`);
		console.error(`  ↳ re-run: bun run ${f.gate}  (or CHECK_ALL_VERBOSE=1 bun run check:all)`);
	}
}

function main(): void {
	const verbose = process.env.CHECK_ALL_VERBOSE === "1";
	const bail = process.argv.includes("--bail");
	const width = Math.max(...GATES.map((g) => g.length));
	const results: GateResult[] = [];
	const overallStart = performance.now();
	const logs = createLogSink(resolveLogDir(), !verbose);

	for (const gate of GATES) {
		if (verbose) console.log(`\n── ${gate} ──`);
		const result = runGate(gate, verbose);
		logs.write(result);
		results.push(result);
		console.log(formatGateLine(result.ok ? "ok" : "fail", gate, result.seconds, width));
		if (!result.ok && bail) break;
	}
	logs.finish(results);

	const failures = results.filter((r) => !r.ok);
	const totalSeconds = (performance.now() - overallStart) / 1000;

	if (failures.length === 0) {
		console.log(`\n${results.length}/${GATES.length} gates passed (${totalSeconds.toFixed(1)}s)`);
		return;
	}
	reportFailures(failures);
	process.exit(1);
}

if (import.meta.main) {
	main();
}
