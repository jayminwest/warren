/**
 * Unit tests for the production `defaultPlotRenamer` (warren-bed0 /
 * pl-b0c0 step 3).
 *
 * Renames are pure metadata edits — allowed in every status — so we
 * round-trip a rename through a real `.plot/` fixture and assert the
 * on-disk `plot.json#/name` flips, a `note` event lands recording the
 * from→to transition, and a no-op rename (same name) returns success
 * without emitting a duplicate event.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserPlotClient } from "../plot-client/index.ts";
import { defaultPlotRenamer } from "./renamer.ts";

describe("defaultPlotRenamer", () => {
	test("round-trip: renames the Plot and appends a note event", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-rename-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Old name" });
			seedClient.close();

			const result = await defaultPlotRenamer.rename({
				plotDir: dir,
				plotId: seeded.id,
				handle: "alice",
				name: "New name",
			});

			expect(result.id).toBe(seeded.id);
			expect(result.name).toBe("New name");
			const notes = result.event_log.filter((e) => e.type === "note");
			expect(notes.length).toBe(1);
			const note = notes[0];
			if (note === undefined) throw new Error("expected a note event");
			expect((note.data as { text: string }).text).toContain('"Old name"');
			expect((note.data as { text: string }).text).toContain('"New name"');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("trims surrounding whitespace before applying", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-rename-trim-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Foo" });
			seedClient.close();

			const result = await defaultPlotRenamer.rename({
				plotDir: dir,
				plotId: seeded.id,
				handle: "alice",
				name: "  Trimmed  ",
			});

			expect(result.name).toBe("Trimmed");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("no-op rename (same name) does not emit a note event", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-rename-noop-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Stable" });
			seedClient.close();

			const result = await defaultPlotRenamer.rename({
				plotDir: dir,
				plotId: seeded.id,
				handle: "alice",
				name: "Stable",
			});

			expect(result.name).toBe("Stable");
			expect(result.event_log.filter((e) => e.type === "note").length).toBe(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("rename is allowed when the Plot is done (name is not frozen)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-rename-done-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Pre-done" });
			const handle = seedClient.get(seeded.id);
			await handle.setStatus("ready");
			await handle.setStatus("active");
			await handle.setStatus("done");
			seedClient.close();

			const result = await defaultPlotRenamer.rename({
				plotDir: dir,
				plotId: seeded.id,
				handle: "alice",
				name: "Post-done",
			});

			expect(result.name).toBe("Post-done");
			expect(result.status).toBe("done");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("empty name rejects synchronously", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-rename-empty-"));
		try {
			const seedClient = new UserPlotClient({
				dir,
				actor: { kind: "user", handle: "alice", raw: "user:alice" },
			});
			const seeded = await seedClient.create({ name: "Some" });
			seedClient.close();

			await expect(
				defaultPlotRenamer.rename({
					plotDir: dir,
					plotId: seeded.id,
					handle: "alice",
					name: "   ",
				}),
			).rejects.toThrow(/name must not be empty/);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
