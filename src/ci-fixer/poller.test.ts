import { describe, expect, test } from "bun:test";
import type { CheckRun, ForgeCapabilities, ForgeResult, RepoRef } from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import {
	type CiFixerCandidate,
	type CiFixerSpawnInput,
	type PollProjectCiFixerInput,
	pollProjectCiFixer,
} from "./poller.ts";

const NOW = new Date("2026-05-29T12:00:00.000Z");
const PREFIX = "burrow";
const PR_URL = "fake://o/r/pulls/3";
const HEAD_REF = `${PREFIX}/run_opener`;

const FAILING: CheckRun[] = [
	{
		name: "test",
		status: "completed",
		conclusion: "failure",
		jobId: "1",
		detailsUrl: "https://ci/1",
	},
];
const PASSING: CheckRun[] = [
	{ name: "test", status: "completed", conclusion: "success", jobId: null, detailsUrl: null },
];

interface Harness {
	forge: FakeForge;
	spawnCalls: CiFixerSpawnInput[];
	input: PollProjectCiFixerInput;
}

function harness(
	over: Partial<PollProjectCiFixerInput> = {},
	checks: CheckRun[] = FAILING,
): Harness {
	const forge = new FakeForge();
	const ref = forge.parseRepoRef("fake://o/r");
	if (ref === null) throw new Error("fake forge must own fake:// urls");
	forge.setChecks(ref, HEAD_REF, checks);

	const spawnCalls: CiFixerSpawnInput[] = [];
	const candidates: readonly CiFixerCandidate[] = over.candidates ?? [
		{ runId: "run_opener", prUrl: PR_URL },
	];
	const input: PollProjectCiFixerInput = {
		candidates,
		settings: { enabled: true, maxRetries: 2, cooldownMinutes: 10 },
		branchPrefix: PREFIX,
		forge,
		history: async () => ({ attempts: 0, lastAttemptAt: null }),
		spawn: async (i) => {
			spawnCalls.push(i);
			return { runId: "run_fixer" };
		},
		now: NOW,
		logTailLines: 0,
		...over,
	};
	return { forge, spawnCalls, input };
}

/** Override capability flags on a forge (test seam — the flags are readonly). */
function withCapabilities(forge: FakeForge, over: Partial<ForgeCapabilities>): FakeForge {
	Object.defineProperty(forge, "capabilities", {
		value: { ...forge.capabilities, ...over },
	});
	return forge;
}

describe("pollProjectCiFixer", () => {
	test("dispatches a fixer for a failing PR, back-linked to the opener", async () => {
		const { spawnCalls, input } = harness();
		const results = await pollProjectCiFixer(input);

		expect(results).toEqual([
			{
				kind: "dispatched",
				prUrl: PR_URL,
				runId: "run_fixer",
				parentRunId: "run_opener",
			},
		]);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.parentRunId).toBe("run_opener");
		expect(spawnCalls[0]?.targetBranch).toBe(HEAD_REF);
		expect(spawnCalls[0]?.prUrl).toBe(PR_URL);
		expect(spawnCalls[0]?.prompt).toContain(PR_URL);
		expect(spawnCalls[0]?.prompt).toContain("- test: failure (https://ci/1)");
	});

	test("splices the CI log tail into the prompt when logTailLines > 0", async () => {
		const { forge, spawnCalls, input } = harness({ logTailLines: 50 });
		const logCalls: { jobId: string; maxBytes: number }[] = [];
		forge.fetchJobLogTail = (async (_ref: RepoRef, jobId: string, maxBytes: number) => {
			logCalls.push({ jobId, maxBytes });
			return { ok: true, value: "error: boom\nstack frame" };
		}) as FakeForge["fetchJobLogTail"];

		const results = await pollProjectCiFixer(input);

		expect(results[0]?.kind).toBe("dispatched");
		expect(logCalls).toHaveLength(1);
		expect(logCalls[0]?.jobId).toBe("1");
		expect(spawnCalls[0]?.prompt).toContain("CI log tail:");
		expect(spawnCalls[0]?.prompt).toContain("error: boom");
	});

	test("falls back to the check-name-only prompt when the log fetch yields null", async () => {
		const { forge, spawnCalls, input } = harness({ logTailLines: 50 });
		forge.fetchJobLogTail = (async () => ({
			ok: true,
			value: null,
		})) as FakeForge["fetchJobLogTail"];

		const results = await pollProjectCiFixer(input);

		expect(results[0]?.kind).toBe("dispatched");
		expect(spawnCalls[0]?.prompt).not.toContain("CI log tail:");
		expect(spawnCalls[0]?.prompt).toContain("No CI log could be fetched");
	});

	test("does not fetch a log when logTailLines is 0", async () => {
		const { forge, input } = harness({ logTailLines: 0 });
		let called = false;
		forge.fetchJobLogTail = (async () => {
			called = true;
			return { ok: true, value: "unused" };
		}) as FakeForge["fetchJobLogTail"];
		await pollProjectCiFixer(input);
		expect(called).toBe(false);
	});

	test("skips with not_failing when CI is green", async () => {
		const { spawnCalls, input } = harness({}, PASSING);
		const results = await pollProjectCiFixer(input);
		expect(results).toEqual([{ kind: "skipped", prUrl: PR_URL, reason: "not_failing" }]);
		expect(spawnCalls).toHaveLength(0);
	});

	test("skips with disabled when the project hasn't opted in", async () => {
		const { spawnCalls, input } = harness({
			settings: { enabled: false, maxRetries: 2, cooldownMinutes: 10 },
		});
		const results = await pollProjectCiFixer(input);
		expect(results[0]).toEqual({ kind: "skipped", prUrl: PR_URL, reason: "disabled" });
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

	test("captures a forge failure as a per-candidate error without throwing", async () => {
		const { forge, spawnCalls, input } = harness();
		forge.listChecks = (async () => ({
			ok: false,
			error: { kind: "network", detail: "boom" },
		})) as FakeForge["listChecks"];
		const results = await pollProjectCiFixer(input);
		expect(results[0]?.kind).toBe("error");
		expect(results[0]?.kind === "error" && results[0].reason).toBe("boom");
		expect(spawnCalls).toHaveLength(0);
	});

	test("processes each candidate independently — one dispatch, one skip", async () => {
		const { forge, spawnCalls, input } = harness({
			candidates: [
				{ runId: "run_a", prUrl: PR_URL },
				{ runId: "run_b", prUrl: PR_URL },
			],
		});
		const ref = forge.parseRepoRef("fake://o/r");
		if (ref === null) throw new Error("unreachable");
		forge.setChecks(ref, `${PREFIX}/run_a`, FAILING);
		forge.setChecks(ref, `${PREFIX}/run_b`, PASSING);

		const results = await pollProjectCiFixer(input);
		expect(results.map((r) => r.kind)).toEqual(["dispatched", "skipped"]);
		expect(spawnCalls).toHaveLength(1);
		expect(spawnCalls[0]?.parentRunId).toBe("run_a");
	});
});

describe("pollProjectCiFixer §5 capability degradations", () => {
	test("capabilities.checkRuns false skips every candidate as unsupported without calling the forge", async () => {
		const { forge, spawnCalls, input } = harness();
		let listCalls = 0;
		forge.listChecks = (async () => {
			listCalls += 1;
			throw new Error("listChecks must not be called when checkRuns is false");
		}) as FakeForge["listChecks"];
		const degraded = { ...input, forge: withCapabilities(forge, { checkRuns: false }) };

		const results = await pollProjectCiFixer(degraded);

		expect(results).toEqual([{ kind: "skipped", prUrl: PR_URL, reason: "unsupported" }]);
		expect(listCalls).toBe(0);
		expect(spawnCalls).toHaveLength(0);
	});

	test("a defensive unsupported error from listChecks also skips as unsupported", async () => {
		const { forge, spawnCalls, input } = harness();
		forge.listChecks = (async (): Promise<ForgeResult<never>> => ({
			ok: false,
			error: { kind: "unsupported", detail: "PAT cannot reach the Checks API" },
		})) as FakeForge["listChecks"];

		const results = await pollProjectCiFixer(input);

		expect(results).toEqual([{ kind: "skipped", prUrl: PR_URL, reason: "unsupported" }]);
		expect(spawnCalls).toHaveLength(0);
	});

	test("capabilities.jobLogs false keeps the no-log prompt fallback and never fetches", async () => {
		const { forge, spawnCalls, input } = harness({ logTailLines: 50 });
		let logCalls = 0;
		forge.fetchJobLogTail = (async () => {
			logCalls += 1;
			return { ok: true, value: "unused" };
		}) as FakeForge["fetchJobLogTail"];
		const degraded = { ...input, forge: withCapabilities(forge, { jobLogs: false }) };

		const results = await pollProjectCiFixer(degraded);

		expect(results[0]?.kind).toBe("dispatched");
		expect(logCalls).toBe(0);
		expect(spawnCalls[0]?.prompt).toContain("No CI log could be fetched");
	});

	test("a failure with a null jobId is skipped over for the log tail", async () => {
		const noJob: CheckRun[] = [
			{ name: "test", status: "completed", conclusion: "failure", jobId: null, detailsUrl: null },
		];
		const { forge, spawnCalls, input } = harness({ logTailLines: 50 }, noJob);
		let logCalls = 0;
		forge.fetchJobLogTail = (async () => {
			logCalls += 1;
			return { ok: true, value: "unused" };
		}) as FakeForge["fetchJobLogTail"];

		const results = await pollProjectCiFixer(input);

		expect(results[0]?.kind).toBe("dispatched");
		expect(logCalls).toBe(0);
		expect(spawnCalls[0]?.prompt).toContain("No CI log could be fetched");
	});
});
