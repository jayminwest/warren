import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "./clone.ts";
import { ProjectUnavailableError } from "./errors.ts";
import { CFG, ok, recorder } from "./refresh.test-helpers.ts";
import {
	detectHooksPathFromPackageJson,
	detectProjectFeatures,
	mergeEventsLines,
	mergePlotJsonForRefresh,
	refreshProjectClone,
} from "./refresh.ts";

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

describe("detectHooksPathFromPackageJson (warren-8f4c)", () => {
	test("extracts hooksPath from standard prepare script", () => {
		const pkg = {
			scripts: { prepare: "[ -e .git ] && git config core.hooksPath scripts/hooks || true" },
		};
		expect(detectHooksPathFromPackageJson(pkg)).toBe("scripts/hooks");
	});

	test("extracts hooksPath from prepare script with --local flag", () => {
		const pkg = { scripts: { prepare: "git config --local core.hooksPath .githooks" } };
		expect(detectHooksPathFromPackageJson(pkg)).toBe(".githooks");
	});

	test("returns undefined when prepare is absent", () => {
		expect(detectHooksPathFromPackageJson({ scripts: { build: "tsc" } })).toBeUndefined();
	});

	test("returns undefined when scripts is absent", () => {
		expect(detectHooksPathFromPackageJson({ name: "my-pkg" })).toBeUndefined();
	});

	test("returns undefined when prepare has no git config hooksPath", () => {
		const pkg = { scripts: { prepare: "husky install" } };
		expect(detectHooksPathFromPackageJson(pkg)).toBeUndefined();
	});

	test("returns undefined for null input", () => {
		expect(detectHooksPathFromPackageJson(null)).toBeUndefined();
	});

	test("returns undefined for non-object input", () => {
		expect(detectHooksPathFromPackageJson("string")).toBeUndefined();
	});
});

describe("refreshProjectClone git-hooks arming (warren-8f4c)", () => {
	test("applies core.hooksPath when package.json prepare script matches", async () => {
		const sha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const pkg = JSON.stringify({
			scripts: { prepare: "git config core.hooksPath scripts/hooks || true" },
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
			readFileFn: async () => pkg,
		});

		expect(result.headSha).toBe(sha);
		const hookCmd = calls.find(
			(c) =>
				c.cmd[1] === "config" &&
				c.cmd.includes("core.hooksPath") &&
				c.cmd.includes("scripts/hooks"),
		);
		expect(hookCmd).toBeDefined();
		expect(hookCmd?.cmd).toEqual(["git", "config", "--local", "core.hooksPath", "scripts/hooks"]);
	});

	test("skips hook arming when armHooks is false", async () => {
		const sha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const pkg = JSON.stringify({ scripts: { prepare: "git config core.hooksPath scripts/hooks" } });
		await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
			armHooks: false,
			readFileFn: async () => pkg,
		});

		const hookCmds = calls.filter((c) => c.cmd.includes("core.hooksPath"));
		expect(hookCmds).toHaveLength(0);
	});

	test("skips hook arming when package.json has no matching prepare script", async () => {
		const sha = "cccccccccccccccccccccccccccccccccccccccc";
		const { spawn, calls } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const pkg = JSON.stringify({ scripts: { build: "tsc" } });
		await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
			readFileFn: async () => pkg,
		});

		const hookCmds = calls.filter((c) => c.cmd.includes("core.hooksPath"));
		expect(hookCmds).toHaveLength(0);
	});

	test("silently skips hook arming when readFileFn throws", async () => {
		const sha = "dddddddddddddddddddddddddddddddddddddddd";
		const { spawn } = recorder((cmd) => {
			if (cmd[1] === "rev-parse") return ok(`${sha}\n`);
			return ok();
		});
		const result = await refreshProjectClone({
			config: CFG,
			localPath: "/data/projects/x/y",
			ref: "main",
			spawn,
			exists: () => true,
			readFileFn: async () => {
				throw new Error("ENOENT");
			},
		});

		// Run must succeed even when package.json is unreadable.
		expect(result.headSha).toBe(sha);
	});
});
