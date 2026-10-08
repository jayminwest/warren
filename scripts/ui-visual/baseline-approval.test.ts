import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "js-yaml";

import {
	type Activity,
	APPROVAL_LABEL,
	type ApprovalCheck,
	type ApproverPolicy,
	BASELINE_PATHS,
	checkApprover,
	classifyChanges,
	decideApproval,
	GATE_PATHS,
	headAt,
	type IssueEvent,
	latestLabelEvent,
	parseLogins,
	policyProblem,
} from "./baseline-approval.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const POLICY: ApproverPolicy = { approvers: ["jayminwest"], bots: ["warren-run-bot"] };
const SHA_A = "a".repeat(40);
const SHA_B = "b".repeat(40);
const SHA_C = "c".repeat(40);

function labeled(over: Partial<IssueEvent> = {}): IssueEvent {
	return {
		event: "labeled",
		created_at: "2026-10-08T12:00:00Z",
		label: { name: APPROVAL_LABEL },
		actor: { login: "jayminwest", type: "User" },
		performed_via_github_app: null,
		...over,
	};
}

describe("classifyChanges", () => {
	test("refuses an unreadable or empty diff", () => {
		expect(classifyChanges(null).kind).toBe("refuse");
		expect(classifyChanges([]).kind).toBe("refuse");
	});

	test("allows a diff with no baseline paths", () => {
		expect(classifyChanges(["src/ui/src/app.tsx", "scripts/ui-visual/harness.ts"]).kind).toBe(
			"allow",
		);
	});

	test("requires approval for a golden PNG, the manifest, and the comparison config", () => {
		const paths = [
			"scripts/ui-visual/__golden__/runs-desktop-dark.png",
			"scripts/ui-visual/__golden__/manifest.json",
			"scripts/ui-visual/golden.pw.ts",
			".github/workflows/ui-visual.yml",
			"src/ui/src/app.tsx",
		];
		const verdict = classifyChanges(paths);
		expect(verdict).toEqual({ kind: "needs-approval", paths: paths.slice(0, 4) });
	});

	test("matches the golden directory as a prefix and files exactly", () => {
		expect(classifyChanges(["scripts/ui-visual/__golden__x.png"]).kind).toBe("allow");
		expect(classifyChanges(["scripts/ui-visual/golden.pw.ts.bak"]).kind).toBe("allow");
	});

	test("always refuses a change to the gate itself, even with approval paths", () => {
		const verdict = classifyChanges([...GATE_PATHS, "scripts/ui-visual/__golden__/a.png"]);
		expect(verdict.kind).toBe("refuse");
	});

	test("covers every golden file the guard writes", () => {
		expect(BASELINE_PATHS).toContain("scripts/ui-visual/__golden__/");
	});
});

describe("parseLogins", () => {
	test("splits, trims, lowercases, and drops blanks", () => {
		expect(parseLogins(" JayminWest, ,warren-forge[bot] ")).toEqual([
			"jayminwest",
			"warren-forge[bot]",
		]);
		expect(parseLogins(undefined)).toEqual([]);
	});
});

describe("latestLabelEvent", () => {
	test("returns the last labeled or unlabeled event for the approval label", () => {
		const events: IssueEvent[] = [
			labeled({ created_at: "2026-10-08T10:00:00Z" }),
			{ event: "labeled", created_at: "2026-10-08T13:00:00Z", label: { name: "other" } },
			{ ...labeled({ created_at: "2026-10-08T11:00:00Z" }), event: "unlabeled" },
			{ event: "commented", created_at: "2026-10-08T14:00:00Z" },
		];
		expect(latestLabelEvent(events, APPROVAL_LABEL)?.event).toBe("unlabeled");
	});

	test("keeps server order for equal timestamps", () => {
		const removed: IssueEvent = { ...labeled(), event: "unlabeled" };
		expect(latestLabelEvent([labeled(), removed], APPROVAL_LABEL)).toBe(removed);
	});

	test("returns null when the label never appears", () => {
		expect(latestLabelEvent([], APPROVAL_LABEL)).toBeNull();
	});
});

describe("checkApprover", () => {
	test("accepts a listed human who applied the label directly", () => {
		expect(checkApprover(labeled(), POLICY)).toEqual({
			ok: true,
			login: "jayminwest",
			at: "2026-10-08T12:00:00Z",
		});
	});

	test("compares logins case-insensitively", () => {
		const event = labeled({ actor: { login: "JayminWest", type: "User" } });
		expect(checkApprover(event, POLICY).ok).toBe(true);
	});

	const refusals: [string, IssueEvent | null, ApproverPolicy][] = [
		["a label that was never applied", null, POLICY],
		["a removed label", { ...labeled(), event: "unlabeled" }, POLICY],
		[
			"the warren GitHub App installation",
			labeled({ actor: { login: "warren-forge[bot]", type: "Bot" } }),
			POLICY,
		],
		[
			"a workflow GITHUB_TOKEN",
			labeled({ actor: { login: "github-actions[bot]", type: "Bot" } }),
			POLICY,
		],
		[
			"a bot-suffixed login that claims User",
			labeled({ actor: { login: "jayminwest[bot]", type: "User" } }),
			{ approvers: ["jayminwest[bot]"], bots: [] },
		],
		[
			"an approver acting through a GitHub App user token",
			labeled({ performed_via_github_app: { slug: "warren-forge" } }),
			POLICY,
		],
		[
			"the AUTO_MERGE_BOT_LOGIN machine account",
			labeled({ actor: { login: "warren-run-bot", type: "User" } }),
			POLICY,
		],
		[
			"a collaborator who is not an approver",
			labeled({ actor: { login: "someone", type: "User" } }),
			POLICY,
		],
		["an event with no actor", labeled({ actor: null }), POLICY],
		["an event with no timestamp", labeled({ created_at: "" }), POLICY],
		["an empty approver list", labeled(), { approvers: [], bots: [] }],
		[
			"an approver list that names a bot login",
			labeled(),
			{ approvers: ["jayminwest", "warren-run-bot"], bots: ["warren-run-bot"] },
		],
	];
	for (const [name, event, policy] of refusals) {
		test(`refuses ${name}`, () => {
			expect(checkApprover(event, policy).ok).toBe(false);
		});
	}
});

describe("policyProblem", () => {
	test("flags a [bot] login in the approver list", () => {
		expect(policyProblem({ approvers: ["warren-forge[bot]"], bots: [] })).toContain("bot");
		expect(policyProblem(POLICY)).toBeNull();
	});
});

describe("headAt", () => {
	const activities: Activity[] = [
		{ activity_type: "push", after: SHA_C, timestamp: "2026-10-08T12:00:00Z" },
		{ activity_type: "push", after: SHA_B, timestamp: "2026-10-08T11:00:00Z" },
		{ activity_type: "pr_merge", after: SHA_A, timestamp: "2026-10-08T11:30:00Z" },
		{ activity_type: "branch_creation", after: SHA_A, timestamp: "2026-10-08T10:00:00Z" },
	];

	test("returns the head left by the last push strictly before the label", () => {
		expect(headAt(activities, "2026-10-08T11:59:59Z")).toBe(SHA_B);
	});

	test("ignores a push in the same second as the label", () => {
		expect(headAt(activities, "2026-10-08T12:00:00Z")).toBe(SHA_B);
	});

	test("counts branch creation and force pushes, not merges", () => {
		expect(headAt(activities, "2026-10-08T10:30:00Z")).toBe(SHA_A);
		const forced: Activity = {
			activity_type: "force_push",
			after: SHA_C,
			timestamp: "2026-10-08T11:10:00Z",
		};
		expect(headAt([...activities, forced], "2026-10-08T11:40:00Z")).toBe(SHA_C);
	});

	test("returns null when nothing precedes the label or the input is bad", () => {
		expect(headAt(activities, "2026-10-08T09:00:00Z")).toBeNull();
		expect(headAt(activities, "not a date")).toBeNull();
		expect(
			headAt(
				[{ activity_type: "push", after: "zz", timestamp: "2026-10-08T09:00:00Z" }],
				"2026-10-08T10:00:00Z",
			),
		).toBeNull();
	});
});

describe("decideApproval", () => {
	const ok: ApprovalCheck = { ok: true, login: "jayminwest", at: "2026-10-08T12:00:00Z" };

	test("allows when the baselines at the approved head match the current head", () => {
		const d = decideApproval({ check: ok, approvedSha: SHA_B, approvedPrint: "x", headPrint: "x" });
		expect(d.allow).toBe(true);
	});

	test("refuses when the baselines moved after approval", () => {
		const d = decideApproval({ check: ok, approvedSha: SHA_B, approvedPrint: "x", headPrint: "y" });
		expect(d.allow).toBe(false);
		expect(d.reason).toContain("re-apply");
	});

	test("refuses on every unreadable fact", () => {
		const bad = { ok: false, reason: "no" } as const;
		expect(
			decideApproval({ check: bad, approvedSha: SHA_B, approvedPrint: "x", headPrint: "x" }).allow,
		).toBe(false);
		expect(
			decideApproval({ check: ok, approvedSha: null, approvedPrint: "x", headPrint: "x" }).allow,
		).toBe(false);
		expect(
			decideApproval({ check: ok, approvedSha: SHA_B, approvedPrint: null, headPrint: "x" }).allow,
		).toBe(false);
		expect(
			decideApproval({ check: ok, approvedSha: SHA_B, approvedPrint: "x", headPrint: null }).allow,
		).toBe(false);
	});
});

describe("the gate source", () => {
	test("imports nothing but the runtime, so the workflow can run the base-branch copy alone", () => {
		const src = readFileSync(resolve(import.meta.dir, "baseline-approval.ts"), "utf8");
		const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
		expect(imports.every((m) => m?.startsWith("node:"))).toBe(true);
	});
});

type Step = { name?: string; id?: string; if?: string; run?: string; env?: Record<string, string> };
type AutoMergeWorkflow = {
	on?: { pull_request?: { types?: string[] } };
	jobs?: Record<string, { if?: string; steps?: Step[] }>;
};

describe("auto-merge.yml wiring", () => {
	const wf = load(
		readFileSync(resolve(REPO_ROOT, ".github/workflows/auto-merge.yml"), "utf8"),
	) as AutoMergeWorkflow;
	const job = wf.jobs?.["enable-auto-merge"];
	const steps = job?.steps ?? [];
	const named = (name: string): Step | undefined => steps.find((s) => s.name === name);

	test("re-evaluates when the approval label is added or removed", () => {
		expect(wf.on?.pull_request?.types).toEqual(
			expect.arrayContaining(["labeled", "unlabeled", "synchronize"]),
		);
		expect(job?.if).toContain(APPROVAL_LABEL);
	});

	test("runs the base-branch copy of the gate and fails closed", () => {
		const step = named("UI baseline approval check");
		expect(step?.id).toBe("baseline");
		expect(step?.run).toContain("git show");
		expect(step?.run).toMatch(
			/git show "origin\/\$\{BASE_REF\}:scripts\/ui-visual\/baseline-approval\.ts"/,
		);
		expect(step?.run).toContain("hit=false");
	});

	test("mints the token and arms only when both gates say hit=false", () => {
		for (const name of ["Mint app installation token", "Enable auto-merge (squash)"]) {
			const cond = named(name)?.if ?? "";
			expect(cond).toContain("steps.protected.outputs.hit == 'false'");
			expect(cond).toContain("steps.baseline.outputs.hit == 'false'");
		}
	});

	test("disarms when the baseline gate refuses", () => {
		const step = named("Disarm auto-merge on an unapproved baseline change");
		expect(step?.if).toBe("steps.baseline.outputs.hit != 'false'");
		expect(step?.run).toContain("--disable-auto");
	});
});
