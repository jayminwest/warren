/**
 * Golden snapshot for the `GET /events` public event envelope
 * (pl-7e38 step 15 / warren-5eec). The Event explorer page (warren-24b9)
 * consumes `{ events, total, limit, offset }` in public mode, so the
 * spectator-facing event shape is pinned the same way the ops-overview
 * projection is: the live projection must byte-match the fixture.
 *
 * Regenerate with `WARREN_UPDATE_GOLDENS=1 bun test
 * src/server/handlers/events-query.golden.test.ts`, then inspect the
 * diff and commit only what you meant.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GlobalEventRow } from "../../runs/global-events.ts";
import { ANONYMOUS_ACTOR, OPERATOR_ACTOR } from "../auth.ts";
import { toWireEvent } from "./events-query.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "responses");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

function fixtureRow(overrides: Partial<GlobalEventRow>): GlobalEventRow {
	return {
		id: 42,
		runId: "run_golden0000000000000",
		sandboxEventSeq: 7,
		ts: "2026-01-01T00:00:06.000Z",
		kind: "tool_use",
		stream: "stdout",
		origin: "agent",
		payloadJson: { input: { command: "bun test" } },
		...overrides,
	} as GlobalEventRow;
}

describe("events-query public event golden", () => {
	test("spectator event shape matches the pinned fixture", () => {
		const body = {
			status: 200,
			body: {
				events: [
					toWireEvent(
						fixtureRow({
							kind: "reap_failed",
							stream: null,
							payloadJson: { step: "push", message: "stderr", path: "/data/x" },
						}),
						ANONYMOUS_ACTOR,
					),
					toWireEvent(fixtureRow({ id: 43, sandboxEventSeq: 8 }), ANONYMOUS_ACTOR),
				].filter((e) => e !== null),
				total: 2,
				limit: 100,
				offset: 0,
			},
		};
		const path = join(GOLDEN_DIR, "events-query-public.json");
		if (UPDATE || !existsSync(path)) {
			mkdirSync(GOLDEN_DIR, { recursive: true });
			writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`);
		}
		expect(body).toEqual(JSON.parse(readFileSync(path, "utf8")));
	});

	test("internal kinds drop to null for spectators but survive for operators", () => {
		const row = fixtureRow({ kind: "bridge_stalled", payloadJson: { sandboxId: "sbx-1" } });
		expect(toWireEvent(row, ANONYMOUS_ACTOR)).toBeNull();
		expect(toWireEvent(row, OPERATOR_ACTOR)?.payload).toEqual({ sandboxId: "sbx-1" });
	});
});
