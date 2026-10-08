/**
 * GitHub reads and writes for the design-review workflow (warren-a694).
 *
 * Everything goes through the `GhApi` seam from the ui-visual comment
 * workflow, so tests pass a fake and no REST host literal lives here.
 */

import type { GhApi } from "../ui-visual/gh-api.ts";
import { CHECK_NAME, type CheckState } from "./outcome.ts";

export interface PrFile {
	readonly filename: string;
	readonly status: string;
	/** Absent when GitHub omits it (binary or too large). */
	readonly patch?: string;
}

export interface PrFiles {
	readonly files: readonly PrFile[];
	/** False when the list is shorter than the PR's `changed_files` (GitHub caps it at 3000). */
	readonly complete: boolean;
}

/**
 * The PR's changed files. The REST field is `filename` (warren-7b2f: a
 * `path` read returned one empty string per file and opened a gate).
 */
export async function listPrFiles(api: GhApi, repo: string, pr: number): Promise<PrFiles> {
	const pull = (await api.request("GET", `repos/${repo}/pulls/${pr}`)) as {
		changed_files?: unknown;
	};
	const raw = await api.paginate(`repos/${repo}/pulls/${pr}/files?per_page=100`);
	const files = (raw as { filename?: unknown; status?: unknown; patch?: unknown }[]).flatMap((f) =>
		typeof f.filename === "string" && f.filename !== ""
			? [
					{
						filename: f.filename,
						status: typeof f.status === "string" ? f.status : "modified",
						...(typeof f.patch === "string" ? { patch: f.patch } : {}),
					},
				]
			: [],
	);
	const expected = typeof pull.changed_files === "number" ? pull.changed_files : files.length;
	return { files, complete: files.length >= expected };
}

interface RawCheckRun {
	id?: unknown;
	status?: unknown;
}

/** The newest `design-review` check run on a commit, if any. */
export async function findCheckRun(
	api: GhApi,
	repo: string,
	sha: string,
): Promise<{ id: number; status: string } | null> {
	const res = (await api.request(
		"GET",
		`repos/${repo}/commits/${sha}/check-runs?check_name=${CHECK_NAME}&filter=latest`,
	)) as { check_runs?: RawCheckRun[] } | null;
	const run = (res?.check_runs ?? []).find((r) => typeof r.id === "number");
	if (run === undefined) return null;
	return { id: run.id as number, status: typeof run.status === "string" ? run.status : "" };
}

/** Check-run summaries are capped at 65535 characters. */
const MAX_SUMMARY = 60_000;

/**
 * Set the `design-review` check on a commit: edit the newest one in place
 * while it is open, or create one. `onlyIfAbsent` leaves an existing check alone (the gate's
 * "waiting" state must never overwrite a finished review).
 */
export async function setCheck(
	api: GhApi,
	repo: string,
	sha: string,
	state: CheckState,
	opts: { detailsUrl?: string; onlyIfAbsent?: boolean } = {},
): Promise<"created" | "updated" | "kept"> {
	const existing = await findCheckRun(api, repo, sha);
	if (existing !== null && opts.onlyIfAbsent === true) return "kept";
	const body: Record<string, unknown> = {
		status: state.status,
		output: { title: state.title, summary: state.summary.slice(0, MAX_SUMMARY) || state.title },
		...(state.status === "completed" ? { conclusion: state.conclusion } : {}),
		...(opts.detailsUrl === undefined ? {} : { details_url: opts.detailsUrl }),
	};
	// A finished check is never reopened: a re-run adds a new one, and the
	// newest check run of a name is the one branch protection reads.
	if (existing !== null && existing.status !== "completed") {
		await api.request("PATCH", `repos/${repo}/check-runs/${existing.id}`, body);
		return "updated";
	}
	await api.request("POST", `repos/${repo}/check-runs`, {
		name: CHECK_NAME,
		head_sha: sha,
		...body,
	});
	return "created";
}
