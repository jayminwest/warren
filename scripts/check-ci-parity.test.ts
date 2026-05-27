import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	checkParity,
	computeReachable,
	extractBunRunTargets,
	extractCiInvocations,
	listWorkflows,
} from "./check-ci-parity.ts";

describe("check-ci-parity", () => {
	test("extractBunRunTargets picks up package-script invocations only", () => {
		expect(extractBunRunTargets("bun run lint")).toEqual(["lint"]);
		expect(extractBunRunTargets("bun run lint && bun run typecheck")).toEqual([
			"lint",
			"typecheck",
		]);
		expect(extractBunRunTargets("bun run check:coverage")).toEqual(["check:coverage"]);
		expect(extractBunRunTargets("bun run check:bundle-size:build")).toEqual([
			"check:bundle-size:build",
		]);
		// Multi-line shell still works.
		expect(extractBunRunTargets("set -euo pipefail\nbun run lint\nbun run typecheck\n")).toEqual([
			"lint",
			"typecheck",
		]);
		// File invocations should NOT be treated as script names.
		expect(extractBunRunTargets("bun run scripts/foo.ts")).toEqual([]);
	});

	test("computeReachable walks the script dep graph transitively", () => {
		const scripts = {
			root: "bun run a && bun run b",
			a: "bun run c",
			b: "echo hi",
			c: "bun run d",
			d: "echo leaf",
			unrelated: "bun run a",
		};
		const { reachable } = computeReachable(scripts, "root");
		expect([...reachable].sort()).toEqual(["a", "b", "c", "d", "root"]);
	});

	test("listWorkflows finds the repo's ci yamls", () => {
		const found = listWorkflows().map((p) => p.split("/").pop());
		expect(found).toContain("ci.yml");
		expect(found).toContain("ci-postgres.yml");
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
			const invocations = extractCiInvocations(file);
			const scripts = invocations.map((i) => i.script).sort();
			expect(scripts).toEqual(["lint", "test:ci", "typecheck"]);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("current CI workflows are in parity with check:all", () => {
		const { failures, invocations } = checkParity();
		// Sanity: we should actually be checking something — empty
		// invocations would silently pass.
		expect(invocations.length).toBeGreaterThan(0);
		if (failures.length > 0) {
			const detail = failures
				.map((f) => `  ${f.workflow} job=${f.job} step=${f.step}: ${f.script} — ${f.reason}`)
				.join("\n");
			throw new Error(`CI parity drift:\n${detail}`);
		}
	});
});
