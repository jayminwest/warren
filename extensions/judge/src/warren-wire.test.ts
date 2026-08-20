import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "bun:test";
import { PULL_REQUEST_LIFECYCLES, RUN_FAILURE_REASONS } from "./warren-wire.ts";

/**
 * The judge mirrors warren's wire vocabulary by hand (extensions never import
 * `src/`), so a value added to core without a matching edit here surfaces as a
 * `WireDriftError` the first time the judge reads such a run (#980, PR #991).
 * This guard reads core's source as TEXT — not an import — so the layer seam
 * holds; in a standalone checkout of the extension the file is absent and the
 * comparison skips.
 */
const CORE_WIRE = resolve(import.meta.dir, "../../../src/core/wire.ts");

function coreList(name: string): readonly string[] | null {
	if (!existsSync(CORE_WIRE)) return null;
	const src = readFileSync(CORE_WIRE, "utf8");
	const m = src.match(new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`));
	if (m?.[1] === undefined) throw new Error(`${name} not found in ${CORE_WIRE}`);
	return [...m[1].matchAll(/"([^"]+)"/g)].map((x) => x[1] ?? "");
}

describe("warren-wire mirror stays in sync with src/core/wire.ts", () => {
	test("RUN_FAILURE_REASONS matches core, in core's order", () => {
		const core = coreList("RUN_FAILURE_REASONS");
		if (core === null) return; // standalone checkout — nothing to compare against
		expect([...RUN_FAILURE_REASONS] as readonly string[]).toEqual([...core]);
	});

	test("PULL_REQUEST_LIFECYCLES matches core", () => {
		const core = coreList("PULL_REQUEST_LIFECYCLES");
		if (core === null) return;
		expect([...PULL_REQUEST_LIFECYCLES] as readonly string[]).toEqual([...core]);
	});
});
