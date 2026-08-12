import { describe, expect, test } from "bun:test";
import type {
	Forge,
	ForgeError,
	ForgeResult,
	PullRequestState,
	RepoRef,
} from "../forge/contract.ts";
import { FakeForge } from "../forge/fake/fake-forge.ts";
import { createPrMergeChecker, type PrMergeCheckerLogger } from "./pr-merge.ts";

/** Open a PR on a FakeForge and return its stored webUrl + handles. */
async function openFakePr(forge: FakeForge, cloneUrl: string) {
	const ref = forge.parseRepoRef(cloneUrl);
	if (ref === null) throw new Error("fake forge refused its own URL");
	const opened = await forge.openPullRequest(ref, {
		title: "t",
		body: "b",
		headBranch: "warren/run-1",
		baseBranch: "main",
	});
	if (!opened.ok) throw new Error("fake forge failed to open a PR");
	return { ref, pr: opened.value };
}

/** A stub forge whose getPullRequest answers from a scripted queue. */
function stubForge(script: Array<ForgeResult<PullRequestState>>): {
	forge: Forge;
	calls: () => number;
} {
	let calls = 0;
	const ref: RepoRef = { forge: "github", key: "github.com/o/r" };
	const forge = {
		capabilities: {
			checkRuns: true,
			jobLogs: true,
			pullRequestBodyEdit: true,
			branchDelete: true,
			botIdentity: false,
			credentialLifetime: "static" as const,
		},
		parseRepoRef: (url: string) => (url.includes("github.com") ? ref : null),
		getPullRequest: () => {
			const next = script[calls];
			if (next === undefined) throw new Error("ran out of stubbed responses");
			calls += 1;
			return Promise.resolve(next);
		},
	} as unknown as Forge;
	return { forge, calls: () => calls };
}

function err(error: ForgeError): ForgeResult<PullRequestState> {
	return { ok: false, error };
}

function state(lifecycle: PullRequestState["lifecycle"], mergedAt: number | null = null) {
	return {
		ok: true as const,
		value: { lifecycle, mergedAt, headCommit: "abc", baseBranch: "main" },
	};
}

describe("createPrMergeChecker", () => {
	test("returns unparseable for a foreign-host URL without calling the forge", async () => {
		const { forge, calls } = stubForge([state("open")]);
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0 });
		// Invariant: a null parseRepoRef keeps the
		// wait-indefinitely-on-manual-merge behaviour for foreign-host PRs.
		const result = await checker("https://ghe.example.com/o/r/pull/3");
		expect(result.kind).toBe("unparseable");
		expect(calls()).toBe(0);
	});

	test("merged_at non-null is the truth source: merged carries an ISO mergedAt", async () => {
		const forge = new FakeForge({ now: () => 1_747_000_000_000 });
		const { ref, pr } = await openFakePr(forge, "fake://proj");
		forge.markMerged(ref, pr);
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0 });
		const result = await checker(pr.webUrl);
		expect(result).toEqual({
			kind: "merged",
			mergedAt: new Date(1_747_000_000_000).toISOString(),
		});
	});

	test("closed with a null merged_at is closed_unmerged", async () => {
		const forge = new FakeForge();
		const { ref, pr } = await openFakePr(forge, "fake://proj");
		forge.markClosed(ref, pr);
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0 });
		const result = await checker(pr.webUrl);
		expect(result.kind).toBe("closed_unmerged");
	});

	test("open PR polls as open", async () => {
		const forge = new FakeForge();
		const { pr } = await openFakePr(forge, "fake://proj");
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0 });
		const result = await checker(pr.webUrl);
		expect(result.kind).toBe("open");
	});

	test("the fake's own PR webUrl round-trips through parseRepoRef", async () => {
		// Regression guard for the FakeForge key shape: the merge gate polls
		// the stored webUrl (`fake://<path>/pulls/<n>`), so parseRepoRef must
		// resolve it back to the repo ref the store is indexed by.
		const forge = new FakeForge();
		const { pr } = await openFakePr(forge, "fake://proj");
		expect(forge.parseRepoRef(pr.webUrl)).toEqual({ forge: "fake", key: "proj" });
	});

	test("not_found is fatal-shaped and not retried", async () => {
		const { forge, calls } = stubForge([err({ kind: "not_found", status: 404, detail: "gone" })]);
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0 });
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result).toEqual({ kind: "forge_error", errorKind: "not_found", detail: "gone" });
		expect(calls()).toBe(1);
	});

	test("unauthorized fires one loud notice per repo and is not retried", async () => {
		const warns: Array<Record<string, unknown>> = [];
		const logger: PrMergeCheckerLogger = {
			warn: (obj) => {
				warns.push(obj);
			},
		};
		const { forge, calls } = stubForge([
			err({ kind: "unauthorized", status: 401, detail: "bad credentials" }),
			err({ kind: "unauthorized", status: 401, detail: "bad credentials" }),
		]);
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0, logger });
		const first = await checker("https://github.com/o/r/pull/3");
		expect(first).toEqual({
			kind: "forge_error",
			errorKind: "unauthorized",
			detail: "bad credentials",
		});
		expect(calls()).toBe(1);
		expect(warns).toHaveLength(1);
		expect(warns[0]?.repo).toBe("github.com/o/r");
		// Second poll of the same repo: still keeps waiting, no second notice.
		const second = await checker("https://github.com/o/r/pull/4");
		expect(second.kind).toBe("forge_error");
		expect(warns).toHaveLength(1);
	});

	test("forbidden also fires the loud notice", async () => {
		const warns: unknown[] = [];
		const logger: PrMergeCheckerLogger = { warn: (obj) => void warns.push(obj) };
		const { forge } = stubForge([err({ kind: "forbidden", status: 403, detail: "nope" })]);
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0, logger });
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result).toEqual({ kind: "forge_error", errorKind: "forbidden", detail: "nope" });
		expect(warns).toHaveLength(1);
	});

	test("no_credential stays quiet (stall-and-log), never loud, never fatal", async () => {
		const warns: unknown[] = [];
		const logger: PrMergeCheckerLogger = { warn: (obj) => void warns.push(obj) };
		const { forge, calls } = stubForge([err({ kind: "no_credential", detail: "no token" })]);
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0, logger });
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result).toEqual({ kind: "forge_error", errorKind: "no_credential", detail: "no token" });
		expect(calls()).toBe(1);
		expect(warns).toHaveLength(0);
	});

	test("retries network + 5xx and surfaces the eventual response", async () => {
		const { forge, calls } = stubForge([
			err({ kind: "network", detail: "ETIMEDOUT" }),
			err({ kind: "http_error", status: 503, detail: "Service Unavailable" }),
			state("merged", 1_747_000_000_000),
		]);
		const checker = createPrMergeChecker({ forge, maxRetries: 2, retryDelayMs: 0 });
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result.kind).toBe("merged");
		expect(calls()).toBe(3);
	});

	test("does not retry non-fatal 4xx http errors", async () => {
		const { forge, calls } = stubForge([err({ kind: "http_error", status: 422, detail: "odd" })]);
		const checker = createPrMergeChecker({ forge, retryDelayMs: 0 });
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result).toEqual({ kind: "forge_error", errorKind: "http_error", detail: "odd" });
		expect(calls()).toBe(1);
	});

	test("retries rate_limited and honors the capped Retry-After hint", async () => {
		const sleeps: number[] = [];
		const { forge, calls } = stubForge([
			err({ kind: "rate_limited", status: 429, retryAfterMs: 120_000, detail: "slow down" }),
			err({ kind: "rate_limited", status: 429, detail: "slow down" }),
		]);
		const checker = createPrMergeChecker({
			forge,
			maxRetries: 1,
			retryDelayMs: 0,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});
		const result = await checker("https://github.com/o/r/pull/3");
		expect(result).toEqual({ kind: "forge_error", errorKind: "rate_limited", detail: "slow down" });
		expect(calls()).toBe(2);
		// The 120s hint is capped at MAX_RETRY_AFTER_MS (60s).
		expect(sleeps).toEqual([60_000]);
	});
});
