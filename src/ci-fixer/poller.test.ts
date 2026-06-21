import { describe, expect, test } from "bun:test";
import {
	type CiFixerCandidate,
	type CiFixerSpawnInput,
	type PollProjectCiFixerInput,
	pollProjectCiFixer,
} from "./poller.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");
const PREFIX = "burrow";
const FAILING = [
	{ id: 1, name: "test", status: "completed", conclusion: "failure", details_url: "https://ci/1" },
];
const PASSING = [{ id: 2, name: "test", status: "completed", conclusion: "success" }];

/** Stub fetch keyed on the commit ref in the check-runs URL. */
function checkRunsFetch(byRef: Record<string, unknown[]>): typeof fetch {
	return (async (url: Parameters<typeof fetch>[0]) => {
		const u = typeof url === "string" ? url : url.toString();
		const match = u.match(/\/commits\/([^/]+)\/check-runs/);
		const ref = match?.[1] !== undefined ? decodeURIComponent(match[1]) : "";
		return new Response(JSON.stringify({ check_runs: byRef[ref] ?? [] }), { status: 200 });
	}) as unknown as typeof fetch;
}

interface Harness {
	spawnCalls: CiFixerSpawnInput[];
	input: PollProjectCiFixerInput;
}

function harness(over: Partial<PollProjectCiFixerInput> = {}): Harness {
	const spawnCalls: CiFixerSpawnInput[] = [];
	const candidates: readonly CiFixerCandidate[] = over.candidates ?? [
		{ runId: "run_opener", prUrl: "https://github.com/o/r/pull/3" },
	];
	const input: PollProjectCiFixerInput = {
		candidates,
		settings: { enabled: true, maxRetries: 2, cooldownMinutes: 10 },
		branchPrefix: PREFIX,
		token: "tok",
		fetch: checkRunsFetch({ "burrow/run_opener": FAILING }),
		history: async () => ({ attempts: 0, lastAttemptAt: null }),
		spawn: async (i) => {
			spawnCalls.push(i);
			return { runId: "run_fixer" };
		},
		now: NOW,
		logTailLines: 0,
		...over,
	};
	return { spawnCalls, input };
}

describe("pollProjectCiFixer", () => {
	test("dispatches a fixer for a failing PR, back-linked to the opener", async () => {
		const { spawnCalls, input } = harness();
		const results = await pollProjectCiFixer(input);

		expect(results).toEqual([
			{
				kind: "dispatched",
				prUrl: "https://github.com/o/r/pull/3",
				runId: "run_fixer",
				parentRunId: "run_opener",
			},
		]);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.parentRunId).toBe("run_opener");
		expect(spawnCalls[0]?.targetBranch).toBe("burrow/run_opener");
		expect(spawnCalls[0]?.prUrl).toBe("https://github.com/o/r/pull/3");
		expect(spawnCalls[0]?.prompt).toContain("https://github.com/o/r/pull/3");
		expect(spawnCalls[0]?.prompt).toContain("- test: failure (https://ci/1)");
	});

	test("splices the CI log tail into the prompt when logTailLines > 0", async () => {
		const logCalls: { jobId: number; tailLines: number }[] = [];
		const { spawnCalls, input } = harness({
			logTailLines: 50,
			fetchLog: async (i, tailLines) => {
				logCalls.push({ jobId: i.jobId, tailLines });
				return "error: boom\nstack frame";
			},
		});
		const results = await pollProjectCiFixer(input);

		expect(results[0]?.kind).toBe("dispatched");
		// details_url `https://ci/1` has no `/job/<id>` segment → check-run id fallback.
		expect(logCalls).toEqual([{ jobId: 1, tailLines: 50 }]);
		expect(spawnCalls[0]?.prompt).toContain("CI log tail:");
		expect(spawnCalls[0]?.prompt).toContain("error: boom");
	});

	test("falls back to the check-name-only prompt when the log fetch yields null", async () => {
		const { spawnCalls, input } = harness({
			logTailLines: 50,
			fetchLog: async () => null,
		});
		const results = await pollProjectCiFixer(input);

		expect(results[0]?.kind).toBe("dispatched");
		expect(spawnCalls[0]?.prompt).not.toContain("CI log tail:");
		expect(spawnCalls[0]?.prompt).toContain("No CI log could be fetched");
	});

	test("does not fetch a log when logTailLines is 0", async () => {
		let called = false;
		const { input } = harness({
			logTailLines: 0,
			fetchLog: async () => {
				called = true;
				return "should not be used";
			},
		});
		await pollProjectCiFixer(input);
		expect(called).toBe(false);
	});

	test("skips with not_failing when CI is green", async () => {
		const { spawnCalls, input } = harness({
			fetch: checkRunsFetch({ "burrow/run_opener": PASSING }),
		});
		const results = await pollProjectCiFixer(input);
		expect(results).toEqual([
			{ kind: "skipped", prUrl: "https://github.com/o/r/pull/3", reason: "not_failing" },
		]);
		expect(spawnCalls).toHaveLength(0);
	});

	test("skips with disabled when the project hasn't opted in", async () => {
		const { spawnCalls, input } = harness({
			settings: { enabled: false, maxRetries: 2, cooldownMinutes: 10 },
		});
		const results = await pollProjectCiFixer(input);
		expect(results[0]).toEqual({
			kind: "skipped",
			prUrl: "https://github.com/o/r/pull/3",
			reason: "disabled",
		});
		expect(spawnCalls).toHaveLength(0);
	});

	test("skips with max_retries when the per-PR cap is hit", async () => {
		const { spawnCalls, input } = harness({
			history: async () => ({ attempts: 2, lastAttemptAt: null }),
		});
		const results = await pollProjectCiFixer(input);
		expect(results[0]?.kind === "skipped" && results[0].reason).toBe("max_retries");
		expect(spawnCalls).toHaveLength(0);
	});

	test("skips with cooldown when the last fixer ran too recently", async () => {
		const lastAttemptAt = new Date(NOW.getTime() - 5 * 60_000).toISOString();
		const { spawnCalls, input } = harness({
			history: async () => ({ attempts: 1, lastAttemptAt }),
		});
		const results = await pollProjectCiFixer(input);
		expect(results[0]?.kind === "skipped" && results[0].reason).toBe("cooldown");
		expect(spawnCalls).toHaveLength(0);
	});

	test("captures an unparseable PR url as a per-candidate error", async () => {
		const { spawnCalls, input } = harness({
			candidates: [{ runId: "run_opener", prUrl: "not-a-pr-url" }],
		});
		const results = await pollProjectCiFixer(input);
		expect(results[0]?.kind).toBe("error");
		expect(results[0]?.kind === "error" && results[0].reason).toBe("unparseable PR url");
		expect(spawnCalls).toHaveLength(0);
	});

	test("captures a GitHub fetch failure as a per-candidate error without throwing", async () => {
		const { spawnCalls, input } = harness({
			fetch: (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch,
		});
		const results = await pollProjectCiFixer(input);
		expect(results[0]?.kind).toBe("error");
		expect(spawnCalls).toHaveLength(0);
	});

	test("processes each candidate independently — one dispatch, one skip", async () => {
		const { spawnCalls, input } = harness({
			candidates: [
				{ runId: "run_a", prUrl: "https://github.com/o/r/pull/1" },
				{ runId: "run_b", prUrl: "https://github.com/o/r/pull/2" },
			],
			fetch: checkRunsFetch({ "burrow/run_a": FAILING, "burrow/run_b": PASSING }),
		});
		const results = await pollProjectCiFixer(input);
		expect(results.map((r) => r.kind)).toEqual(["dispatched", "skipped"]);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.parentRunId).toBe("run_a");
	});
});
