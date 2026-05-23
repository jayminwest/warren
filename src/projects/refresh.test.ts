import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn, SpawnResult } from "./clone.ts";
import type { ProjectsConfig } from "./config.ts";
import { ProjectUnavailableError } from "./errors.ts";
import {
	detectProjectFeatures,
	mergeEventsLines,
	mergePlotJsonForRefresh,
	refreshProjectClone,
} from "./refresh.ts";

const CFG: ProjectsConfig = { root: "/data/projects", gitBinary: "git" };

interface Recorded {
	cmd: readonly string[];
	cwd: string;
}

function recorder(handler: (cmd: readonly string[]) => SpawnResult): {
	spawn: SpawnFn;
	calls: Recorded[];
} {
	const calls: Recorded[] = [];
	const spawn: SpawnFn = async (cmd, opts) => {
		calls.push({ cmd, cwd: opts.cwd });
		return handler(cmd);
	};
	return { spawn, calls };
}

function ok(stdout = ""): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

describe("refreshProjectClone", () => {
	test("fetches, checks out ref, hard-resets to origin/<ref>, scrubs stale user identity, and returns HEAD sha", async () => {
		const sha = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
		});

		expect(result).toEqual({
			headSha: sha,
			ref: "main",
			features: { hasPlot: true, hasSeeds: true },
		});
		expect(calls.map((c) => c.cmd[1])).toEqual([
			"fetch",
			"checkout",
			"reset",
			"config",
			"config",
			"rev-parse",
		]);
		expect(calls[0]?.cmd).toEqual(["git", "fetch", "--prune", "origin"]);
		expect(calls[1]?.cmd).toEqual(["git", "checkout", "--force", "main"]);
		expect(calls[2]?.cmd).toEqual(["git", "reset", "--hard", "origin/main"]);
		expect(calls[3]?.cmd).toEqual(["git", "config", "--local", "--unset-all", "user.name"]);
		expect(calls[4]?.cmd).toEqual(["git", "config", "--local", "--unset-all", "user.email"]);
		expect(calls.every((c) => c.cwd === "/data/projects/x/y")).toBe(true);
	});

	test("tolerates the user identity scrub exiting non-zero when keys are absent (warren-9f70)", async () => {
		const sha = "abcabcabcabcabcabcabcabcabcabcabcabcabca";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "config" && cmd.includes("--unset-all")) {
				// Real git exits 5 ("no such key") when the key is absent —
				// the normal case for clean clones.
				return { stdout: "", stderr: "", exitCode: 5 };
			}
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
		});

		expect(result.headSha).toBe(sha);
		// rev-parse still runs after a failed unset: the scrub is
		// best-effort and must not abort the refresh.
		expect(calls.map((c) => c.cmd[1])).toContain("rev-parse");
	});

	test("falls back to plain reset --hard <ref> when origin/<ref> does not resolve", async () => {
		const sha = "1111111111111111111111111111111111111111";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "reset" && cmd[3] === "origin/v1.2.3") {
				return { stdout: "", stderr: "unknown revision", exitCode: 128 };
			}
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "v1.2.3",
			spawn,
			exists: () => true,
		});

		expect(result.headSha).toBe(sha);
		const resetCalls = calls.filter((c) => c.cmd[1] === "reset");
		expect(resetCalls.map((c) => c.cmd[3])).toEqual(["origin/v1.2.3", "v1.2.3"]);
	});

	test("throws ProjectUnavailableError when localPath does not exist", async () => {
		const { spawn } = recorder(() => ok());
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/missing",
				ref: "main",
				spawn,
				exists: () => false,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("throws ProjectUnavailableError when fetch fails", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "fetch") {
				return { stdout: "", stderr: "fatal: could not read", exitCode: 128 };
			}
			return ok();
		});
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("wraps spawn-level failures (e.g. ENOENT for git binary) as ProjectUnavailableError", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT: git not found");
		};
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});

	test("probes for .plot/ alongside git ops and surfaces the boolean on features (warren-4e20)", async () => {
		const sha = "feedfacefeedfacefeedfacefeedfacefeedface";
		const probed: string[] = [];
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: (p) => {
				probed.push(p);
				if (p === "/data/projects/x/y") return true;
				if (p === "/data/projects/x/y/.plot") return false;
				return false;
			},
		});

		expect(result.features).toEqual({ hasPlot: false, hasSeeds: false });
		expect(probed).toContain("/data/projects/x/y/.plot");
	});

	test("probes for .seeds/ alongside git ops and surfaces the boolean on features (warren-9990)", async () => {
		const sha = "abadcafeabadcafeabadcafeabadcafeabadcafe";
		const probed: string[] = [];
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: (p) => {
				probed.push(p);
				if (p === "/data/projects/x/y") return true;
				if (p === "/data/projects/x/y/.seeds") return true;
				return false;
			},
		});

		expect(result.features).toEqual({ hasPlot: false, hasSeeds: true });
		expect(probed).toContain("/data/projects/x/y/.seeds");
	});

	test("throws ProjectUnavailableError when rev-parse returns empty", async () => {
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok("\n");
			return ok();
		});
		await expect(
			refreshProjectClone({
				config: CFG,
				localPath: "/data/projects/x/y",
				ref: "main",
				spawn,
				exists: () => true,
			}),
		).rejects.toBeInstanceOf(ProjectUnavailableError);
	});
});

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

describe("detectProjectFeatures", () => {
	test("returns hasPlot=true when .plot/ exists at the clone root", () => {
		const probed: string[] = [];
		const result = detectProjectFeatures("/data/projects/x/y", (p) => {
			probed.push(p);
			return p === "/data/projects/x/y/.plot";
		});
		expect(result).toEqual({ hasPlot: true, hasSeeds: false });
		expect(probed).toContain("/data/projects/x/y/.plot");
	});

	test("returns hasPlot=false when .plot/ is absent", () => {
		const result = detectProjectFeatures("/data/projects/x/y", () => false);
		expect(result).toEqual({ hasPlot: false, hasSeeds: false });
	});

	test("returns hasSeeds=true when .seeds/ exists at the clone root (warren-9990)", () => {
		const probed: string[] = [];
		const result = detectProjectFeatures("/data/projects/x/y", (p) => {
			probed.push(p);
			return p === "/data/projects/x/y/.seeds";
		});
		expect(result).toEqual({ hasPlot: false, hasSeeds: true });
		expect(probed).toContain("/data/projects/x/y/.seeds");
	});
});

describe("mergeEventsLines (warren-af9e)", () => {
	test("appends snapshot-only lines after remote lines", () => {
		const remote = '{"type":"a"}\n{"type":"b"}\n';
		const snapshot = '{"type":"a"}\n{"type":"c"}\n';
		const result = mergeEventsLines(remote, snapshot);
		expect(result).toBe('{"type":"a"}\n{"type":"b"}\n{"type":"c"}\n');
	});

	test("returns remote unchanged when snapshot is a subset", () => {
		const remote = '{"type":"a"}\n{"type":"b"}\n';
		const snapshot = '{"type":"a"}\n';
		const result = mergeEventsLines(remote, snapshot);
		expect(result).toBe(remote);
	});

	test("handles empty remote — all snapshot lines restored", () => {
		const snapshot = '{"type":"a"}\n{"type":"b"}\n';
		const result = mergeEventsLines("", snapshot);
		expect(result).toBe('{"type":"a"}\n{"type":"b"}\n');
	});

	test("deduplicates identical lines", () => {
		const remote = '{"type":"a"}\n';
		const snapshot = '{"type":"a"}\n{"type":"a"}\n';
		const result = mergeEventsLines(remote, snapshot);
		expect(result).toBe(remote);
	});
});

describe("mergePlotJsonForRefresh (warren-af9e)", () => {
	test("overlays snapshot status onto remote when status differs", () => {
		const remote = JSON.stringify({
			id: "plot-x",
			status: "active",
			attachments: [{ id: "att-1" }],
		});
		const snapshot = JSON.stringify({
			id: "plot-x",
			status: "done",
			attachments: [],
			updated_at: "2026-05-23T02:00:00Z",
		});
		const result = JSON.parse(mergePlotJsonForRefresh(remote, snapshot)) as Record<string, unknown>;
		expect(result.status).toBe("done");
		expect(result.attachments).toEqual([{ id: "att-1" }]);
		expect(result.updated_at).toBe("2026-05-23T02:00:00Z");
	});

	test("returns remote when status matches", () => {
		const remote = JSON.stringify({
			id: "plot-x",
			status: "active",
			attachments: [{ id: "att-2" }],
		});
		const snapshot = JSON.stringify({ id: "plot-x", status: "active", attachments: [] });
		expect(mergePlotJsonForRefresh(remote, snapshot)).toBe(remote);
	});

	test("returns remote when both are identical", () => {
		const data = JSON.stringify({ id: "plot-x", status: "done" });
		expect(mergePlotJsonForRefresh(data, data)).toBe(data);
	});

	test("falls back to snapshot on unparseable remote JSON", () => {
		const snapshot = '{"status":"done"}';
		expect(mergePlotJsonForRefresh("not-json", snapshot)).toBe(snapshot);
	});
});
