/**
 * Unit tests for the production `defaultPlotCreator` (warren-411b /
 * pl-b085 step 1).
 *
 * The `POST /plots` handler injects a mock `PlotCreator`
 * (`plots.create.test.ts` → `fakeCreator`), so the real
 * create → optional `editIntent` → summary-with-fallbacks round-trip
 * is never exercised at the handler layer. These tests pin it here
 * against a real `@os-eco/plot-cli` `.plot/` fixture — same harness
 * shape as `intent-editor.test.ts` and `renamer.test.ts`.
 *
 * Coverage targets (acceptance §4 of pl-b085): `defaultPlotCreator.create`,
 * `hasIntentPatch` (both true / false returns), and `toEditIntentPatch`
 * all hit, lifting `src/plots/creator.ts` line coverage from 0% to 100%.
 * The `events.length > 0` fallback to `plot.updated_at` /
 * `user:<handle>` is defensive — `PlotStore.create` always appends a
 * `plot_created` event, so the empty-tail branch is unreachable through
 * the public creator flow; the happy-path test still executes the line
 * (non-empty tail) and pins the fallback source value
 * (`plot.updated_at === plot_created.at`).
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plot, PlotEvent } from "@os-eco/plot-cli";
import { type PlotProjectionSink, UserPlotClient } from "../plot-client/index.ts";
import { defaultPlotCreator } from "./creator.ts";

function makePlotDir(): string {
	return mkdtempSync(join(tmpdir(), "warren-plot-creator-"));
}

/**
 * Re-open the `.plot/` dir with a fresh client to verify what actually
 * landed on disk — independent of the creator's in-memory return value.
 * Read-only (no projection), so it never mutates the fixture.
 */
async function readFromDisk(
	dir: string,
	plotId: string,
): Promise<{ plot: Plot; events: PlotEvent[] }> {
	const client = new UserPlotClient({
		dir,
		actor: { kind: "user", handle: "alice", raw: "user:alice" },
	});
	try {
		const handle = client.get(plotId);
		const [plot, events] = await Promise.all([handle.read(), handle.events()]);
		return { plot, events };
	} finally {
		client.close();
	}
}

describe("defaultPlotCreator.create", () => {
	test("happy path: creates a drafting Plot and returns the summary from the plot_created tail", async () => {
		const dir = makePlotDir();
		try {
			const result = await defaultPlotCreator.create({
				plotDir: dir,
				handle: "alice",
				name: "Ship it",
			});

			expect(result.id).toMatch(/^plot-/);
			expect(result.name).toBe("Ship it");
			expect(result.status).toBe("drafting");
			expect(result.intent_goal_preview).toBe("");
			expect(result.attachments_count).toBe(0);

			// `create` always appends a `plot_created` event, so the tail is
			// non-empty and `last_event_*` come from it. `plot.updated_at`
			// equals `plot_created.at` for a fresh create (both are `now`),
			// which pins the defensive fallback source value too.
			const { plot, events } = await readFromDisk(dir, result.id);
			const tail = events[events.length - 1];
			if (tail === undefined) throw new Error("expected a plot_created event");
			expect(tail.type).toBe("plot_created");
			expect(result.last_event_ts).toBe(tail.at);
			expect(result.last_event_actor).toBe("user:alice");
			expect(plot.updated_at).toBe(tail.at);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("full intent patch routes through hasIntentPatch → toEditIntentPatch → editIntent", async () => {
		const dir = makePlotDir();
		try {
			const result = await defaultPlotCreator.create({
				plotDir: dir,
				handle: "alice",
				name: "With intent",
				intent: {
					goal: "ship oauth",
					non_goals: ["yak shave"],
					constraints: ["no new deps"],
					success_criteria: ["user logs in"],
				},
			});

			expect(result.id).toMatch(/^plot-/);
			expect(result.intent_goal_preview).toBe("ship oauth");

			const { plot, events } = await readFromDisk(dir, result.id);
			expect(plot.intent.goal).toBe("ship oauth");
			expect(plot.intent.non_goals).toEqual(["yak shave"]);
			expect(plot.intent.constraints).toEqual(["no new deps"]);
			expect(plot.intent.success_criteria).toEqual(["user logs in"]);

			// `editIntent` emits one `intent_edited` event per changed field;
			// the tail is now the last of those, so `last_event_ts` advances
			// past `plot_created` while `last_event_actor` stays the user.
			const edited = events.filter((e) => e.type === "intent_edited");
			expect(edited).toHaveLength(4);
			const tail = events[events.length - 1];
			if (tail === undefined) throw new Error("expected a tail event");
			expect(tail.type).toBe("intent_edited");
			expect(result.last_event_ts).toBe(tail.at);
			expect(result.last_event_actor).toBe("user:alice");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("partial intent patch (non_goals only) still routes through editIntent", async () => {
		const dir = makePlotDir();
		try {
			const result = await defaultPlotCreator.create({
				plotDir: dir,
				handle: "alice",
				name: "Partial intent",
				intent: { non_goals: ["one thing"] },
			});

			// goal is undefined → first `hasIntentPatch` guard is false, but
			// non_goals is non-empty → second guard returns true, so
			// `editIntent` runs with only `non_goals` set.
			expect(result.intent_goal_preview).toBe("");
			const { plot, events } = await readFromDisk(dir, result.id);
			expect(plot.intent.goal).toBe("");
			expect(plot.intent.non_goals).toEqual(["one thing"]);
			expect(plot.intent.constraints).toEqual([]);
			expect(plot.intent.success_criteria).toEqual([]);
			const edited = events.filter((e) => e.type === "intent_edited");
			expect(edited).toHaveLength(1);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("empty intent patch skips editIntent (hasIntentPatch false, all fields defined-but-empty)", async () => {
		const dir = makePlotDir();
		try {
			const result = await defaultPlotCreator.create({
				plotDir: dir,
				handle: "alice",
				name: "No-op intent",
				intent: {
					goal: "",
					non_goals: [],
					constraints: [],
					success_criteria: [],
				},
			});

			// `editIntent` is skipped: goal stays empty and no
			// `intent_edited` event lands. The tail is still `plot_created`.
			expect(result.intent_goal_preview).toBe("");
			const { plot, events } = await readFromDisk(dir, result.id);
			expect(plot.intent.goal).toBe("");
			expect(plot.intent.non_goals).toEqual([]);
			expect(events.filter((e) => e.type === "intent_edited")).toHaveLength(0);
			const tail = events[events.length - 1];
			if (tail === undefined) throw new Error("expected a plot_created event");
			expect(tail.type).toBe("plot_created");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("empty intent object skips editIntent (hasIntentPatch false, all fields undefined)", async () => {
		const dir = makePlotDir();
		try {
			const result = await defaultPlotCreator.create({
				plotDir: dir,
				handle: "alice",
				name: "Empty object intent",
				intent: {},
			});

			expect(result.intent_goal_preview).toBe("");
			const { events } = await readFromDisk(dir, result.id);
			expect(events.filter((e) => e.type === "intent_edited")).toHaveLength(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("threads the projection sink so the freshly-created Plot is upserted", async () => {
		const dir = makePlotDir();
		const upserts: Plot[] = [];
		const projection: PlotProjectionSink = {
			async upsert(plot) {
				upserts.push(plot);
			},
		};
		try {
			const result = await defaultPlotCreator.create({
				plotDir: dir,
				handle: "alice",
				name: "Projected",
				projection,
			});

			// `create` reads the freshly-minted Plot through the handle
			// (populating the projection), and the creator's own
			// `handle.read()` refreshes it again — so at least one upsert
			// lands, all keyed to the new Plot.
			expect(upserts.length).toBeGreaterThanOrEqual(1);
			for (const upsert of upserts) {
				expect(upsert.id).toBe(result.id);
			}
			const first = upserts[0];
			if (first === undefined) throw new Error("expected at least one projection upsert");
			expect(first.name).toBe("Projected");
			expect(first.status).toBe("drafting");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("propagates create errors after running the close() finally path", async () => {
		const dir = makePlotDir();
		try {
			// `PlotStore.create` rejects an empty name; the creator's
			// `finally { client.close() }` still runs and the error
			// propagates. The same finally guards the editIntent path.
			await expect(
				defaultPlotCreator.create({
					plotDir: dir,
					handle: "alice",
					name: "",
				}),
			).rejects.toThrow(/name is required/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
