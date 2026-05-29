import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn } from "./clone.ts";
import { CFG, ok } from "./refresh.test-helpers.ts";
import { refreshProjectClone } from "./refresh.ts";

describe("refreshProjectClone preserves .plot/ across reset (warren-b960, pl-d4d6)", () => {
	// These tests exercise the real defaultPreservePlot wrapper against
	// a real on-disk clone root, so the snapshot/restore fs operations
	// run end-to-end. spawn is still mocked — the "reset --hard" handler
	// is what simulates git wiping the working tree's `.plot/`.

	async function makeRoot(): Promise<string> {
		return await mkdtemp(join(tmpdir(), "warren-refresh-test-"));
	}

	async function countSnapshotDirs(): Promise<number> {
		const entries = await readdir(tmpdir());
		return entries.filter((n) => n.startsWith("warren-plot-snapshot-")).length;
	}

	test("byte-equality preservation of events.jsonl across refresh (criterion 4a)", async () => {
		const root = await makeRoot();
		try {
			const plotDir = join(root, ".plot");
			await mkdir(plotDir, { recursive: true });
			const eventsPath = join(plotDir, "plot-123.events.jsonl");
			// A stand-in for the events.jsonl warren's host-side appender
			// writes during a plan-run: plan_run_dispatched, two
			// run_dispatched lines, a final status_changed. We assert byte
			// equality after refresh, not parsed equality.
			const eventsBytes = Buffer.from(
				`{"kind":"plan_run_dispatched","ts":"2026-05-18T00:00:00.000Z"}\n` +
					`{"kind":"run_dispatched","runId":"r1"}\n` +
					`{"kind":"run_dispatched","runId":"r2"}\n` +
					`{"kind":"status_changed","status":"done"}\n`,
			);
			await writeFile(eventsPath, eventsBytes);

			const sha = "deadbeef".repeat(5);
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "reset" && cmd[3] === "origin/main") {
					// Simulate `git reset --hard origin/main` wiping the
					// working tree's host-appender writes. Without the
					// snapshot wrapper the file would be gone after this.
					await rm(plotDir, { recursive: true, force: true });
					await mkdir(plotDir, { recursive: true });
					return ok();
				}
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			const result = await refreshProjectClone({
				config: CFG,
				localPath: root,
				ref: "main",
				spawn,
			});

			expect(result.features.hasPlot).toBe(true);
			const restored = await readFile(eventsPath);
			expect(restored.equals(eventsBytes)).toBe(true);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("local-`done` status.json wins over origin-`active` on restore (criterion 4b)", async () => {
		const root = await makeRoot();
		try {
			const plotDir = join(root, ".plot");
			await mkdir(plotDir, { recursive: true });
			const statusPath = join(plotDir, "plot-abc.json");
			// Pre-refresh on-disk state: autoTransitionPlotToDone has fired
			// and the local snapshot says "done". Origin's committed copy
			// (simulated by the reset handler below) is still the older
			// "active". The snapshot/restore contract says the local wins.
			await writeFile(statusPath, JSON.stringify({ id: "plot-abc", status: "done" }));

			const sha = "a".repeat(40);
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "reset" && cmd[3] === "origin/main") {
					await rm(plotDir, { recursive: true, force: true });
					await mkdir(plotDir, { recursive: true });
					// Re-materialize the file with the older committed shape
					// so the restore step is the one responsible for getting
					// us back to status:\"done\".
					await writeFile(statusPath, JSON.stringify({ id: "plot-abc", status: "active" }));
					return ok();
				}
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			await refreshProjectClone({
				config: CFG,
				localPath: root,
				ref: "main",
				spawn,
			});

			const restored = JSON.parse(await readFile(statusPath, "utf8")) as {
				status: string;
			};
			expect(restored.status).toBe("done");
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("projects without .plot/ create no snapshot dirs (criterion 4c, 5)", async () => {
		const root = await makeRoot();
		try {
			// Deliberately do NOT mkdir .plot/. The wrapper's hadPlot
			// probe must short-circuit and never touch os.tmpdir().
			const sha = "c".repeat(40);
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			const before = await countSnapshotDirs();
			const result = await refreshProjectClone({
				config: CFG,
				localPath: root,
				ref: "main",
				spawn,
			});
			const after = await countSnapshotDirs();

			expect(result.features.hasPlot).toBe(false);
			expect(after).toBe(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("snapshot temp dirs cleaned up across 100 consecutive refreshes (criterion 6)", async () => {
		const root = await makeRoot();
		try {
			const plotDir = join(root, ".plot");
			await mkdir(plotDir, { recursive: true });
			await writeFile(join(plotDir, "plot-x.events.jsonl"), `{"kind":"x"}\n`);

			const sha = "f".repeat(40);
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			const before = await countSnapshotDirs();
			for (let i = 0; i < 100; i++) {
				await refreshProjectClone({
					config: CFG,
					localPath: root,
					ref: "main",
					spawn,
				});
			}
			const after = await countSnapshotDirs();
			expect(after).toBe(before);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("skips .plot/.index.db* SQLite index files (mx-239786 rebuild contract)", async () => {
		const root = await makeRoot();
		try {
			const plotDir = join(root, ".plot");
			await mkdir(plotDir, { recursive: true });
			// Mix index files (must NOT be preserved) with a real events
			// file (must be preserved). After refresh, the events file is
			// back and the index files are gone — letting Plot's existing
			// rebuild-on-open path repopulate the index cleanly.
			await writeFile(join(plotDir, ".index.db"), "sqlite-stale");
			await writeFile(join(plotDir, ".index.db-wal"), "wal-stale");
			await writeFile(join(plotDir, ".index.db-shm"), "shm-stale");
			await writeFile(join(plotDir, "plot-y.events.jsonl"), `{"kind":"y"}\n`);

			const sha = "b".repeat(40);
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "reset" && cmd[3] === "origin/main") {
					await rm(plotDir, { recursive: true, force: true });
					await mkdir(plotDir, { recursive: true });
					return ok();
				}
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			await refreshProjectClone({
				config: CFG,
				localPath: root,
				ref: "main",
				spawn,
			});

			const after = (await readdir(plotDir)).sort();
			expect(after).toEqual(["plot-y.events.jsonl"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("subdirectories under .plot/ are NOT preserved — git manages them (warren-af9e)", async () => {
		const root = await makeRoot();
		try {
			const plotDir = join(root, ".plot");
			const nestedDir = join(plotDir, "attachments", "plot-z");
			await mkdir(nestedDir, { recursive: true });
			await writeFile(join(nestedDir, "blob.bin"), Buffer.from([0x00, 0x01, 0x02, 0xff]));
			await writeFile(join(plotDir, "plot-z.events.jsonl"), `{"kind":"z"}\n`);

			const sha = "e".repeat(40);
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "reset" && cmd[3] === "origin/main") {
					await rm(plotDir, { recursive: true, force: true });
					await mkdir(plotDir, { recursive: true });
					return ok();
				}
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			await refreshProjectClone({
				config: CFG,
				localPath: root,
				ref: "main",
				spawn,
			});

			const after = (await readdir(plotDir)).sort();
			expect(after).toEqual(["plot-z.events.jsonl"]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("remote attachments survive refresh when host only changed status (warren-af9e)", async () => {
		const root = await makeRoot();
		try {
			const plotDir = join(root, ".plot");
			await mkdir(plotDir, { recursive: true });
			const statusPath = join(plotDir, "plot-abc.json");
			// Host-side: autoTransitionPlotToDone set status to "done"
			await writeFile(
				statusPath,
				JSON.stringify({
					id: "plot-abc",
					status: "done",
					attachments: [],
					updated_at: "2026-05-23T02:00:00.000Z",
				}),
			);

			const sha = "a".repeat(40);
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "reset" && cmd[3] === "origin/main") {
					await rm(plotDir, { recursive: true, force: true });
					await mkdir(plotDir, { recursive: true });
					// Remote has newer attachments but still-active status
					await writeFile(
						statusPath,
						JSON.stringify({
							id: "plot-abc",
							status: "active",
							attachments: [{ id: "att-1", type: "seeds_issue", ref: "sd-1", role: "child" }],
							intent: { goal: "Ship feature X" },
							updated_at: "2026-05-23T01:00:00.000Z",
						}),
					);
					return ok();
				}
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			await refreshProjectClone({
				config: CFG,
				localPath: root,
				ref: "main",
				spawn,
			});

			const merged = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
			expect(merged.status).toBe("done");
			expect(merged.updated_at).toBe("2026-05-23T02:00:00.000Z");
			expect(merged.attachments).toEqual([
				{ id: "att-1", type: "seeds_issue", ref: "sd-1", role: "child" },
			]);
			expect((merged as Record<string, Record<string, unknown>>).intent).toEqual({
				goal: "Ship feature X",
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("remote events survive refresh and host-appended events are merged in (warren-af9e)", async () => {
		const root = await makeRoot();
		try {
			const plotDir = join(root, ".plot");
			await mkdir(plotDir, { recursive: true });
			const eventsPath = join(plotDir, "plot-123.events.jsonl");
			// Snapshot has base events (also on remote) + host-appended events
			const baseEvent = '{"type":"plot_created","actor":"user:alice","at":"2026-05-23T00:00:00Z"}';
			const hostEvent =
				'{"type":"run_dispatched","actor":"agent:claude","at":"2026-05-23T01:00:00Z"}';
			await writeFile(eventsPath, `${baseEvent}\n${hostEvent}\n`);

			const sha = "b".repeat(40);
			const remoteOnlyEvent =
				'{"type":"attachment_added","actor":"user:bob","at":"2026-05-23T00:30:00Z"}';
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "reset" && cmd[3] === "origin/main") {
					await rm(plotDir, { recursive: true, force: true });
					await mkdir(plotDir, { recursive: true });
					// Remote has base event + a user-added event the host never saw
					await writeFile(eventsPath, `${baseEvent}\n${remoteOnlyEvent}\n`);
					return ok();
				}
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			await refreshProjectClone({
				config: CFG,
				localPath: root,
				ref: "main",
				spawn,
			});

			const merged = (await readFile(eventsPath, "utf8")).trim().split("\n");
			// Base event kept, remote-only event kept, host event appended
			expect(merged).toEqual([baseEvent, remoteOnlyEvent, hostEvent]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	test("same-status json takes remote version as-is (warren-af9e)", async () => {
		const root = await makeRoot();
		try {
			const plotDir = join(root, ".plot");
			await mkdir(plotDir, { recursive: true });
			const statusPath = join(plotDir, "plot-abc.json");
			// Host didn't change status — snapshot has stale attachments
			await writeFile(
				statusPath,
				JSON.stringify({ id: "plot-abc", status: "active", attachments: [] }),
			);

			const sha = "d".repeat(40);
			const spawn: SpawnFn = async (cmd) => {
				if (cmd[1] === "reset" && cmd[3] === "origin/main") {
					await rm(plotDir, { recursive: true, force: true });
					await mkdir(plotDir, { recursive: true });
					// Remote has same status but newer attachments
					await writeFile(
						statusPath,
						JSON.stringify({
							id: "plot-abc",
							status: "active",
							attachments: [{ id: "att-2" }],
						}),
					);
					return ok();
				}
				if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
				return ok();
			};

			await refreshProjectClone({
				config: CFG,
				localPath: root,
				ref: "main",
				spawn,
			});

			const result = JSON.parse(await readFile(statusPath, "utf8")) as Record<string, unknown>;
			expect(result.attachments).toEqual([{ id: "att-2" }]);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
