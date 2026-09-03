/**
 * Golden snapshot for the `GET /ops/overview` public projection envelope
 * (pl-7e38 step 12 / warren-d850). The reduced spectator body is a stable
 * wire shape the Operations page consumes in public mode, so it is pinned
 * the same way the error envelopes are (`responses.golden.test.ts`):
 * the live `toPublicOpsOverview` projection must byte-match the fixture.
 *
 * Regenerate with `WARREN_UPDATE_GOLDENS=1 bun test
 * src/server/handlers/ops-overview.golden.test.ts`, then inspect the diff
 * and commit only what you meant.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { OpsOverview } from "../../runs/ops-overview.ts";
import { toPublicOpsOverview } from "./ops-overview.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "responses");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

/** A fixed full snapshot; only the projection matters, not the numbers. */
const FIXTURE_OVERVIEW: OpsOverview = {
	runs: {
		byState: { queued: 2, running: 1, succeeded: 5, failed: 1, cancelled: 0 },
		nonTerminal: 3,
		total: 9,
	},
	window: "24h",
	spend: { totalUsd: 12.5, windowUsd: 3.25, windowRuns: 4 },
	delivery: { branchesPushed: 4, prsOpened: 3, prsMerged: 2 },
	services: { dbReachable: true, runtime: "local", lifecycleStream: true },
	generatedAt: "2026-08-27T00:00:00.000Z",
};

describe("ops-overview public projection golden", () => {
	test("reduced spectator body matches the pinned fixture", () => {
		const body = { status: 200, body: toPublicOpsOverview(FIXTURE_OVERVIEW) };
		const path = join(GOLDEN_DIR, "ops-overview-public.json");
		if (UPDATE || !existsSync(path)) {
			mkdirSync(GOLDEN_DIR, { recursive: true });
			writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`);
		}
		expect(body).toEqual(JSON.parse(readFileSync(path, "utf8")));
	});
});
