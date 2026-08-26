/**
 * Golden snapshot for the `GET /events` envelope (pl-7e38 step 15 /
 * warren-5eec). The operator page body is a new wire shape the Event
 * explorer consumes, so it is pinned the same way the ops-overview
 * projection is: the live handler-time mapping must byte-match the
 * fixture. Covers both audiences — the operator row passes through
 * untouched, the spectator row is the same mapping after `projectEvent`
 * (raw-failure payload sanitized, no operator-only keys).
 *
 * Regenerate with `WARREN_UPDATE_GOLDENS=1 bun test
 * src/server/handlers/events-query.golden.test.ts`, then inspect the diff
 * and commit only what you meant.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANONYMOUS_ACTOR, OPERATOR_ACTOR } from "../auth.ts";
import { projectedWireEvent } from "./runs/event-projection.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "responses");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

const FIXTURE_ROW = {
	id: 7,
	runId: "run-golden",
	sandboxEventSeq: 12,
	ts: "2026-08-27T00:00:00.000Z",
	kind: "reap_failed",
	stream: "system",
	origin: "agent",
	payloadJson: { step: "push", message: "raw stderr /host/path", path: "/data/secret" },
};

function bodyFor(actor: typeof OPERATOR_ACTOR | typeof ANONYMOUS_ACTOR) {
	const events = [projectedWireEvent(FIXTURE_ROW, actor)];
	return { status: 200, body: { events, total: 1, limit: 100, offset: 0 } };
}

describe("events query envelope golden", () => {
	test("operator body matches the pinned fixture", () => {
		const body = bodyFor(OPERATOR_ACTOR);
		const path = join(GOLDEN_DIR, "events-query-operator.json");
		if (UPDATE || !existsSync(path)) {
			mkdirSync(GOLDEN_DIR, { recursive: true });
			writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`);
		}
		expect(body).toEqual(JSON.parse(readFileSync(path, "utf8")));
	});

	test("spectator body matches the pinned fixture", () => {
		const body = bodyFor(ANONYMOUS_ACTOR);
		const path = join(GOLDEN_DIR, "events-query-public.json");
		if (UPDATE || !existsSync(path)) {
			mkdirSync(GOLDEN_DIR, { recursive: true });
			writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`);
		}
		expect(body).toEqual(JSON.parse(readFileSync(path, "utf8")));
	});
});
