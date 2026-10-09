#!/usr/bin/env bun
/**
 * The UI merge-check gate (warren-dbef, plan pl-10db step 16).
 *
 *   bun run scripts/ui-visual/required-checks.ts gate
 *   bun run scripts/ui-visual/required-checks.ts targets
 *
 * `.github/workflows/auto-merge.yml` runs `gate` before it arms auto-merge.
 * A pull request whose diff touches `src/ui/` or `scripts/ui-visual/` may
 * arm only when the `ui-visual` and `design-review` check runs both report
 * success on its exact head sha. Any other pull request passes untouched.
 * The policy lives in docs/design/ui-visual-gate.md ("The merge gate").
 *
 * The checks finish minutes after the workflow first runs, so the first
 * judgement of a UI PR refuses (and disarms). `targets` is the re-judge
 * path: the workflow runs it when a `UI design review` run completes, and
 * it lists the open, unarmed, eligible PRs whose head now carries both
 * checks green, for the arm job to judge again from scratch.
 *
 * Where a check may come from. Only check runs count; commit statuses are
 * ignored. A check run counts only when GitHub Actions created it
 * (`app.slug`), and a `ui-visual` run counts only when its check suite
 * belongs to a `pull_request` run of `.github/workflows/ui-visual.yml` on
 * this head. That stops another app's check, a second workflow with a job
 * of the same name, and the `update_goldens` dispatch (which skips the
 * comparison) from standing in for the real one. Among the check runs
 * that count, the newest one decides, as on the PR page.
 *
 * Self-contained on purpose, like baseline-approval.ts: the workflow runs
 * this file as it exists on the base branch tip, never the PR's copy. Keep
 * it free of imports outside the runtime. Everything above the IO section
 * is pure and covered by `required-checks.test.ts`.
 *
 * Fail closed: any input the gate cannot read lands on refuse.
 */

import { appendFileSync } from "node:fs";

/** The check runs a UI pull request needs, in the order the refusal names them. */
export const REQUIRED_CHECKS = ["ui-visual", "design-review"] as const;
export type RequiredCheck = (typeof REQUIRED_CHECKS)[number];

/** Diff prefixes that make the checks required. */
export const UI_PATHS: readonly string[] = ["src/ui/", "scripts/ui-visual/"];

/** The only app whose check runs count. */
export const ACTIONS_APP = "github-actions";

/** The workflow whose `pull_request` runs own the real `ui-visual` check. */
export const UI_VISUAL_WORKFLOW = ".github/workflows/ui-visual.yml";

/** A PR with this label is never armed by the workflow. */
export const OPT_OUT_LABEL = "no-automerge";

/* ----------------------------------------------------------------------- */
/* Step 1: does this PR need the checks at all?                              */
/* ----------------------------------------------------------------------- */

export type PathVerdict =
	| { readonly kind: "exempt"; readonly reason: string }
	| { readonly kind: "refuse"; readonly reason: string }
	| { readonly kind: "gated"; readonly paths: readonly string[] };

/** `changed` is the three-dot changed-file list, or null when git could not produce it. */
export function classifyChanges(changed: readonly string[] | null): PathVerdict {
	if (changed === null) return { kind: "refuse", reason: "cannot diff the pull request" };
	// warren-7b2f: a PR always changes a file, so an empty list is a broken source.
	if (changed.length === 0) return { kind: "refuse", reason: "empty changed-file list" };
	const paths = changed.filter((p) => UI_PATHS.some((prefix) => p.startsWith(prefix)));
	if (paths.length === 0) {
		return { kind: "exempt", reason: "no src/ui or scripts/ui-visual paths in the diff" };
	}
	return { kind: "gated", paths };
}

/* ----------------------------------------------------------------------- */
/* Step 2: which check run decides, and what does it say?                    */
/* ----------------------------------------------------------------------- */

/** The fields this gate reads from one check run (GET /commits/:sha/check-runs). */
export interface CheckRun {
	readonly id?: number;
	readonly name?: string;
	readonly head_sha?: string;
	readonly status?: string;
	readonly conclusion?: string | null;
	readonly html_url?: string;
	readonly app?: { readonly slug?: string } | null;
	readonly check_suite?: { readonly id?: number } | null;
}

/** The fields this gate reads from the workflow run that owns a check suite. */
export interface SuiteRun {
	readonly path?: string;
	readonly event?: string;
	readonly head_sha?: string;
}

/** Check runs named `name` that GitHub Actions created on `headSha`, newest first. */
export function actionsRuns(runs: readonly CheckRun[], name: string, headSha: string): CheckRun[] {
	return runs
		.filter((r) => r.name === name && r.app?.slug === ACTIONS_APP && r.head_sha === headSha)
		.sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
}

/** True when `run` is a `pull_request` run of the ui-visual workflow on `headSha`. */
export function isUiVisualSuite(run: SuiteRun | null | undefined, headSha: string): boolean {
	return (
		run?.path === UI_VISUAL_WORKFLOW && run.event === "pull_request" && run.head_sha === headSha
	);
}

export type CheckState =
	| { readonly name: RequiredCheck; readonly ok: true; readonly url: string }
	| { readonly name: RequiredCheck; readonly ok: false; readonly problem: string };

/** Judge the check run that decides `name` (null: none counts). */
export function judgeCheck(name: RequiredCheck, run: CheckRun | null): CheckState {
	if (run === null) return { name, ok: false, problem: "has not reported" };
	if (run.status !== "completed") return { name, ok: false, problem: `is ${run.status ?? "?"}` };
	if (run.conclusion !== "success") {
		return { name, ok: false, problem: `concluded ${run.conclusion ?? "?"}` };
	}
	return { name, ok: true, url: run.html_url ?? "" };
}

export type Decision = { readonly allow: boolean; readonly lines: readonly string[] };

/** Allow only when every required check passed; name every one that did not. */
export function decideChecks(states: readonly CheckState[], headSha: string): Decision {
	const head = headSha.slice(0, 12);
	const missing = REQUIRED_CHECKS.filter((n) => !states.some((s) => s.name === n));
	const bad = states.filter((s): s is Extract<CheckState, { ok: false }> => !s.ok);
	if (missing.length === 0 && bad.length === 0) {
		return { allow: true, lines: [`${REQUIRED_CHECKS.join(" and ")} succeeded on ${head}`] };
	}
	const problems = [
		...missing.map((n) => `${n} was not judged`),
		...bad.map((s) => `${s.name} ${s.problem}`),
	];
	return {
		allow: false,
		lines: [
			`${problems.join("; ")} on ${head}`,
			`required for src/ui and scripts/ui-visual changes: ${REQUIRED_CHECKS.join(", ")} (check runs from GitHub Actions)`,
			"a failed check needs a fix and a new push; a pending one needs nothing, since the PR is judged again when a design review completes",
		],
	};
}

/* ----------------------------------------------------------------------- */
/* The re-judge sweep: which open PRs are worth judging again?               */
/* ----------------------------------------------------------------------- */

/** The fields the sweep reads from one pull request (GET /pulls). */
export interface Pull {
	readonly number?: number;
	readonly html_url?: string;
	readonly draft?: boolean;
	readonly user?: { readonly login?: string } | null;
	readonly labels?: readonly { readonly name?: string }[];
	readonly auto_merge?: unknown;
	readonly base?: { readonly sha?: string; readonly ref?: string } | null;
	readonly head?: {
		readonly sha?: string;
		readonly ref?: string;
		readonly repo?: { readonly full_name?: string } | null;
	} | null;
}

/** One matrix entry for the arm job; the same shape the pull_request path builds. */
export interface Target {
	readonly number: number;
	readonly url: string;
	readonly base_sha: string;
	readonly base_ref: string;
	readonly head_sha: string;
	readonly head_ref: string;
	readonly head_repo: string;
}

export interface AuthorPolicy {
	/** The repository owner, lowercased. */
	readonly owner: string;
	/** AUTO_MERGE_BOT_LOGIN entries, lowercased. */
	readonly bots: readonly string[];
}

/** Parse a comma list of GitHub logins (repo variable style), lowercased. */
export function parseLogins(raw: string | undefined): string[] {
	return (raw ?? "")
		.split(",")
		.map((s) => s.trim().toLowerCase())
		.filter((s) => s.length > 0);
}

/**
 * The same admission the pull_request path applies in the `targets` job's
 * `if:`: not a draft, authored by the owner or a listed bot, no opt-out
 * label. Plus: not armed already, since the sweep exists only to arm.
 */
export function isCandidate(pull: Pull, policy: AuthorPolicy): boolean {
	const login = (pull.user?.login ?? "").toLowerCase();
	if (login === "" || pull.draft !== false) return false;
	if (login !== policy.owner && !policy.bots.includes(login)) return false;
	if ((pull.labels ?? []).some((l) => l.name === OPT_OUT_LABEL)) return false;
	return pull.auto_merge === null || pull.auto_merge === undefined;
}

/** The matrix entry for `pull`, or null when a field the arm job needs is absent. */
export function toTarget(pull: Pull): Target | null {
	const fields = {
		number: pull.number,
		url: pull.html_url,
		base_sha: pull.base?.sha,
		base_ref: pull.base?.ref,
		head_sha: pull.head?.sha,
		head_ref: pull.head?.ref,
		head_repo: pull.head?.repo?.full_name,
	};
	for (const v of Object.values(fields)) {
		if (v === undefined || v === "") return null;
	}
	return fields as Target;
}

/* ----------------------------------------------------------------------- */
/* IO: git and the GitHub REST API                                           */
/* ----------------------------------------------------------------------- */

function need(env: Record<string, string | undefined>, key: string): string {
	const v = env[key];
	if (v === undefined || v === "") throw new Error(`missing env ${key}`);
	return v;
}

function changedFiles(base: string, head: string): string[] | null {
	const r = Bun.spawnSync(["git", "diff", "--name-only", `${base}...${head}`], {
		stdout: "pipe",
		stderr: "pipe",
	});
	if (r.exitCode !== 0) return null;
	return r.stdout
		.toString()
		.split("\n")
		.filter((l) => l.length > 0);
}

/** The one REST verb the gate needs; tests pass a fake. */
export interface Api {
	get(path: string): Promise<{ body: unknown; next: string | null }>;
}

function githubApi(env: Record<string, string | undefined>): Api {
	// Set on every Actions runner, and GHES points it at its own API host.
	const base = need(env, "GITHUB_API_URL");
	const token = need(env, "GH_TOKEN");
	return {
		async get(path) {
			const url = path.startsWith("http") ? path : `${base}${path}`;
			const res = await fetch(url, {
				headers: {
					Accept: "application/vnd.github+json",
					Authorization: `Bearer ${token}`,
					"X-GitHub-Api-Version": "2022-11-28",
				},
			});
			if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
			const m = /<([^>]+)>;\s*rel="next"/.exec(res.headers.get("link") ?? "");
			return { body: await res.json(), next: m?.[1] ?? null };
		},
	};
}

/** Every page of `path`; `pick` extracts the list. Throws past `maxPages` rather than judging part. */
async function getAll<T>(
	api: Api,
	path: string,
	pick: (body: unknown) => T[],
	maxPages = 10,
): Promise<T[]> {
	const out: T[] = [];
	let next: string | null = path;
	for (let page = 0; next !== null; page++) {
		if (page >= maxPages) throw new Error(`more than ${maxPages} pages at ${path}`);
		const res: { body: unknown; next: string | null } = await api.get(next);
		out.push(...pick(res.body));
		next = res.next;
	}
	return out;
}

const checkRunsOf = (body: unknown): CheckRun[] =>
	(body as { check_runs?: CheckRun[] }).check_runs ?? [];

/** The check run that decides `name` on `headSha`, or null when none counts. */
async function decidingRun(
	api: Api,
	repo: string,
	name: RequiredCheck,
	headSha: string,
): Promise<CheckRun | null> {
	const q = `check_name=${encodeURIComponent(name)}&filter=all&per_page=100`;
	const all = await getAll(api, `/repos/${repo}/commits/${headSha}/check-runs?${q}`, checkRunsOf);
	const runs = actionsRuns(all, name, headSha);
	if (name !== "ui-visual") return runs[0] ?? null;
	for (const run of runs) {
		const suite = run.check_suite?.id;
		if (suite === undefined) continue;
		const res = await api.get(`/repos/${repo}/actions/runs?check_suite_id=${suite}`);
		const owners = (res.body as { workflow_runs?: SuiteRun[] }).workflow_runs ?? [];
		if (owners.some((o) => isUiVisualSuite(o, headSha))) return run;
	}
	return null;
}

export async function checkStates(api: Api, repo: string, headSha: string): Promise<CheckState[]> {
	const states: CheckState[] = [];
	for (const name of REQUIRED_CHECKS) {
		states.push(judgeCheck(name, await decidingRun(api, repo, name, headSha)));
	}
	return states;
}

/** Run the gate; returns true only when auto-merge may proceed. */
export async function gate(
	env: Record<string, string | undefined>,
	api: Api,
	diff: (base: string, head: string) => string[] | null = changedFiles,
): Promise<boolean> {
	const head = need(env, "HEAD_SHA");
	const verdict = classifyChanges(diff(need(env, "BASE_SHA"), head));
	if (verdict.kind !== "gated") {
		const allow = verdict.kind === "exempt";
		console.log(`UI checks: ${verdict.reason}; ${allow ? "not required" : "refusing auto-merge"}.`);
		return allow;
	}
	console.log(`UI checks: ${verdict.paths.length} UI path(s) changed, so the checks are required.`);
	const decision = decideChecks(await checkStates(api, need(env, "GITHUB_REPOSITORY"), head), head);
	const [first, ...rest] = decision.lines;
	console.log(
		`UI checks: ${first}; ${decision.allow ? "auto-merge may be enabled" : "refusing auto-merge"}.`,
	);
	for (const line of rest) console.log(`UI checks: ${line}`);
	if (!decision.allow) {
		// An annotation lands on the check run, where an agent reading it finds the reason.
		console.log(`::notice title=auto-merge refused (UI checks)::${first}`);
		const summary = env.GITHUB_STEP_SUMMARY;
		if (summary) appendFileSync(summary, `**Auto-merge refused (UI checks):** ${first}\n`);
	}
	return decision.allow;
}

/** The sweep: open, unarmed, eligible PRs whose head has both checks green. */
export async function targets(
	env: Record<string, string | undefined>,
	api: Api,
): Promise<Target[]> {
	const repo = need(env, "GITHUB_REPOSITORY");
	const policy = { owner: need(env, "OWNER").toLowerCase(), bots: parseLogins(env.BOT_LOGINS) };
	const pulls = await getAll(
		api,
		`/repos/${repo}/pulls?state=open&per_page=100`,
		(b) => b as Pull[],
	);
	const out: Target[] = [];
	for (const pull of pulls.filter((p) => isCandidate(p, policy))) {
		const target = toTarget(pull);
		if (target === null) continue;
		const decision = decideChecks(await checkStates(api, repo, target.head_sha), target.head_sha);
		console.log(
			`#${target.number}: ${decision.allow ? "re-judge" : "skip"} (${decision.lines[0]})`,
		);
		if (decision.allow) out.push(target);
	}
	return out;
}

async function main(): Promise<number> {
	const mode = process.argv[2];
	const api = githubApi(process.env);
	if (mode === "gate") {
		const allow = await gate(process.env, api);
		appendFileSync(need(process.env, "DECISION_FILE"), `hit=${allow ? "false" : "true"}\n`);
		return 0;
	}
	if (mode === "targets") {
		const list = await targets(process.env, api);
		appendFileSync(need(process.env, "GITHUB_OUTPUT"), `prs=${JSON.stringify(list)}\n`);
		return 0;
	}
	console.error("usage: bun run scripts/ui-visual/required-checks.ts gate|targets");
	return 2;
}

if (import.meta.main) {
	main().then(
		(code) => process.exit(code),
		(err: unknown) => {
			console.error(`UI checks: error: ${err instanceof Error ? err.message : String(err)}`);
			process.exit(1);
		},
	);
}
