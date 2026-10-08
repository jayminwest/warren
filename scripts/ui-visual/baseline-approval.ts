#!/usr/bin/env bun
/**
 * The UI baseline approval gate (warren-4780, plan pl-10db step 11).
 *
 *   bun run scripts/ui-visual/baseline-approval.ts gate
 *
 * `.github/workflows/auto-merge.yml` runs this before it arms auto-merge.
 * A pull request that changes the golden baselines, or the machinery that
 * compares against them, may auto-merge only when a human approver applied
 * the `ui-baseline-approved` label to the exact baseline content the PR now
 * carries. The policy and its threat model live in
 * docs/design/ui-visual-gate.md.
 *
 * Three facts decide it, each read from a source no bot can write:
 *
 *   1. Who applied the label: the latest labeled/unlabeled event for it in
 *      the issue events API. Label presence alone proves nothing, because the
 *      warren GitHub App, the AUTO_MERGE_BOT_LOGIN machine account, and any
 *      workflow's GITHUB_TOKEN can all add a label. The event records the
 *      actor, the actor type, and any GitHub App it acted through.
 *   2. Which head the human saw: the repository activity API records every
 *      push to the head branch with a server-side timestamp. The head at
 *      approval time is the `after` of the last push strictly before the
 *      label event. Commit dates are author-controlled, so they never count.
 *   3. Whether the baselines moved since: the git object ids of every
 *      baseline path at that head must equal the ones at the current head.
 *      A later push that changes a baseline voids the approval.
 *
 * Self-contained on purpose: the workflow runs this file as it exists on the
 * base branch tip (`git show origin/<base>:...`), never the PR's copy, so a
 * PR cannot rewrite the gate that judges it. Keep it free of imports outside
 * the runtime. Everything above `main()` is pure and covered by
 * `baseline-approval.test.ts`.
 *
 * Fail closed: any input the gate cannot read lands on refuse, never allow.
 */

import { appendFileSync } from "node:fs";

/** The label a human applies to approve a baseline change. */
export const APPROVAL_LABEL = "ui-baseline-approved";

/**
 * Paths whose change needs an approval: the baselines, plus the files that
 * decide how a render compares against them (the case list, the tolerance,
 * the manifest guard, the Playwright config, and the workflow that runs the
 * comparison). Loosening any of these launders a regression as surely as a
 * regenerated PNG. An entry ending in `/` is a directory prefix; any other
 * entry is an exact file.
 */
export const BASELINE_PATHS: readonly string[] = [
	"scripts/ui-visual/__golden__/",
	"scripts/ui-visual/golden-cases.ts",
	"scripts/ui-visual/golden-manifest.ts",
	"scripts/ui-visual/golden.pw.ts",
	"scripts/ui-visual/goldens.ts",
	"scripts/ui-visual/playwright.config.ts",
	".github/workflows/ui-visual.yml",
];

/** The gate's own source. A change here always needs a human merge. */
export const GATE_PATHS: readonly string[] = ["scripts/ui-visual/baseline-approval.ts"];

/** Push activity types that move a branch head. */
const HEAD_MOVES: ReadonlySet<string> = new Set(["push", "force_push", "branch_creation"]);
const SHA = /^[0-9a-f]{40}$/;

export function matchesEntry(path: string, entry: string): boolean {
	return entry.endsWith("/") ? path.startsWith(entry) : path === entry;
}

function matching(paths: readonly string[], entries: readonly string[]): string[] {
	return paths.filter((p) => entries.some((e) => matchesEntry(p, e)));
}

/** Parse a comma list of GitHub logins (repo variable style), lowercased. */
export function parseLogins(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
}

/* ----------------------------------------------------------------------- */
/* Step 1: does this PR need an approval at all?                             */
/* ----------------------------------------------------------------------- */

export type PathVerdict =
	| { readonly kind: "allow"; readonly reason: string }
	| { readonly kind: "refuse"; readonly reason: string; readonly paths?: readonly string[] }
	| { readonly kind: "needs-approval"; readonly paths: readonly string[] };

/** `changed` is the three-dot changed-file list, or null when git could not produce it. */
export function classifyChanges(changed: readonly string[] | null): PathVerdict {
	if (changed === null) return { kind: "refuse", reason: "cannot diff the pull request" };
	// warren-7b2f: a PR always changes a file, so an empty list is a broken source.
	if (changed.length === 0) return { kind: "refuse", reason: "empty changed-file list" };
	const gate = matching(changed, GATE_PATHS);
	if (gate.length > 0) {
		return { kind: "refuse", reason: "the approval gate itself changed", paths: gate };
	}
	const baseline = matching(changed, BASELINE_PATHS);
	if (baseline.length === 0) return { kind: "allow", reason: "no baseline paths in the diff" };
	return { kind: "needs-approval", paths: baseline };
}

/* ----------------------------------------------------------------------- */
/* Step 2: who applied the label?                                            */
/* ----------------------------------------------------------------------- */

/** The fields this gate reads from one issue event (GET /issues/:n/events). */
export interface IssueEvent {
	readonly id?: number;
	readonly event?: string;
	readonly created_at?: string;
	readonly label?: { readonly name?: string } | null;
	readonly actor?: { readonly login?: string; readonly type?: string } | null;
	readonly performed_via_github_app?: { readonly slug?: string } | null;
}

/** The latest labeled/unlabeled event for `label`, in server order. */
export function latestLabelEvent(events: readonly IssueEvent[], label: string): IssueEvent | null {
	const hits = events
		.map((e, index) => ({ e, index }))
		.filter(
			({ e }) => (e.event === "labeled" || e.event === "unlabeled") && e.label?.name === label,
		);
	// Stable: equal timestamps keep the API's order, which is chronological.
	hits.sort(
		(a, b) => (a.e.created_at ?? "").localeCompare(b.e.created_at ?? "") || a.index - b.index,
	);
	return hits.at(-1)?.e ?? null;
}

export interface ApproverPolicy {
	/** Logins allowed to approve, lowercased. */
	readonly approvers: readonly string[];
	/** AUTO_MERGE_BOT_LOGIN entries, lowercased. Never an approver. */
	readonly bots: readonly string[];
}

export type ApprovalCheck =
	| { readonly ok: true; readonly login: string; readonly at: string }
	| { readonly ok: false; readonly reason: string };

/** A misconfigured policy refuses every approval rather than guessing. */
export function policyProblem(policy: ApproverPolicy): string | null {
	if (policy.approvers.length === 0) return "no approvers configured (UI_BASELINE_APPROVERS)";
	const overlap = policy.approvers.filter((a) => policy.bots.includes(a) || a.endsWith("[bot]"));
	if (overlap.length > 0) return `approver list names a bot identity: ${overlap.join(", ")}`;
	return null;
}

function actorProblem(event: IssueEvent, policy: ApproverPolicy): string | null {
	const login = (event.actor?.login ?? "").toLowerCase();
	if (login === "") return "the label event has no actor";
	if (event.actor?.type !== "User")
		return `applied by ${login}, a ${event.actor?.type ?? "?"} account`;
	if (login.endsWith("[bot]")) return `applied by the bot ${login}`;
	const app = event.performed_via_github_app;
	if (app !== null && app !== undefined) {
		return `applied by ${login} through the GitHub App ${app.slug ?? "?"}`;
	}
	if (policy.bots.includes(login)) return `applied by ${login}, an AUTO_MERGE_BOT_LOGIN identity`;
	if (!policy.approvers.includes(login)) return `applied by ${login}, who is not an approver`;
	return null;
}

export function checkApprover(event: IssueEvent | null, policy: ApproverPolicy): ApprovalCheck {
	const misconfig = policyProblem(policy);
	if (misconfig !== null) return { ok: false, reason: misconfig };
	if (event === null) return { ok: false, reason: `the ${APPROVAL_LABEL} label was never applied` };
	if (event.event !== "labeled") {
		const who = event.actor?.login ?? "?";
		return { ok: false, reason: `the label was removed by ${who} at ${event.created_at ?? "?"}` };
	}
	const problem = actorProblem(event, policy);
	if (problem !== null) return { ok: false, reason: problem };
	const at = event.created_at ?? "";
	if (Number.isNaN(Date.parse(at)))
		return { ok: false, reason: "the label event has no timestamp" };
	return { ok: true, login: (event.actor?.login ?? "").toLowerCase(), at };
}

/* ----------------------------------------------------------------------- */
/* Step 3: which head did the approver see, and did the baselines move?      */
/* ----------------------------------------------------------------------- */

/** The fields this gate reads from one repository activity entry. */
export interface Activity {
	readonly after?: string;
	readonly timestamp?: string;
	readonly activity_type?: string;
}

/**
 * The branch head at `at`: the `after` of the latest head move strictly
 * before it. Strict, because a push in the same second as the label may
 * have landed after the human looked. Null when no move precedes it.
 */
export function headAt(activities: readonly Activity[], at: string): string | null {
	const cutoff = Date.parse(at);
	if (Number.isNaN(cutoff)) return null;
	let best: { sha: string; t: number } | null = null;
	for (const a of activities) {
		const t = Date.parse(a.timestamp ?? "");
		if (!HEAD_MOVES.has(a.activity_type ?? "") || Number.isNaN(t) || t >= cutoff) continue;
		if (!SHA.test(a.after ?? "")) continue;
		if (best === null || t > best.t) best = { sha: a.after as string, t };
	}
	return best?.sha ?? null;
}

export interface ApprovalFacts {
	readonly check: ApprovalCheck;
	/** Head at approval time, or null when the activity log could not place it. */
	readonly approvedSha: string | null;
	/** Baseline fingerprint at `approvedSha`, or null when git cannot read it. */
	readonly approvedPrint: string | null;
	/** Baseline fingerprint at the current head, or null when git cannot read it. */
	readonly headPrint: string | null;
}

export type Decision = { readonly allow: boolean; readonly reason: string };

export function decideApproval(facts: ApprovalFacts): Decision {
	const { check } = facts;
	if (!check.ok) return { allow: false, reason: check.reason };
	const who = `${check.login} at ${check.at}`;
	if (facts.approvedSha === null) {
		return { allow: false, reason: `cannot place the branch head when ${who} approved` };
	}
	if (facts.approvedPrint === null || facts.headPrint === null) {
		return { allow: false, reason: "cannot read the baseline paths from git" };
	}
	if (facts.approvedPrint !== facts.headPrint) {
		return {
			allow: false,
			reason:
				`the baselines changed after ${who} approved ${facts.approvedSha.slice(0, 12)}; ` +
				`remove and re-apply ${APPROVAL_LABEL} after reviewing the new diff`,
		};
	}
	return { allow: true, reason: `approved by ${who} (head ${facts.approvedSha.slice(0, 12)})` };
}

/* ----------------------------------------------------------------------- */
/* IO: git and the GitHub REST API                                           */
/* ----------------------------------------------------------------------- */

function git(args: string[]): string | null {
	const r = Bun.spawnSync(["git", ...args], { stdout: "pipe", stderr: "pipe" });
	return r.exitCode === 0 ? r.stdout.toString() : null;
}

function changedFiles(base: string, head: string): string[] | null {
	const out = git(["diff", "--name-only", `${base}...${head}`]);
	return out === null ? null : out.split("\n").filter((l) => l.length > 0);
}

/** `path=<object id or ->` for every baseline path at `sha`; null when `sha` is unreadable. */
function fingerprint(sha: string): string | null {
	if (git(["cat-file", "-e", `${sha}^{commit}`]) === null) {
		git(["fetch", "--quiet", "--no-tags", "origin", sha]);
		if (git(["cat-file", "-e", `${sha}^{commit}`]) === null) return null;
	}
	const parts = BASELINE_PATHS.map((entry) => {
		const path = entry.endsWith("/") ? entry.slice(0, -1) : entry;
		const id = git(["rev-parse", "--verify", "--quiet", `${sha}:${path}`]);
		return `${path}=${id === null ? "-" : id.trim()}`;
	});
	return parts.join("\n");
}

function nextLink(header: string | null): string | null {
	const m = /<([^>]+)>;\s*rel="next"/.exec(header ?? "");
	return m?.[1] ?? null;
}

/** Every page of a list endpoint; throws past `maxPages` rather than judging a partial list. */
async function fetchAll<T>(url: string, token: string, maxPages: number): Promise<T[]> {
	const out: T[] = [];
	let next: string | null = url;
	for (let page = 0; next !== null; page++) {
		if (page >= maxPages) throw new Error(`more than ${maxPages} pages at ${url}`);
		const res: Response = await fetch(next, {
			headers: {
				Accept: "application/vnd.github+json",
				Authorization: `Bearer ${token}`,
				"X-GitHub-Api-Version": "2022-11-28",
			},
		});
		if (!res.ok) throw new Error(`GET ${next} -> HTTP ${res.status}`);
		out.push(...((await res.json()) as T[]));
		next = nextLink(res.headers.get("link"));
	}
	return out;
}

function need(env: Record<string, string | undefined>, key: string): string {
	const v = env[key];
	if (v === undefined || v === "") throw new Error(`missing env ${key}`);
	return v;
}

async function approvalFacts(env: Record<string, string | undefined>): Promise<ApprovalFacts> {
	// Set on every Actions runner, and GHES points it at its own API host.
	const api = need(env, "GITHUB_API_URL");
	const repo = need(env, "GITHUB_REPOSITORY");
	const token = need(env, "GH_TOKEN");
	const policy = { approvers: parseLogins(env.APPROVERS), bots: parseLogins(env.BOT_LOGINS) };
	const events = await fetchAll<IssueEvent>(
		`${api}/repos/${repo}/issues/${need(env, "PR_NUMBER")}/events?per_page=100`,
		token,
		30,
	);
	const check = checkApprover(latestLabelEvent(events, APPROVAL_LABEL), policy);
	const headPrint = fingerprint(need(env, "HEAD_SHA"));
	const none = { approvedSha: null, approvedPrint: null, headPrint };
	if (!check.ok) return { check, ...none };
	// The activity log is per repository; a fork's pushes are not in ours.
	if (need(env, "HEAD_REPO") !== repo) {
		return { check: { ok: false, reason: "the head branch lives in a fork" }, ...none };
	}
	const ref = encodeURIComponent(`refs/heads/${need(env, "HEAD_REF")}`);
	const activities = await fetchAll<Activity>(
		`${api}/repos/${repo}/activity?ref=${ref}&per_page=100`,
		token,
		30,
	);
	const approvedSha = headAt(activities, check.at);
	const approvedPrint = approvedSha === null ? null : fingerprint(approvedSha);
	return { check, approvedSha, approvedPrint, headPrint };
}

/** Run the gate; returns true only when auto-merge may proceed. */
export async function gate(env: Record<string, string | undefined>): Promise<boolean> {
	const verdict = classifyChanges(changedFiles(need(env, "BASE_SHA"), need(env, "HEAD_SHA")));
	if (verdict.kind === "allow") {
		console.log(`UI baselines: ${verdict.reason}; auto-merge may be enabled.`);
		return true;
	}
	if (verdict.kind === "refuse") {
		console.log(`UI baselines: ${verdict.reason}; refusing auto-merge (human merge).`);
		for (const p of verdict.paths ?? []) console.log(`  ${p}`);
		return false;
	}
	console.log(`UI baselines: ${verdict.paths.length} baseline path(s) changed:`);
	for (const p of verdict.paths) console.log(`  ${p}`);
	const decision = decideApproval(await approvalFacts(env));
	if (decision.allow) {
		console.log(`UI baselines: ${decision.reason}; auto-merge may be enabled.`);
	} else {
		console.log(`UI baselines: ${decision.reason}; refusing auto-merge.`);
		console.log(`UI baselines: approval workflow: docs/design/ui-visual-gate.md`);
	}
	return decision.allow;
}

async function main(): Promise<number> {
	if (process.argv[2] !== "gate") {
		console.error("usage: bun run scripts/ui-visual/baseline-approval.ts gate");
		return 2;
	}
	const out = need(process.env, "DECISION_FILE");
	const allow = await gate(process.env);
	appendFileSync(out, `hit=${allow ? "false" : "true"}\n`);
	return 0;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(err: unknown) => {
			console.error(
				`UI baselines: gate error: ${err instanceof Error ? err.message : String(err)}`,
			);
			process.exit(1);
		},
	);
}
