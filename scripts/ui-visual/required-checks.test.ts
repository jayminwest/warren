import { describe, expect, test } from "bun:test";

import {
	type Api,
	actionsRuns,
	type CheckRun,
	type CheckState,
	checkStates,
	classifyChanges,
	decideChecks,
	gate,
	isCandidate,
	isUiVisualSuite,
	judgeCheck,
	type Pull,
	parseLogins,
	type SuiteRun,
	targets,
	toTarget,
	UI_VISUAL_WORKFLOW,
} from "./required-checks.ts";

const HEAD = "a".repeat(40);
const OTHER = "b".repeat(40);
const REPO = "o/r";

function run(over: Partial<CheckRun> = {}): CheckRun {
	return {
		id: 10,
		name: "ui-visual",
		head_sha: HEAD,
		status: "completed",
		conclusion: "success",
		html_url: "https://example.test/check",
		app: { slug: "github-actions" },
		check_suite: { id: 100 },
		...over,
	};
}

const UI_VISUAL_SUITE: SuiteRun = {
	path: UI_VISUAL_WORKFLOW,
	event: "pull_request",
	head_sha: HEAD,
};

describe("classifyChanges", () => {
	test("refuses an unreadable or empty diff", () => {
		expect(classifyChanges(null).kind).toBe("refuse");
		expect(classifyChanges([]).kind).toBe("refuse");
	});

	test("exempts a diff with no UI paths", () => {
		expect(classifyChanges(["src/runs/pr.ts", "docs/src/ui/x.md"]).kind).toBe("exempt");
	});

	test("gates src/ui and scripts/ui-visual changes and lists them", () => {
		const v = classifyChanges(["README.md", "src/ui/src/app.tsx", "scripts/ui-visual/run.ts"]);
		expect(v).toEqual({ kind: "gated", paths: ["src/ui/src/app.tsx", "scripts/ui-visual/run.ts"] });
	});

	test("matches the directories as prefixes, not substrings", () => {
		expect(classifyChanges(["src/uix/a.ts", "scripts/ui-visual-old.ts"]).kind).toBe("exempt");
	});
});

describe("actionsRuns", () => {
	test("keeps only GitHub Actions runs of the name on the head, newest first", () => {
		const runs = [
			run({ id: 1 }),
			run({ id: 3 }),
			run({ id: 9, app: { slug: "forged-app" } }),
			run({ id: 8, app: null }),
			run({ id: 7, head_sha: OTHER }),
			run({ id: 6, name: "design-review" }),
		];
		expect(actionsRuns(runs, "ui-visual", HEAD).map((r) => r.id)).toEqual([3, 1]);
	});
});

describe("isUiVisualSuite", () => {
	test("accepts a pull_request run of the ui-visual workflow on the head", () => {
		expect(isUiVisualSuite(UI_VISUAL_SUITE, HEAD)).toBe(true);
	});

	const rejects: [string, SuiteRun | null][] = [
		[
			"another workflow with a job of the same name",
			{ ...UI_VISUAL_SUITE, path: ".github/workflows/x.yml" },
		],
		["the update_goldens dispatch", { ...UI_VISUAL_SUITE, event: "workflow_dispatch" }],
		["a run on another head", { ...UI_VISUAL_SUITE, head_sha: OTHER }],
		["no run at all", null],
	];
	for (const [name, suite] of rejects) {
		test(`rejects ${name}`, () => {
			expect(isUiVisualSuite(suite, HEAD)).toBe(false);
		});
	}
});

describe("judgeCheck", () => {
	test("passes only a completed success", () => {
		expect(judgeCheck("ui-visual", run()).ok).toBe(true);
	});

	test("names what is wrong otherwise", () => {
		const problem = (r: CheckRun | null) => {
			const s = judgeCheck("design-review", r);
			return s.ok ? "" : s.problem;
		};
		expect(problem(null)).toBe("has not reported");
		expect(problem(run({ status: "queued", conclusion: null }))).toBe("is queued");
		expect(problem(run({ conclusion: "failure" }))).toBe("concluded failure");
		expect(problem(run({ conclusion: "neutral" }))).toBe("concluded neutral");
		expect(problem(run({ conclusion: "skipped" }))).toBe("concluded skipped");
	});
});

describe("decideChecks", () => {
	const ok = (name: "ui-visual" | "design-review"): CheckState => ({ name, ok: true, url: "" });

	test("allows when both checks passed", () => {
		expect(decideChecks([ok("ui-visual"), ok("design-review")], HEAD).allow).toBe(true);
	});

	test("refuses and names each failing check and the head", () => {
		const d = decideChecks(
			[
				{ name: "ui-visual", ok: false, problem: "concluded failure" },
				{ name: "design-review", ok: false, problem: "is queued" },
			],
			HEAD,
		);
		expect(d.allow).toBe(false);
		expect(d.lines[0]).toBe(
			`ui-visual concluded failure; design-review is queued on ${HEAD.slice(0, 12)}`,
		);
	});

	test("refuses when a required check was never judged", () => {
		const d = decideChecks([ok("ui-visual")], HEAD);
		expect(d.allow).toBe(false);
		expect(d.lines[0]).toContain("design-review was not judged");
	});
});

describe("parseLogins and isCandidate", () => {
	const policy = { owner: "jayminwest", bots: parseLogins(" warren-run-bot ,App[bot],") };
	const pull = (over: Partial<Pull> = {}): Pull => ({
		draft: false,
		user: { login: "JayminWest" },
		labels: [],
		auto_merge: null,
		...over,
	});

	test("parses a comma list, lowercased", () => {
		expect(policy.bots).toEqual(["warren-run-bot", "app[bot]"]);
	});

	test("admits the owner's and a listed bot's open, unarmed PR", () => {
		expect(isCandidate(pull(), policy)).toBe(true);
		expect(isCandidate(pull({ user: { login: "warren-run-bot" } }), policy)).toBe(true);
	});

	const rejects: [string, Partial<Pull>][] = [
		["a third party", { user: { login: "someone" } }],
		["no author", { user: null }],
		["a draft", { draft: true }],
		["an unknown draft flag", { draft: undefined }],
		["the opt-out label", { labels: [{ name: "no-automerge" }] }],
		["an armed PR", { auto_merge: { merge_method: "squash" } }],
	];
	for (const [name, over] of rejects) {
		test(`skips ${name}`, () => {
			expect(isCandidate(pull(over), policy)).toBe(false);
		});
	}
});

describe("toTarget", () => {
	const full: Pull = {
		number: 7,
		html_url: "https://example.test/pull/7",
		base: { sha: OTHER, ref: "main" },
		head: { sha: HEAD, ref: "feat", repo: { full_name: REPO } },
	};

	test("maps every field the arm job reads", () => {
		expect(toTarget(full)).toEqual({
			number: 7,
			url: "https://example.test/pull/7",
			base_sha: OTHER,
			base_ref: "main",
			head_sha: HEAD,
			head_ref: "feat",
			head_repo: REPO,
		});
	});

	test("returns null when a field is missing", () => {
		expect(toTarget({ ...full, head: { sha: HEAD, ref: "feat", repo: null } })).toBeNull();
	});
});

/** A fake API: check runs by name, workflow runs by suite id, and the open PRs. */
function fakeApi(opts: {
	checks: Record<string, CheckRun[]>;
	suites?: Record<number, SuiteRun[]>;
	pulls?: Pull[];
	fail?: boolean;
}): Api & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async get(path) {
			calls.push(path);
			if (opts.fail) throw new Error("HTTP 502");
			const name = /check_name=([^&]+)/.exec(path)?.[1];
			if (name !== undefined) {
				return { body: { check_runs: opts.checks[decodeURIComponent(name)] ?? [] }, next: null };
			}
			const suite = /check_suite_id=(\d+)/.exec(path)?.[1];
			if (suite !== undefined) {
				return { body: { workflow_runs: opts.suites?.[Number(suite)] ?? [] }, next: null };
			}
			return { body: opts.pulls ?? [], next: null };
		},
	};
}

const GREEN = {
	checks: {
		"ui-visual": [run({ id: 1, check_suite: { id: 100 } })],
		"design-review": [run({ id: 2, name: "design-review", check_suite: { id: 200 } })],
	},
	suites: { 100: [UI_VISUAL_SUITE] },
};

describe("checkStates", () => {
	test("passes the real ui-visual and design-review runs", async () => {
		const states = await checkStates(fakeApi(GREEN), REPO, HEAD);
		expect(states.map((s) => s.ok)).toEqual([true, true]);
	});

	test("ignores a newer ui-visual check whose suite is not the ui-visual workflow", async () => {
		const forged = run({ id: 5, conclusion: "success", check_suite: { id: 300 } });
		const failed = run({ id: 4, conclusion: "failure", check_suite: { id: 100 } });
		const api = fakeApi({
			...GREEN,
			checks: { ...GREEN.checks, "ui-visual": [forged, failed] },
			suites: { 100: [UI_VISUAL_SUITE], 300: [{ ...UI_VISUAL_SUITE, event: "workflow_dispatch" }] },
		});
		const [visual] = await checkStates(api, REPO, HEAD);
		expect(visual).toEqual({ name: "ui-visual", ok: false, problem: "concluded failure" });
	});

	test("ignores a design-review check from another app", async () => {
		const api = fakeApi({
			...GREEN,
			checks: {
				...GREEN.checks,
				"design-review": [run({ id: 9, name: "design-review", app: { slug: "other" } })],
			},
		});
		const [, review] = await checkStates(api, REPO, HEAD);
		expect(review).toEqual({ name: "design-review", ok: false, problem: "has not reported" });
	});

	test("the newest Actions design-review run decides", async () => {
		const api = fakeApi({
			...GREEN,
			checks: {
				...GREEN.checks,
				"design-review": [
					run({ id: 2, name: "design-review" }),
					run({ id: 6, name: "design-review", conclusion: "failure" }),
				],
			},
		});
		const [, review] = await checkStates(api, REPO, HEAD);
		expect(review?.ok).toBe(false);
	});
});

describe("gate", () => {
	const env = { HEAD_SHA: HEAD, BASE_SHA: OTHER, GITHUB_REPOSITORY: REPO };

	test("passes a non-UI PR without calling the API", async () => {
		const api = fakeApi({ checks: {}, fail: true });
		expect(await gate(env, api, () => ["src/runs/pr.ts"])).toBe(true);
		expect(api.calls).toEqual([]);
	});

	test("refuses an unreadable diff", async () => {
		expect(await gate(env, fakeApi(GREEN), () => null)).toBe(false);
	});

	test("allows a UI PR with both checks green", async () => {
		expect(await gate(env, fakeApi(GREEN), () => ["src/ui/src/app.tsx"])).toBe(true);
	});

	test("refuses a UI PR while design-review is pending", async () => {
		const api = fakeApi({
			...GREEN,
			checks: {
				...GREEN.checks,
				"design-review": [run({ name: "design-review", status: "queued" })],
			},
		});
		expect(await gate(env, api, () => ["scripts/ui-visual/run.ts"])).toBe(false);
	});

	test("throws, so the wrapper refuses, when the API fails", async () => {
		const api = fakeApi({ checks: {}, fail: true });
		await expect(gate(env, api, () => ["src/ui/src/app.tsx"])).rejects.toThrow("HTTP 502");
	});
});

describe("targets", () => {
	const pull = (n: number, sha: string, over: Partial<Pull> = {}): Pull => ({
		number: n,
		html_url: `https://example.test/pull/${n}`,
		draft: false,
		user: { login: "jayminwest" },
		labels: [],
		auto_merge: null,
		base: { sha: OTHER, ref: "main" },
		head: { sha, ref: `b${n}`, repo: { full_name: REPO } },
		...over,
	});

	test("lists only eligible PRs whose head has both checks green", async () => {
		const api = fakeApi({
			...GREEN,
			pulls: [
				pull(1, HEAD),
				pull(2, OTHER),
				pull(3, HEAD, { auto_merge: {} }),
				pull(4, HEAD, { user: { login: "someone" } }),
			],
		});
		const list = await targets({ GITHUB_REPOSITORY: REPO, OWNER: "jayminwest" }, api);
		expect(list.map((t) => t.number)).toEqual([1]);
	});
});
