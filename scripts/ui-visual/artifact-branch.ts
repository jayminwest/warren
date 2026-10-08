/**
 * Host the ui-visual diff crops on an orphan branch (warren-70d9).
 *
 * A PR comment can only show an image it can link to. Workflow artifacts
 * are zip files behind a login, so the crops go to the `ui-visual-artifacts`
 * branch of this repo through the Git Data API, and the comment links their
 * `raw.githubusercontent.com` URLs by branch name. Nothing is checked out and
 * no git binary runs; the branch shares no history with main.
 *
 * Retention: every write rebuilds the tree from the files dated within the
 * last 30 days (paths start with `YYYY-MM-DD/`) plus the new ones. Commits
 * chain onto the previous head (a fast-forward, so two concurrent writers
 * cannot drop each other's files: the loser gets a 422 and retries). The
 * chain is cut once its epoch, stamped in the commit message, is over 30
 * days old: that write starts a fresh orphan commit and force-moves the
 * branch, so blobs older than the window become unreachable and a clone of
 * the repo never carries more than about a month of crops.
 */

import { type GhApi, isHttpStatus } from "./gh-api.ts";

export const ARTIFACT_BRANCH = "ui-visual-artifacts";
export const RETENTION_DAYS = 30;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface TreeEntry {
	readonly path: string;
	readonly sha: string;
}

export interface ArtifactFile {
	readonly path: string;
	readonly bytes: Uint8Array;
}

export interface BranchHead {
	readonly sha: string;
	readonly message: string;
	readonly entries: readonly TreeEntry[];
}

/** `2026-10-08`, in UTC. */
export function dayOf(date: Date): string {
	return date.toISOString().slice(0, 10);
}

function cutoffDay(now: Date): string {
	return dayOf(new Date(now.getTime() - RETENTION_DAYS * DAY_MS));
}

/** Where a crop lives on the branch: `<day>/pr-<n>/<sha12>/<case>.png`. */
export function artifactPath(now: Date, pr: number, headSha: string, name: string): string {
	return `${dayOf(now)}/pr-${pr}/${headSha.slice(0, 12)}/${name}.png`;
}

/** The URL a PR comment embeds for a file on the branch. */
export function rawUrl(repo: string, path: string, branch = ARTIFACT_BRANCH): string {
	return `https://raw.githubusercontent.com/${repo}/${branch}/${path}`;
}

const DATED = /^(\d{4}-\d{2}-\d{2})\//;

/** Entries still inside the retention window. Undated paths are dropped. */
export function keptEntries(entries: readonly TreeEntry[], now: Date): TreeEntry[] {
	const cutoff = cutoffDay(now);
	return entries.filter((e) => {
		const day = DATED.exec(e.path)?.[1];
		return day !== undefined && day >= cutoff;
	});
}

export interface CommitPlan {
	readonly parents: string[];
	readonly epoch: string;
	/** Move the branch even though the new commit does not descend from it. */
	readonly force: boolean;
	readonly message: string;
}

/** Chain onto the head while its epoch is in the window, else start over. */
export function planCommit(head: { sha: string; message: string } | null, now: Date): CommitPlan {
	const epoch = /epoch (\d{4}-\d{2}-\d{2})/.exec(head?.message ?? "")?.[1];
	if (head !== null && epoch !== undefined && epoch >= cutoffDay(now)) {
		return { parents: [head.sha], epoch, force: false, message: commitMessage(epoch) };
	}
	const today = dayOf(now);
	return { parents: [], epoch: today, force: head !== null, message: commitMessage(today) };
}

function commitMessage(epoch: string): string {
	return `ui-visual diff crops (epoch ${epoch})\n\nWritten by .github/workflows/ui-visual-comment.yml (warren-70d9).`;
}

const README = `# ui-visual-artifacts

Diff crops for the ui-visual PR comment, written by
\`.github/workflows/ui-visual-comment.yml\` (warren-70d9). Files older than
${RETENTION_DAYS} days are pruned. Never merge this branch.
`;

async function readHead(api: GhApi, repo: string, branch: string): Promise<BranchHead | null> {
	let ref: { object?: { sha?: string } } | null;
	try {
		ref = (await api.request("GET", `repos/${repo}/git/ref/heads/${branch}`)) as typeof ref;
	} catch (error) {
		if (isHttpStatus(error, 404)) return null;
		throw error;
	}
	const sha = ref?.object?.sha ?? "";
	const commit = (await api.request("GET", `repos/${repo}/git/commits/${sha}`)) as {
		message?: string;
		tree?: { sha?: string };
	};
	const tree = (await api.request(
		"GET",
		`repos/${repo}/git/trees/${commit.tree?.sha ?? ""}?recursive=1`,
	)) as { tree?: { path?: string; type?: string; sha?: string }[] };
	const entries = (tree.tree ?? []).flatMap((e) =>
		e.type === "blob" && e.path !== undefined && e.sha !== undefined
			? [{ path: e.path, sha: e.sha }]
			: [],
	);
	return { sha, message: commit.message ?? "", entries };
}

async function createBlob(api: GhApi, repo: string, bytes: Uint8Array): Promise<string> {
	const blob = (await api.request("POST", `repos/${repo}/git/blobs`, {
		content: Buffer.from(bytes).toString("base64"),
		encoding: "base64",
	})) as { sha?: string };
	if (blob.sha === undefined) throw new Error("blob create returned no sha");
	return blob.sha;
}

async function writeCommit(
	api: GhApi,
	repo: string,
	tree: readonly TreeEntry[],
	plan: CommitPlan,
): Promise<string> {
	const created = (await api.request("POST", `repos/${repo}/git/trees`, {
		tree: tree.map((e) => ({ path: e.path, mode: "100644", type: "blob", sha: e.sha })),
	})) as { sha?: string };
	const commit = (await api.request("POST", `repos/${repo}/git/commits`, {
		message: plan.message,
		tree: created.sha,
		parents: plan.parents,
	})) as { sha?: string };
	if (commit.sha === undefined) throw new Error("commit create returned no sha");
	return commit.sha;
}

async function moveBranch(
	api: GhApi,
	repo: string,
	branch: string,
	sha: string,
	plan: CommitPlan,
	exists: boolean,
): Promise<boolean> {
	try {
		if (exists) {
			await api.request("PATCH", `repos/${repo}/git/refs/heads/${branch}`, {
				sha,
				force: plan.force,
			});
		} else {
			await api.request("POST", `repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha });
		}
		return true;
	} catch (error) {
		// 422: another writer moved the branch first (not a fast-forward, or it already exists).
		if (isHttpStatus(error, 422)) return false;
		throw error;
	}
}

/**
 * Commit `files` to the artifact branch, pruning anything past retention.
 * Returns the raw URL of each file, in order. Retries a lost race.
 */
export async function publishFiles(
	api: GhApi,
	repo: string,
	files: readonly ArtifactFile[],
	now: Date,
	options: { branch?: string; attempts?: number } = {},
): Promise<string[]> {
	const branch = options.branch ?? ARTIFACT_BRANCH;
	const fresh: TreeEntry[] = [];
	for (const file of files)
		fresh.push({ path: file.path, sha: await createBlob(api, repo, file.bytes) });
	const readme = {
		path: "README.md",
		sha: await createBlob(api, repo, new TextEncoder().encode(README)),
	};
	const freshPaths = new Set(fresh.map((e) => e.path));
	for (let attempt = 1; attempt <= (options.attempts ?? 3); attempt++) {
		const head = await readHead(api, repo, branch);
		const kept = keptEntries(head?.entries ?? [], now).filter((e) => !freshPaths.has(e.path));
		const plan = planCommit(head, now);
		const sha = await writeCommit(api, repo, [readme, ...kept, ...fresh], plan);
		if (await moveBranch(api, repo, branch, sha, plan, head !== null)) {
			return files.map((f) => rawUrl(repo, f.path, branch));
		}
	}
	throw new Error(`could not update ${branch}: it kept moving under concurrent writers`);
}
