import { describe, expect, test } from "bun:test";
import { IssueNotFoundError, type TrackerContext, TrackerError } from "../core/wire-tracker.ts";
import type { SpawnFn, SpawnResult } from "../projects/clone.ts";
import { SeedsCliError } from "../seeds-cli/errors.ts";
import { SeedsTracker } from "./seeds-tracker.ts";

function ok(stdout: string): SpawnResult {
	return { stdout, stderr: "", exitCode: 0 };
}

function fail(stderr: string, exitCode = 1): SpawnResult {
	return { stdout: "", stderr, exitCode };
}

const LOCAL = "/data/projects/x/y";
const CTX: TrackerContext = { projectId: "proj-1", localPath: LOCAL };

function tracker(spawn: SpawnFn): SeedsTracker {
	return new SeedsTracker({ spawn, sdBinary: "sd" });
}

describe("SeedsTracker", () => {
	test("declares every capability true", () => {
		expect(tracker(async () => ok("")).capabilities).toEqual({
			supportsPlans: true,
			supportsMetadata: true,
			supportsScheduledIssues: true,
			isGitNative: true,
		});
	});

	test("getIssue maps a real sd show envelope onto the neutral Issue DTO", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok(
				JSON.stringify({
					success: true,
					issue: {
						id: "warren-a",
						status: "in_progress",
						title: "do thing",
						description: "the thing",
						blockedBy: ["warren-b"],
						extensions: { role: "planner", scheduledFor: null },
					},
				}),
			);
		};
		const issue = await tracker(spawn).getIssue(CTX, "warren-a");
		expect(issue).toEqual({
			id: "warren-a",
			status: "other",
			title: "do thing",
			description: "the thing",
			blockedBy: ["warren-b"],
			metadata: { role: "planner", scheduledFor: null },
		});
		expect(calls).toEqual([{ cmd: ["sd", "show", "warren-a", "--json"], cwd: LOCAL }]);
	});

	test("getIssue normalizes closed and open statuses", async () => {
		const spawn: SpawnFn = async () => ok(JSON.stringify({ issue: { id: "a", status: "closed" } }));
		expect((await tracker(spawn).getIssue(CTX, "a")).status).toBe("closed");
		const spawnOpen: SpawnFn = async () =>
			ok(JSON.stringify({ issue: { id: "a", status: "open" } }));
		expect((await tracker(spawnOpen).getIssue(CTX, "a")).status).toBe("open");
	});

	test("getIssue translates a not-found sd exit into IssueNotFoundError", async () => {
		const spawn: SpawnFn = async () => fail("seeds: Issue not found: warren-zzz");
		await expect(tracker(spawn).getIssue(CTX, "warren-zzz")).rejects.toBeInstanceOf(
			IssueNotFoundError,
		);
	});

	test("getIssue wraps a transient shell failure in TrackerError with the cause attached", async () => {
		const spawn: SpawnFn = async () => fail("seeds: lock timeout", 2);
		let caught: unknown;
		try {
			await tracker(spawn).getIssue(CTX, "warren-a");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TrackerError);
		expect(caught).not.toBeInstanceOf(IssueNotFoundError);
		expect((caught as TrackerError).cause).toBeInstanceOf(SeedsCliError);
	});

	test("every operation rejects a TrackerContext without localPath", async () => {
		const t = tracker(async () => ok("{}"));
		const ctx: TrackerContext = { projectId: "proj-1" };
		await expect(t.getIssue(ctx, "a")).rejects.toBeInstanceOf(TrackerError);
		await expect(t.listIssueStatuses(ctx)).rejects.toBeInstanceOf(TrackerError);
		await expect(t.closeIssue(ctx, "a")).rejects.toBeInstanceOf(TrackerError);
		await expect(t.listPlans(ctx)).rejects.toBeInstanceOf(TrackerError);
		await expect(t.getPlan(ctx, "pl-1")).rejects.toBeInstanceOf(TrackerError);
		await expect(t.mergeIssueMetadata(ctx, "a", {})).rejects.toBeInstanceOf(TrackerError);
		await expect(t.listScheduledIssues(ctx)).rejects.toBeInstanceOf(TrackerError);
	});

	test("listIssueStatuses shells sd list and normalizes every status", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok(
				JSON.stringify({
					issues: [
						{ id: "a", status: "open" },
						{ id: "b", status: "in_progress" },
						{ id: "c", status: "closed" },
					],
				}),
			);
		};
		const statuses = await tracker(spawn).listIssueStatuses(CTX);
		expect(statuses.get("a")).toBe("open");
		expect(statuses.get("b")).toBe("other");
		expect(statuses.get("c")).toBe("closed");
		expect(calls).toEqual([{ cmd: ["sd", "list", "--format", "json"], cwd: LOCAL }]);
	});

	test("closeIssue shells sd close and succeeds on the already-closed idempotent path", async () => {
		const commands: (readonly string[])[] = [];
		const spawn: SpawnFn = async (cmd) => {
			commands.push(cmd);
			return ok("");
		};
		const t = tracker(spawn);
		await t.closeIssue(CTX, "warren-a");
		// seeds treats closing a closed issue as a no-op success (exit 0).
		await t.closeIssue(CTX, "warren-a");
		expect(commands).toEqual([
			["sd", "close", "warren-a"],
			["sd", "close", "warren-a"],
		]);
	});

	test("listPlans returns the facade's lean summaries", async () => {
		const spawn: SpawnFn = async () =>
			ok(
				JSON.stringify({
					plans: [
						{
							id: "pl-1",
							status: "approved",
							children: ["a", "b"],
							sections: { context: "x".repeat(1000) },
						},
					],
				}),
			);
		const plans = await tracker(spawn).listPlans(CTX);
		expect(plans).toEqual([{ id: "pl-1", status: "approved", childCount: 2 }]);
	});

	test("getPlan maps the step DAG onto neutral PlanStep names", async () => {
		const spawn: SpawnFn = async () =>
			ok(
				JSON.stringify({
					plan: {
						id: "pl-a37b",
						status: "active",
						children: ["warren-9ce3", "warren-6c29"],
						sections: {
							steps: [{ title: "cut the contract", blocks: [6] }, { existing_seed: "warren-5819" }],
						},
					},
				}),
			);
		const plan = await tracker(spawn).getPlan(CTX, "pl-a37b");
		expect(plan).toEqual({
			id: "pl-a37b",
			status: "active",
			children: ["warren-9ce3", "warren-6c29"],
			steps: [{ title: "cut the contract", blocks: [6] }, { existingSeed: "warren-5819" }],
		});
	});

	test("getPlan rejects an unknown plan status with TrackerError", async () => {
		const spawn: SpawnFn = async () =>
			ok(JSON.stringify({ plan: { id: "pl-1", status: "mystery", children: [] } }));
		await expect(tracker(spawn).getPlan(CTX, "pl-1")).rejects.toBeInstanceOf(TrackerError);
	});

	test("getPlan translates a not-found plan into TrackerError (not IssueNotFoundError)", async () => {
		const spawn: SpawnFn = async () => fail("seeds: no such plan: pl-zzz");
		let caught: unknown;
		try {
			await tracker(spawn).getPlan(CTX, "pl-zzz");
		} catch (err) {
			caught = err;
		}
		expect(caught).toBeInstanceOf(TrackerError);
		expect(caught).not.toBeInstanceOf(IssueNotFoundError);
	});

	test("mergeIssueMetadata shells sd update with the warren-namespaced payload", async () => {
		const calls: { cmd: readonly string[]; cwd: string }[] = [];
		const spawn: SpawnFn = async (cmd, opts) => {
			calls.push({ cmd, cwd: opts.cwd });
			return ok("");
		};
		await tracker(spawn).mergeIssueMetadata(CTX, "warren-a", {
			role: "planner",
			trigger: "cron",
		});
		expect(calls).toEqual([
			{
				cmd: [
					"sd",
					"update",
					"warren-a",
					"--extensions",
					JSON.stringify({ role: "planner", trigger: "cron" }),
				],
				cwd: LOCAL,
			},
		]);
	});

	test("mergeIssueMetadata rejects an out-of-namespace payload without shelling out", async () => {
		let shelled = false;
		const spawn: SpawnFn = async () => {
			shelled = true;
			return ok("");
		};
		await expect(
			tracker(spawn).mergeIssueMetadata(CTX, "warren-a", { bogus: "key" }),
		).rejects.toBeInstanceOf(TrackerError);
		expect(shelled).toBe(false);
	});

	test("listScheduledIssues maps scheduled seeds and drops the parse-error arm", async () => {
		const spawn: SpawnFn = async () =>
			ok(
				JSON.stringify({
					issues: [
						{
							id: "warren-a",
							status: "open",
							title: "due thing",
							extensions: { scheduledFor: "2026-05-11T00:00:00.000Z" },
						},
						{
							id: "warren-b",
							status: "in_progress",
							extensions: { scheduledFor: "2026-06-01T00:00:00.000Z" },
						},
						{ id: "warren-c", status: "open", extensions: { scheduledFor: "nope" } },
						{
							id: "warren-d",
							status: "closed",
							extensions: { scheduledFor: "2026-05-11T00:00:00.000Z" },
						},
					],
				}),
			);
		const issues = await tracker(spawn).listScheduledIssues(CTX);
		expect(issues).toEqual([
			{
				id: "warren-a",
				status: "open",
				title: "due thing",
				scheduledFor: new Date("2026-05-11T00:00:00.000Z"),
			},
			{ id: "warren-b", status: "other", scheduledFor: new Date("2026-06-01T00:00:00.000Z") },
		]);
	});
});
