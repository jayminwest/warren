import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultPlotSyncer } from "./sync.ts";

function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function stubFetch(responses: ReadonlyArray<Response>): {
	fetch: typeof fetch;
	calls: { url: string; method: string }[];
} {
	const calls: { url: string; method: string }[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		calls.push({ url, method: (init?.method ?? "GET").toUpperCase() });
		const next = responses[i++];
		if (next === undefined) throw new Error("stubFetch: out of canned responses");
		return next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

describe("defaultPlotSyncer.sync", () => {
	test("returns no_op when no plot files are dirty", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "warren-sync-noop-"));
		const plotDir = join(tempDir, ".plot");
		mkdirSync(plotDir, { recursive: true });

		const spawnCalls: string[][] = [];
		const spawn = async (cmd: readonly string[]) => {
			spawnCalls.push(cmd as string[]);
			if (cmd.includes("status")) {
				return { stdout: "", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		try {
			const result = await defaultPlotSyncer.sync({
				projectPath: tempDir,
				gitUrl: "https://github.com/owner/repo.git",
				defaultBranch: "main",
				token: "ghp_test",
				handle: "alice",
				spawn,
				gitBinary: "git",
			});

			expect(result.kind).toBe("no_op");
			expect(spawnCalls).toHaveLength(1);
			expect(spawnCalls[0]).toEqual(["git", "status", "--porcelain", "--", ".plot/"]);
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("performs full sync with PR open and immediate merge", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "warren-sync-full-"));
		const plotDir = join(tempDir, ".plot");
		mkdirSync(plotDir, { recursive: true });
		writeFileSync(join(plotDir, "plot-1.json"), '{"id":"plot-1"}');
		writeFileSync(join(plotDir, "plot-1.events.jsonl"), '{"event":"created"}\n');

		const spawnCalls: string[][] = [];
		const spawn = async (cmd: readonly string[]) => {
			spawnCalls.push(cmd as string[]);
			if (cmd.includes("status")) {
				return { stdout: " M .plot/plot-1.json\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		const { fetch, calls: fetchCalls } = stubFetch([
			jsonResponse(201, { html_url: "https://github.com/owner/repo/pull/42" }),
			jsonResponse(200, { merged: true, sha: "mergesha123" }),
		]);

		try {
			const result = await defaultPlotSyncer.sync({
				projectPath: tempDir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				token: "ghp_test",
				handle: "alice",
				plotSyncConfig: {
					mergeStrategy: "immediate",
					targetBranch: "main",
				},
				spawn,
				fetch,
				gitBinary: "git",
			});

			expect(result.kind).toBe("synced");
			if (result.kind === "synced") {
				expect(result.branch).toMatch(/^warren\/plot-sync-[a-f0-9]{8}$/);
				expect(result.prUrl).toBe("https://github.com/owner/repo/pull/42");
				expect(result.prNumber).toBe(42);
				expect(result.merged).toBe(true);
			}

			// Verify spawn calls for git commands
			const hasCommand = (subcmd: string) => spawnCalls.some((c) => c.includes(subcmd));
			expect(hasCommand("status")).toBe(true);
			expect(hasCommand("fetch")).toBe(true);
			expect(hasCommand("worktree")).toBe(true);
			expect(hasCommand("add")).toBe(true);
			expect(hasCommand("commit")).toBe(true);
			expect(hasCommand("push")).toBe(true);

			// Verify PR open and merge requests
			expect(fetchCalls).toHaveLength(2);
			expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/owner/repo/pulls");
			expect(fetchCalls[0]?.method).toBe("POST");
			expect(fetchCalls[1]?.url).toBe("https://api.github.com/repos/owner/repo/pulls/42/merge");
			expect(fetchCalls[1]?.method).toBe("PUT");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});

	test("respects manual mergeStrategy and skips merge step", async () => {
		const tempDir = mkdtempSync(join(tmpdir(), "warren-sync-manual-"));
		const plotDir = join(tempDir, ".plot");
		mkdirSync(plotDir, { recursive: true });
		writeFileSync(join(plotDir, "plot-1.json"), '{"id":"plot-1"}');

		const spawnCalls: string[][] = [];
		const spawn = async (cmd: readonly string[]) => {
			spawnCalls.push(cmd as string[]);
			if (cmd.includes("status")) {
				return { stdout: " M .plot/plot-1.json\n", stderr: "", exitCode: 0 };
			}
			return { stdout: "", stderr: "", exitCode: 0 };
		};

		const { fetch, calls: fetchCalls } = stubFetch([
			jsonResponse(201, { html_url: "https://github.com/owner/repo/pull/100" }),
		]);

		try {
			const result = await defaultPlotSyncer.sync({
				projectPath: tempDir,
				gitUrl: "https://github.com/owner/repo",
				defaultBranch: "main",
				token: "ghp_test",
				handle: "bob",
				plotSyncConfig: {
					mergeStrategy: "manual",
				},
				spawn,
				fetch,
				gitBinary: "git",
			});

			expect(result.kind).toBe("synced");
			if (result.kind === "synced") {
				expect(result.prUrl).toBe("https://github.com/owner/repo/pull/100");
				expect(result.prNumber).toBe(100);
				expect(result.merged).toBe(false);
			}

			expect(fetchCalls).toHaveLength(1);
			expect(fetchCalls[0]?.url).toBe("https://api.github.com/repos/owner/repo/pulls");
		} finally {
			rmSync(tempDir, { recursive: true, force: true });
		}
	});
});
