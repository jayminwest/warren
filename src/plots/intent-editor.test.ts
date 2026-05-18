/**
 * Unit tests for the `assertIntentMutable` helper (warren-896f /
 * pl-9d6a step 9) and the production `defaultPlotIntentEditor`'s
 * round-trip behavior via a real `@os-eco/plot-cli` `.plot/` fixture.
 *
 * The frozen-at-done invariant lives in warren (the lib doesn't gate
 * intent edits on status), so we pin it at this layer rather than the
 * handler layer where it's exercised through HTTP fetches.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plot, PlotStatus } from "@os-eco/plot-cli";
import { UserPlotClient } from "../plot-client/index.ts";
import { PlotIntentFrozenError } from "./errors.ts";
import { assertIntentMutable, defaultPlotIntentEditor } from "./intent-editor.ts";

function plotOf(status: PlotStatus): Plot {
	return {
		schema_version: 1,
		id: "pt-test",
		name: "T",
		status,
		intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
		attachments: [],
		created_at: "2026-05-18T00:00:00Z",
		updated_at: "2026-05-18T00:00:00Z",
	};
}

describe("assertIntentMutable", () => {
	test("permits drafting / ready / active", () => {
		expect(() => assertIntentMutable(plotOf("drafting"))).not.toThrow();
		expect(() => assertIntentMutable(plotOf("ready"))).not.toThrow();
		expect(() => assertIntentMutable(plotOf("active"))).not.toThrow();
	});

	test("throws PlotIntentFrozenError for done", () => {
		expect(() => assertIntentMutable(plotOf("done"))).toThrow(PlotIntentFrozenError);
	});

	test("throws PlotIntentFrozenError for archived", () => {
		expect(() => assertIntentMutable(plotOf("archived"))).toThrow(PlotIntentFrozenError);
	});
});

describe("defaultPlotIntentEditor", () => {
	test("round-trip: applies patch and returns the updated envelope", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-intent-edit-"));
		try {
			// Seed a fresh Plot via UserPlotClient so the editor has something
			// to read.
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Round-trip" });
			seedClient.close();

			const result = await defaultPlotIntentEditor.edit({
				plotDir: dir,
				plotId: seeded.id,
				handle: "alice",
				patch: { goal: "ship oauth", non_goals: ["yak shave"] },
			});

			expect(result.id).toBe(seeded.id);
			expect(result.intent.goal).toBe("ship oauth");
			expect(result.intent.non_goals).toEqual(["yak shave"]);
			expect(result.event_log.some((e) => e.type === "intent_edited")).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rejects with PlotIntentFrozenError when the Plot is done", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-intent-frozen-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Frozen" });
			// drafting → ready → active → done per SPEC §6.5.
			const handle = seedClient.get(seeded.id);
			await handle.setStatus("ready");
			await handle.setStatus("active");
			await handle.setStatus("done");
			seedClient.close();

			await expect(
				defaultPlotIntentEditor.edit({
					plotDir: dir,
					plotId: seeded.id,
					handle: "alice",
					patch: { goal: "too late" },
				}),
			).rejects.toBeInstanceOf(PlotIntentFrozenError);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
