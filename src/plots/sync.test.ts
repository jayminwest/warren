import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpawnFn, SpawnResult } from "../projects/clone.ts";
import { defaultPlotSyncer } from "./sync.ts";

function ok(stdout = ""): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

describe("defaultPlotSyncer", () => {
	test("returns noop when token is missing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-sync-token-"));
		try {
			const spawn: SpawnFn = async () => ok();
			const result = await defaultPlotSyncer.sync({
				projectId: "p1",
				localPath: dir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				projectsConfig: { root: "/tmp", gitBinary: "git" },
				spawn,
				token: "",
			});

			expect(result).toEqual({ kind: "noop", reason: "missing_token" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("returns noop when no .plot/ files are dirty", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-sync-noop-"));
		try {
			const spawn: SpawnFn = async (cmd) => {
				if (cmd.includes("status")) {
					return ok(""); // empty status means not dirty
				}
				return ok();
			};

			const result = await defaultPlotSyncer.sync({
				projectId: "p1",
				localPath: dir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				projectsConfig: { root: "/tmp", gitBinary: "git" },
				spawn,
				token: "token123",
			});

			expect(result).toEqual({ kind: "noop", reason: "no_changes" });
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("opens PR but does not merge when mergeStrategy is manual", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-sync-manual-"));
		mkdirSync(join(dir, ".plot"), { recursive: true });
		writeFileSync(join(dir, ".plot", "plot-123.json"), "{}");

		try {
			const gitCalls: string[][] = [];
			const spawn: SpawnFn = async (cmd) => {
				gitCalls.push([...cmd]);
				if (cmd.includes("status")) {
					return ok("M  .plot/plot-123.json\n");
				}
				if (cmd.includes("diff")) {
					return { stdout: "", stderr: "", exitCode: 1 }; // non-zero means dirty/has diff
				}
				return ok();
			};

			const fetchCalls: { url: string; method: string }[] = [];
			const customFetch = async (url: string, init?: RequestInit) => {
				fetchCalls.push({ url, method: init?.method ?? "GET" });
				if (url.endsWith("/pulls") && init?.method === "POST") {
					return new Response(
						JSON.stringify({
							html_url: "https://github.com/owner/repo/pull/1",
						}),
						{ status: 201 },
					);
				}
				return new Response("", { status: 400 });
			};

			const result = await defaultPlotSyncer.sync({
				projectId: "p1",
				localPath: dir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				projectsConfig: { root: "/tmp", gitBinary: "git" },
				spawn,
				token: "token123",
				fetch: customFetch as typeof fetch,
			});

			expect(result.kind).toBe("synced");
			if (result.kind === "synced") {
				expect(result.prUrl).toBe("https://github.com/owner/repo/pull/1");
				expect(result.merged).toBe(false);
			}

			// Verify git calls are made
			expect(gitCalls.some((c) => c.includes("worktree") && c.includes("add"))).toBe(true);
			expect(gitCalls.some((c) => c.includes("add"))).toBe(true);
			expect(gitCalls.some((c) => c.includes("commit"))).toBe(true);
			expect(gitCalls.some((c) => c.includes("push"))).toBe(true);

			// Verify pull request opened
			expect(fetchCalls.length).toBe(1);
			expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/owner/repo/pulls");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("opens and merges PR when mergeStrategy is immediate", async () => {
		const dir = mkdtempSync(join(tmpdir(), "warren-plot-sync-immediate-"));
		mkdirSync(join(dir, ".warren"), { recursive: true });
		mkdirSync(join(dir, ".plot"), { recursive: true });
		writeFileSync(join(dir, ".plot", "plot-123.json"), "{}");
		writeFileSync(
			join(dir, ".warren", "config.yaml"),
			"plotSync:\n  mergeStrategy: immediate\n  targetBranch: main\n",
		);

		try {
			const gitCalls: string[][] = [];
			const spawn: SpawnFn = async (cmd) => {
				gitCalls.push([...cmd]);
				if (cmd.includes("status")) {
					return ok("M  .plot/plot-123.json\n");
				}
				if (cmd.includes("diff")) {
					return { stdout: "", stderr: "", exitCode: 1 };
				}
				if (cmd.includes("rev-parse")) {
					return ok("abc123sha\n");
				}
				return ok();
			};

			const fetchCalls: { url: string; method: string }[] = [];
			const customFetch = async (url: string, init?: RequestInit) => {
				fetchCalls.push({ url, method: init?.method ?? "GET" });
				if (url.endsWith("/pulls") && init?.method === "POST") {
					return new Response(
						JSON.stringify({
							html_url: "https://github.com/owner/repo/pull/1",
						}),
						{ status: 201 },
					);
				}
				if (url.endsWith("/pulls/1/merge") && init?.method === "PUT") {
					return new Response(
						JSON.stringify({
							merged: true,
							sha: "def456sha",
						}),
						{ status: 200 },
					);
				}
				return new Response("", { status: 400 });
			};

			const result = await defaultPlotSyncer.sync({
				projectId: "p1",
				localPath: dir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				projectsConfig: { root: "/tmp", gitBinary: "git" },
				spawn,
				token: "token123",
				fetch: customFetch as typeof fetch,
			});

			expect(result.kind).toBe("synced");
			if (result.kind === "synced") {
				expect(result.prUrl).toBe("https://github.com/owner/repo/pull/1");
				expect(result.merged).toBe(true);
			}

			// Verify both open PR and merge calls made
			expect(fetchCalls.length).toBe(2);
			expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/owner/repo/pulls");
			expect(fetchCalls[1]?.url).toBe("https://api.github.com/repos/owner/repo/pulls/1/merge");

			// Verify clone refresh was run
			expect(gitCalls.some((c) => c.includes("fetch") && c.includes("--prune"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
