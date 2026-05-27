import { parseGitHubUrl } from "../../projects/url.ts";
import {
	type AutoOpenPrConfig,
	type BuildPrContentInput,
	buildPrContent,
	type OpenPullRequestInput,
	type OpenPullRequestResult,
	type PrCommit,
	type PrSeed,
} from "../pr.ts";
import type { PrTemplateOverrides } from "../pr-template.ts";
import type { ReapExec } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* PR open (warren-f6af)                                                    */
/* ----------------------------------------------------------------------- */

export interface TryOpenPrInput {
	readonly project: { gitUrl: string; defaultBranch: string };
	readonly branch: string;
	readonly autoOpen: AutoOpenPrConfig;
	readonly run: {
		id: string;
		agentName: string;
		prompt: string;
		startedAt: string | null;
		endedAt: string | null;
		costUsd: number | null;
		tokensInput: number | null;
		tokensOutput: number | null;
		tokensCacheRead: number | null;
	};
	readonly prContext: PrContext;
	readonly previewOptedIn: boolean;
	readonly openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
	readonly prTemplate?: PrTemplateOverrides;
}

export async function tryOpenPr(input: TryOpenPrInput): Promise<OpenPullRequestResult> {
	if (input.autoOpen.token === "") {
		return {
			ok: false,
			reason: "missing_token",
			message: "GITHUB_TOKEN unset; skipping auto-open PR",
		};
	}
	const parsed = parseGitHubUrl(input.project.gitUrl);
	const contentInput: BuildPrContentInput = {
		prompt: input.run.prompt,
		runId: input.run.id,
		agentName: input.run.agentName,
		commits: input.prContext.commits,
		diffStat: input.prContext.diffStat,
		previewOptedIn: input.previewOptedIn,
		...(input.autoOpen.warrenBaseUrl !== null
			? { warrenBaseUrl: input.autoOpen.warrenBaseUrl }
			: {}),
		...(input.prContext.seed !== null ? { seed: input.prContext.seed } : {}),
		...(input.run.startedAt !== null ? { startedAt: input.run.startedAt } : {}),
		...(input.run.endedAt !== null ? { endedAt: input.run.endedAt } : {}),
		...(input.run.costUsd !== null ? { costUsd: input.run.costUsd } : {}),
		...(input.run.tokensInput !== null ? { tokensInput: input.run.tokensInput } : {}),
		...(input.run.tokensOutput !== null ? { tokensOutput: input.run.tokensOutput } : {}),
		...(input.run.tokensCacheRead !== null ? { tokensCacheRead: input.run.tokensCacheRead } : {}),
		...(input.prTemplate !== undefined ? { templateOverrides: input.prTemplate } : {}),
	};
	const content = buildPrContent(contentInput);
	return input.openPr({
		owner: parsed.owner,
		repo: parsed.name,
		head: input.branch,
		base: input.project.defaultBranch,
		title: content.title,
		body: content.body,
		token: input.autoOpen.token,
	});
}

/* ----------------------------------------------------------------------- */
/* PR context gathering (warren-9ee3)                                       */
/* ----------------------------------------------------------------------- */

export interface GatherPrContextInput {
	readonly workspacePath: string;
	readonly projectPath: string;
	readonly baseBranch: string;
	readonly prompt: string;
	readonly exec: ReapExec;
}

export interface PrContext {
	readonly commits: readonly PrCommit[];
	readonly diffStat: string;
	readonly seed: PrSeed | null;
}

/**
 * Best-effort gathering of the data buildPrContent needs to fill in the
 * commits / files-changed / seeds sections. Each sub-call is wrapped: a
 * git error or missing `sd` CLI degrades to empty data rather than
 * failing the PR open.
 */
export async function gatherPrContext(input: GatherPrContextInput): Promise<PrContext> {
	const [commits, diffStat, seed] = await Promise.all([
		collectCommits(input.workspacePath, input.baseBranch, input.exec),
		collectDiffStat(input.workspacePath, input.baseBranch, input.exec),
		resolveSeed(input.prompt, input.projectPath, input.exec),
	]);
	return { commits, diffStat, seed };
}

async function collectCommits(
	workspacePath: string,
	baseBranch: string,
	exec: ReapExec,
): Promise<PrCommit[]> {
	try {
		const out = await exec.run(
			"git",
			["log", "--reverse", "--pretty=format:%H %s", `${baseBranch}..HEAD`],
			{ cwd: workspacePath, timeoutMs: 10_000 },
		);
		const commits: PrCommit[] = [];
		for (const raw of out.stdout.split("\n")) {
			const line = raw.trimEnd();
			if (line === "") continue;
			const sp = line.indexOf(" ");
			if (sp === -1) continue;
			commits.push({ sha: line.slice(0, sp), subject: line.slice(sp + 1) });
		}
		return commits;
	} catch {
		return [];
	}
}

async function collectDiffStat(
	workspacePath: string,
	baseBranch: string,
	exec: ReapExec,
): Promise<string> {
	try {
		const out = await exec.run("git", ["diff", "--stat", `${baseBranch}..HEAD`], {
			cwd: workspacePath,
			timeoutMs: 10_000,
		});
		return out.stdout;
	} catch {
		return "";
	}
}

// Matches seed ids like `warren-17a4`, `seeds-9ee3`, `mulch-cafe` — a
// lowercase prefix with optional internal dashes, followed by `-` and a
// 4+ char lowercase-hex suffix. Trailing hex suffix anchors the match;
// the prefix-with-dashes regex would otherwise eat ordinary words.
const SEED_ID_RE = /\b([a-z][a-z-]*-[a-f0-9]{4,})\b/;

async function resolveSeed(prompt: string, cwd: string, exec: ReapExec): Promise<PrSeed | null> {
	const m = SEED_ID_RE.exec(prompt);
	if (m === null) return null;
	const id = m[1];
	if (id === undefined) return null;
	try {
		const out = await exec.run("sd", ["show", id, "--format", "json"], {
			cwd,
			timeoutMs: 10_000,
		});
		const parsed: unknown = JSON.parse(out.stdout);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const obj = parsed as Record<string, unknown>;
		const issue = obj.issue ?? obj;
		if (issue === null || typeof issue !== "object" || Array.isArray(issue)) return null;
		const title = (issue as Record<string, unknown>).title;
		if (typeof title !== "string" || title === "") return null;
		return { id, title };
	} catch {
		return null;
	}
}

export interface RunPrOpenInput {
	readonly autoOpen: AutoOpenPrConfig;
	readonly project: {
		gitUrl: string;
		defaultBranch: string;
		localPath: string;
	};
	readonly run: TryOpenPrInput["run"] & { prompt: string };
	readonly branch: string;
	readonly baseBranch: string | null;
	readonly workspacePath: string;
	readonly previewOptedIn: boolean;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly fail: (step: "pr_open", err: unknown) => Promise<void>;
	readonly setPrUrl: (runId: string, url: string) => Promise<unknown>;
	readonly openPr: (input: OpenPullRequestInput) => Promise<OpenPullRequestResult>;
	readonly prTemplate?: PrTemplateOverrides;
}

/**
 * Best-effort PR-open sub-step. Returns the opened PR url on success
 * (and persists it via `setPrUrl`); `null` on skip / failure. Mirrors
 * the original inline block in `reapRun` — failures emit
 * `reap_failed` step=pr_open and never fail the run.
 */
export async function runPrOpen(input: RunPrOpenInput): Promise<string | null> {
	try {
		const prContext = await gatherPrContext({
			workspacePath: input.workspacePath,
			projectPath: input.project.localPath,
			baseBranch: input.project.defaultBranch,
			prompt: input.run.prompt,
			exec: input.exec,
		});
		const opened = await tryOpenPr({
			project: input.project,
			branch: input.branch,
			autoOpen: input.autoOpen,
			run: input.run,
			prContext,
			previewOptedIn: input.previewOptedIn,
			openPr: input.openPr,
			...(input.prTemplate !== undefined ? { prTemplate: input.prTemplate } : {}),
		});
		if (opened.ok) {
			await input.setPrUrl(input.run.id, opened.url);
			await input.emit("reap.pr_opened", {
				prUrl: opened.url,
				mode: opened.mode,
				branch: input.branch,
				baseBranch: input.baseBranch,
			});
			return opened.url;
		}
		await input.fail("pr_open", new Error(`${opened.reason}: ${opened.message}`));
		return null;
	} catch (err) {
		await input.fail("pr_open", err);
		return null;
	}
}
