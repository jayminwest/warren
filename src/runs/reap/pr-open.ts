import { CI_FIXER_TRIGGER } from "../../ci-fixer/poller.ts";
import type { Forge, ForgeErrorKind, PullRequestRef, RepoRef } from "../../forge/contract.ts";
import { mintGitCredential } from "../../forge/credentials.ts";
import type { IssueTracker } from "../../tracker/contract.ts";
import { type AutoOpenPrConfig, type BuildPrContentInput, buildPrContent } from "../pr.ts";
import type { PrTemplateOverrides } from "../pr-template.ts";
import { type CloneFetchConfig, gatherPrContext, type PrContext } from "./pr-context.ts";
import type { ReapExec } from "./types.ts";

/* ----------------------------------------------------------------------- */
/* Semantic retry policy for PR open (warren-70c6, collapsed in warren-45e6)  */
/* ----------------------------------------------------------------------- */

// 3 retries after the initial attempt: ~1s, ~2s, ~4s backoff.
const PR_OPEN_RETRY_DELAYS_MS = [1_000, 2_000, 4_000] as const;

function defaultSleep(ms: number): Promise<void> {
	return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

/**
 * Semantic retry (forge-contract.md §3: "semantic retry stays in the domain;
 * transport retry moves to the forge"). The provider already retried the
 * transport classes (network/5xx/429) in-band, so the ONLY kind worth a
 * domain retry is `conflict` — the transient 422 ("head invalid") the forge
 * returns while it is still indexing the just-pushed ref. The permanent
 * "No commits between" 422 arrives as the SAME classified conflict: the
 * pipeline's `commitsAhead > 0` gate means it should never occur, and when
 * it slips through it simply exhausts the retries — no message-string
 * re-derivation (warren-45e6). `no_credential` (operator config) and every
 * other kind surface immediately.
 */
function isRetryablePrErrorKind(kind: ForgeErrorKind | "unowned_url"): boolean {
	return kind === "conflict";
}

/* ----------------------------------------------------------------------- */
/* PR open (warren-f6af; Forge seam warren-45e6)                             */
/* ----------------------------------------------------------------------- */

/**
 * A successfully opened (or found) PR. Carries the opaque forge refs and the
 * composed body alongside the URL so the `pr_annotate_preview` sub-step can
 * rewrite the body through `forge.setPullRequestBody` without re-deriving
 * either — the domain composed this body moments ago in the same reap, and
 * the Forge contract deliberately has no body read (forge-contract.md §3).
 */
export interface OpenedPr {
	readonly url: string;
	readonly mode: "created" | "exists";
	readonly repoRef: RepoRef;
	readonly prRef: PullRequestRef;
	readonly body: string;
}

export type TryOpenPrResult =
	| { readonly ok: true; readonly pr: OpenedPr }
	| {
			readonly ok: false;
			/** `unowned_url`: no forge claimed the project clone URL (parseRepoRef → null). */
			readonly kind: ForgeErrorKind | "unowned_url";
			readonly detail: string;
	  };

export interface TryOpenPrInput {
	readonly project: { gitUrl: string; defaultBranch: string };
	readonly branch: string;
	/** Resolved PR base (warren-8cbf): the run's clone ref, else the project default branch. */
	readonly baseBranch: string;
	readonly autoOpen: AutoOpenPrConfig;
	/** The boot-resolved forge (warren-45e6). Owns URL parsing, credentials, transport. */
	readonly forge: Forge;
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
	readonly prTemplate?: PrTemplateOverrides;
}

export async function tryOpenPr(input: TryOpenPrInput): Promise<TryOpenPrResult> {
	// parseRepoRef NEVER throws: null means this forge does not own the URL.
	// Surfaced as a pr_open failure by the caller — never a reap crash.
	const ref = input.forge.parseRepoRef(input.project.gitUrl);
	if (ref === null) {
		return {
			ok: false,
			kind: "unowned_url",
			detail: `no forge owns the project clone URL (${input.project.gitUrl}); cannot open a pull request`,
		};
	}
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
		...(input.prContext.finalCommitBody !== null
			? { agentNotes: input.prContext.finalCommitBody }
			: {}),
		...(input.run.startedAt !== null ? { startedAt: input.run.startedAt } : {}),
		...(input.run.endedAt !== null ? { endedAt: input.run.endedAt } : {}),
		...(input.run.costUsd !== null ? { costUsd: input.run.costUsd } : {}),
		...(input.run.tokensInput !== null ? { tokensInput: input.run.tokensInput } : {}),
		...(input.run.tokensOutput !== null ? { tokensOutput: input.run.tokensOutput } : {}),
		...(input.run.tokensCacheRead !== null ? { tokensCacheRead: input.run.tokensCacheRead } : {}),
		...(input.prTemplate !== undefined ? { templateOverrides: input.prTemplate } : {}),
	};
	const content = buildPrContent(contentInput);
	const draft = {
		title: content.title,
		body: content.body,
		headBranch: input.branch,
		baseBranch: input.baseBranch,
	};
	// Find-then-open keeps the re-reap sweep idempotent WITHOUT a POST: a PR
	// already covering this head→base resolves to mode "exists" (the provider's
	// own openPullRequest would resolve the duplicate too, but then the domain
	// could not report the distinction). A failed find degrades to open — the
	// provider's duplicate resolution is the backstop.
	const found = await input.forge.findPullRequest(ref, {
		headBranch: input.branch,
		baseBranch: input.baseBranch,
	});
	if (found.ok && found.value !== null) {
		return {
			ok: true,
			pr: {
				url: found.value.webUrl,
				mode: "exists",
				repoRef: ref,
				prRef: found.value,
				body: content.body,
			},
		};
	}
	const opened = await input.forge.openPullRequest(ref, draft);
	if (!opened.ok) {
		return { ok: false, kind: opened.error.kind, detail: opened.error.detail };
	}
	return {
		ok: true,
		pr: {
			url: opened.value.webUrl,
			mode: "created",
			repoRef: ref,
			prRef: opened.value,
			body: content.body,
		},
	};
}

export interface RunPrOpenInput {
	readonly autoOpen: AutoOpenPrConfig;
	readonly project: {
		readonly id: string;
		gitUrl: string;
		defaultBranch: string;
		localPath: string;
	};
	/** `seedId` is the authoritative PR attribution source (warren-50c8). */
	readonly run: TryOpenPrInput["run"] & {
		prompt: string;
		trigger?: string;
		seedId?: string | null;
	};
	readonly branch: string;
	/** Resolved base branch (warren-8cbf): the run's clone ref when one was
	 * frozen on the row, else the project default branch. null falls back to
	 * the project default branch here. */
	readonly baseBranch: string | null;
	/** Host workspace path, or `null` under K8s (PR-context git reads degrade). */
	readonly workspacePath: string | null;
	readonly previewOptedIn: boolean;
	readonly exec: ReapExec;
	readonly emit: (kind: string, payload: unknown) => Promise<unknown>;
	readonly fail: (step: "pr_open", err: unknown) => Promise<void>;
	readonly setPrUrl: (runId: string, url: string) => Promise<unknown>;
	/** The boot-resolved forge (warren-45e6). */
	readonly forge: Forge;
	readonly prTemplate?: PrTemplateOverrides;
	/** Boot-resolved issue tracker for seed attribution (warren-47b0). */
	readonly issueTracker?: IssueTracker;
	/** Injected sleep for tests; defaults to real setTimeout-based sleep. */
	readonly sleep?: (ms: number) => Promise<void>;
}

/**
 * warren-8cbf: the effective PR base — the run's frozen clone ref when one
 * was threaded through reap, else the project default branch (byte-identical
 * to the pre-warren-8cbf behavior for a ref-less dispatch). Merging the PR
 * into the ref IS the parent-branch advance a chained plan-run needs.
 */
function resolvePrBase(input: RunPrOpenInput): string {
	return input.baseBranch ?? input.project.defaultBranch;
}

/**
 * warren-ab66 (K8s): with no host workspace, mint a fetch credential from
 * the forge (warren-45e6, §4) so the PR-context sections can be rebuilt from
 * the pushed run branch fetched into the project clone. A forge that owns no
 * credential for the URL keeps the pre-warren-ab66 empty-section path.
 */
async function resolveCloneFetchConfig(
	input: RunPrOpenInput,
): Promise<CloneFetchConfig | undefined> {
	if (input.workspacePath !== null) return undefined;
	const gitCredential = await mintGitCredential(input.forge, input.project.gitUrl);
	if (gitCredential === undefined) return undefined;
	return {
		runBranch: input.branch,
		runId: input.run.id,
		gitUrl: input.project.gitUrl,
		gitCredential,
	};
}

/**
 * Best-effort PR-open sub-step. Returns the opened PR handle (URL persisted
 * via `setPrUrl`; refs + composed body threaded to `pr_annotate_preview`);
 * `null` on skip / failure. Mirrors the original inline block in `reapRun` —
 * failures emit `reap_failed` step=pr_open and never fail the run.
 */
export async function runPrOpen(input: RunPrOpenInput): Promise<OpenedPr | null> {
	// warren-a993: a CI-fixer run pushed its fix onto the open PR's head branch
	// (targetBranch), which re-runs that PR's CI. A fresh PR would duplicate the
	// existing one, so self-skip here and record the reason for traceability.
	if (input.run.trigger === CI_FIXER_TRIGGER) {
		await input.emit("reap.pr_open_skipped", { reason: "ci_fixer_run", branch: input.branch });
		return null;
	}
	// warren-8cbf: a run whose ref IS its push branch (the repair-run
	// pattern — targetBranch pins the workspace branch to the ref) must
	// never open a head==base PR now that the ref resolves as the base.
	const baseBranch = resolvePrBase(input);
	if (input.branch === baseBranch) {
		await input.emit("reap.pr_open_skipped", { reason: "branch_is_base", branch: input.branch });
		return null;
	}
	try {
		const cloneFetch = await resolveCloneFetchConfig(input);
		const prContext = await gatherPrContext({
			workspacePath: input.workspacePath,
			projectPath: input.project.localPath,
			baseBranch,
			prompt: input.run.prompt,
			seedId: input.run.seedId ?? null,
			exec: input.exec,
			emit: input.emit,
			projectId: input.project.id,
			issueTracker: input.issueTracker,
			...(cloneFetch !== undefined ? { cloneFetch } : {}),
		});
		const prArgs: TryOpenPrInput = {
			project: input.project,
			branch: input.branch,
			baseBranch,
			autoOpen: input.autoOpen,
			forge: input.forge,
			run: input.run,
			prContext,
			previewOptedIn: input.previewOptedIn,
			...(input.prTemplate !== undefined ? { prTemplate: input.prTemplate } : {}),
		};
		const sleep = input.sleep ?? defaultSleep;
		let opened = await tryOpenPr(prArgs);
		for (let attempt = 0; attempt < PR_OPEN_RETRY_DELAYS_MS.length; attempt++) {
			if (opened.ok || !isRetryablePrErrorKind(opened.kind)) break;
			await sleep(PR_OPEN_RETRY_DELAYS_MS[attempt] ?? 1_000);
			opened = await tryOpenPr(prArgs);
		}
		if (opened.ok) {
			await input.setPrUrl(input.run.id, opened.pr.url);
			await input.emit("reap.pr_opened", {
				prUrl: opened.pr.url,
				mode: opened.pr.mode,
				branch: input.branch,
				baseBranch: input.baseBranch,
			});
			return opened.pr;
		}
		await input.fail("pr_open", new Error(`${opened.kind}: ${opened.detail}`));
		return null;
	} catch (err) {
		await input.fail("pr_open", err);
		return null;
	}
}
