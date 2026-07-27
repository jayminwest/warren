import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type CiInvocation,
	computeCiCoverage,
	computeReachable,
	evaluateCoverage,
	evaluateParity,
	extractBunRunTargets,
	extractCiInvocations,
	listCiWorkflows,
	loadParityConfig,
	type ParityConfig,
} from "./check-ci-parity.ts";

const inv = (script: string): CiInvocation => ({
	workflow: "ci.yml",
	job: "ci",
	step: 0,
	script,
});

describe("check-ci-parity", () => {
	test("extractBunRunTargets picks up package-script invocations only", () => {
		expect(extractBunRunTargets("bun run lint")).toEqual(["lint"]);
		expect(extractBunRunTargets("bun run lint && bun run typecheck")).toEqual([
			"lint",
			"typecheck",
		]);
		expect(extractBunRunTargets("bun run check:coverage")).toEqual(["check:coverage"]);
		// Multi-line shell still works.
		expect(extractBunRunTargets("set -euo pipefail\nbun run lint\nbun run typecheck\n")).toEqual([
			"lint",
			"typecheck",
		]);
		// File invocations should NOT be treated as script names.
		expect(extractBunRunTargets("bun run scripts/foo.ts")).toEqual([]);
	});

	test("computeReachable seeds from the gate manifest and walks transitively", () => {
		const scripts = {
			"check:all": "bun scripts/check-all.ts",
			verify: "bun run check:all",
			lint: "biome check .",
			"check:coverage": "bun run scripts/check-coverage.ts",
			"check:size": "bun run check:size:inner",
			"check:size:inner": "echo leaf",
			unrelated: "bun run lint",
		};
		const reachable = computeReachable(scripts, ["lint", "check:coverage", "check:size"]);
		expect(reachable.has("lint")).toBe(true);
		expect(reachable.has("check:size:inner")).toBe(true);
		expect(reachable.has("check:all")).toBe(true);
		expect(reachable.has("verify")).toBe(true);
		expect(reachable.has("unrelated")).toBe(false);
	});

	test("extractCiInvocations parses a synthetic workflow", () => {
		const dir = mkdtempSync(join(tmpdir(), "ci-parity-"));
		const file = join(dir, "ci.yml");
		writeFileSync(
			file,
			[
				"name: Synthetic",
				"on: [push]",
				"jobs:",
				"  ci:",
				"    runs-on: ubuntu-latest",
				"    steps:",
				"      - uses: actions/checkout@v6",
				"      - run: bun install",
				"      - run: bun run lint && bun run typecheck",
				"      - name: tests",
				"        run: |",
				"          bun run test:ci",
				"",
			].join("\n"),
		);
		try {
			const invocations = extractCiInvocations(file, dir);
			const scripts = invocations.map((i) => i.script).sort();
			expect(scripts).toEqual(["lint", "test:ci", "typecheck"]);
			expect(invocations[0]?.workflow).toBe("ci.yml");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("listCiWorkflows returns only ci*.yml, tolerating a missing dir", () => {
		expect(listCiWorkflows("/nonexistent/workflows")).toEqual([]);
		const dir = mkdtempSync(join(tmpdir(), "ci-parity-wf-"));
		try {
			writeFileSync(join(dir, "ci.yml"), "jobs: {}");
			writeFileSync(join(dir, "ci-postgres.yml"), "jobs: {}");
			writeFileSync(join(dir, "release.yml"), "jobs: {}");
			const found = listCiWorkflows(dir).map((p) => p.split("/").pop());
			expect(found).toEqual(["ci-postgres.yml", "ci.yml"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("loadParityConfig tolerates a missing config file", () => {
		const config = loadParityConfig("/nonexistent/ci-parity-config.json");
		expect(config.aliases).toEqual({});
		expect(config.ciOnly.size).toBe(0);
		expect(config.localOnly.size).toBe(0);
	});

	test("loadParityConfig reads localOnly alongside aliases + ciOnly", () => {
		const dir = mkdtempSync(join(tmpdir(), "ci-parity-cfg-"));
		const file = join(dir, "ci-parity-config.json");
		try {
			writeFileSync(
				file,
				JSON.stringify({
					aliases: { "check:coverage:ci": "check:coverage" },
					ciOnly: ["report:test-timing"],
					localOnly: ["check:bundle-size"],
				}),
			);
			const config = loadParityConfig(file);
			expect(config.aliases).toEqual({ "check:coverage:ci": "check:coverage" });
			expect([...config.ciOnly]).toEqual(["report:test-timing"]);
			expect([...config.localOnly]).toEqual(["check:bundle-size"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("evaluateParity flags drift and honors aliases + ciOnly", () => {
		const reachable = new Set(["check:all", "lint", "check:coverage"]);
		const config: ParityConfig = {
			aliases: { "check:coverage:ci": "check:coverage", "lint:special": "lint:missing" },
			ciOnly: new Set(["report:test-timing"]),
			localOnly: new Set(),
		};
		// Reachable directly — passes.
		expect(evaluateParity([inv("lint")], reachable, config)).toEqual([]);
		// Reachable via alias — passes.
		expect(evaluateParity([inv("check:coverage:ci")], reachable, config)).toEqual([]);
		// Allowlisted CI-only — passes.
		expect(evaluateParity([inv("report:test-timing")], reachable, config)).toEqual([]);
		// Unreachable — drift.
		const drift = evaluateParity([inv("test:ci")], reachable, config);
		expect(drift).toHaveLength(1);
		expect(drift[0]?.reason).toContain("not reachable");
		// Aliased to something itself unreachable — drift with the aliased reason.
		const aliasDrift = evaluateParity([inv("lint:special")], reachable, config);
		expect(aliasDrift).toHaveLength(1);
		expect(aliasDrift[0]?.canonical).toBe("lint:missing");
		expect(aliasDrift[0]?.reason).toContain("aliased to");
	});

	test("computeCiCoverage walks CI steps through aliases and transitively", () => {
		const scripts = {
			"check:coverage": "bun run scripts/check-coverage.ts",
			"check:coverage:ci": "bun run scripts/check-coverage.ts --junit",
			"gate:umbrella": "bun run lint && bun run typecheck",
			lint: "biome check .",
			typecheck: "tsc --noEmit",
			"check:size": "bun run scripts/check-file-sizes.ts",
		};
		const config: ParityConfig = {
			aliases: { "check:coverage:ci": "check:coverage" },
			ciOnly: new Set(),
			localOnly: new Set(),
		};
		const covered = computeCiCoverage(
			scripts,
			[inv("gate:umbrella"), inv("check:coverage:ci")],
			config,
		);
		// Transitive through an umbrella script.
		expect(covered.has("lint")).toBe(true);
		expect(covered.has("typecheck")).toBe(true);
		// Alias maps the CI-side name onto the canonical gate.
		expect(covered.has("check:coverage")).toBe(true);
		// Never invoked by CI.
		expect(covered.has("check:size")).toBe(false);
	});

	test("evaluateCoverage flags manifest gates CI never runs, honoring localOnly", () => {
		const config: ParityConfig = {
			aliases: {},
			ciOnly: new Set(),
			localOnly: new Set(["check:bundle-size"]),
		};
		const gates = ["lint", "typecheck", "gen:openapi:check", "check:bundle-size"];
		const covered = new Set(["lint", "typecheck"]);
		// Uncovered and not allowlisted — drift; the allowlisted gate is exempt.
		expect(evaluateCoverage(gates, covered, config)).toEqual(["gen:openapi:check"]);
		// Fully covered — clean.
		expect(evaluateCoverage(gates, new Set([...gates]), config)).toEqual([]);
	});
});
