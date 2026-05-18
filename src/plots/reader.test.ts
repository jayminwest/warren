/**
 * Reader contract tests (warren-961e / pl-9d6a step 8).
 *
 * The live `UserPlotClient` round-trip is exercised end-to-end by
 * scenario 29 (warren-c40b). Here we pin two cheap invariants the
 * handler depends on:
 *
 *   - `defaultPlotReader.read` exists and round-trips a Plot's
 *     `intent` / `attachments` / `event_log` against a real `.plot/`
 *     directory created by `UserPlotClient.create`.
 *   - `event_log` is returned sorted by `at` ascending — the wire
 *     contract `GET /plots/:id` pins regardless of the Plot library's
 *     internal append order.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserPlotClient } from "../plot-client/index.ts";
import { defaultPlotReader } from "./reader.ts";

describe("defaultPlotReader", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warren-plot-reader-"));
	});

	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("round-trips a Plot's intent, attachments, and event_log; events sorted ascending by at", async () => {
		const client = new UserPlotClient({
			dir,
			actor: { kind: "user", handle: "alice", raw: "user:alice" },
		});
		let plotId: string;
		try {
			const handle = await client.create({ name: "P" });
			plotId = handle.id;
			await handle.editIntent({ goal: "ship it", non_goals: ["yak shave"] });
			await handle.attach({
				type: "seeds_issue",
				ref: "warren-961e",
				role: "primary",
			});
			await handle.append({ type: "note", data: { text: "second" } });
		} finally {
			client.close();
		}

		const result = await defaultPlotReader.read({ plotDir: dir, plotId });
		expect(result.id).toBe(plotId);
		expect(result.name).toBe("P");
		expect(result.intent.goal).toBe("ship it");
		expect(result.intent.non_goals).toEqual(["yak shave"]);
		expect(result.attachments).toHaveLength(1);
		const att = result.attachments[0];
		if (att === undefined) throw new Error("expected one attachment");
		expect(att.type).toBe("seeds_issue");
		expect(att.ref).toBe("warren-961e");

		// Ascending sort: first event is plot_created.
		expect(result.event_log.length).toBeGreaterThanOrEqual(3);
		const types = result.event_log.map((e) => e.type);
		expect(types[0]).toBe("plot_created");
		expect(types).toContain("intent_edited");
		expect(types).toContain("attachment_added");
		expect(types[types.length - 1]).toBe("note");

		// Strict ascending `at`.
		for (let i = 1; i < result.event_log.length; i++) {
			const prev = result.event_log[i - 1];
			const curr = result.event_log[i];
			if (prev === undefined || curr === undefined) throw new Error("unreachable");
			expect(prev.at <= curr.at).toBe(true);
		}
	});
});
