import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * warren-47b0 regression guard: `sd` may only be spawned from inside the
 * seeds facade (`src/seeds-cli/`) and its tracker adapter
 * (`src/tracker/seeds-tracker.ts`). The hardcoded `exec.run("sd", ...)`
 * in `src/runs/reap/pr-context.ts` was invisible to a seedsCli grep and
 * failed silently — this test keeps that class of leak from coming back.
 */

/** The only modules allowed to reference the `sd` binary as a spawn target. */
const SD_SPAWN_ALLOWLIST = new Set(["src/tracker/seeds-tracker.ts"]);

/** Matches a spawn-style call naming `sd` as the command: run("sd", …). */
const SD_SPAWN_RE = /\.\s*run\(\s*(['"])sd\1/;

function listTsFiles(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		if (entry.name === "dist" || entry.name === "node_modules") continue;
		const full = join(dir, entry.name);
		if (entry.isDirectory()) {
			out.push(...listTsFiles(full));
		} else if (entry.name.endsWith(".ts")) {
			out.push(full);
		}
	}
	return out;
}

describe("sd spawn containment (warren-47b0)", () => {
	test("no 'sd' spawn literal outside src/seeds-cli/ and SeedsTracker", () => {
		const root = join(import.meta.dir, "..", "..");
		const offenders: string[] = [];
		for (const file of listTsFiles(join(root, "src"))) {
			const rel = file.slice(root.length + 1).replaceAll("\\", "/");
			if (SD_SPAWN_ALLOWLIST.has(rel)) continue;
			if (rel.startsWith("src/seeds-cli/")) continue;
			if (rel.endsWith(".test.ts")) continue;
			if (SD_SPAWN_RE.test(readFileSync(file, "utf8"))) {
				offenders.push(rel);
			}
		}
		expect(offenders).toEqual([]);
	});
});
