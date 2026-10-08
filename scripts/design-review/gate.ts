#!/usr/bin/env bun
/**
 * Put a `design-review` check on every PR head the moment it is pushed
 * (warren-a694). The review itself waits for ui-visual, and ui-visual's
 * path filter means it never runs on most PRs. Without this step a required
 * `design-review` check would hang forever on a PR that never touched the
 * UI (warren-dbef makes it required).
 *
 *   - No change under `src/ui/` that renders: the check passes now with
 *     "Skipped: no src/ui changes".
 *   - A rendered UI change: the check is queued ("Waiting for ui-visual")
 *     unless a review already set it. The review job completes it.
 *
 * The `gate` job runs this on `pull_request_target`, from the default
 * branch's code, without checking out the PR. Its only inputs are the PR
 * number and head sha from the event, and the file list from the API.
 * Env: `GH_REPO`, `PR`, `HEAD_SHA`, `GH_TOKEN`.
 */

import { type GhApi, ghCliApi } from "../ui-visual/gh-api.ts";
import { listPrFiles, setCheck } from "./github.ts";
import { checkFor, type Outcome } from "./outcome.ts";
import { scopeForFiles, touchesUi } from "./scope.ts";

/** What the gate sets, from the PR's file list. */
export function gateOutcome(files: readonly string[], complete: boolean): Outcome {
	if (!complete) return { kind: "waiting" };
	if (!touchesUi(files)) return { kind: "skipped", reason: "no-ui-changes" };
	if (scopeForFiles(files).pages.length === 0) {
		return { kind: "skipped", reason: "no-rendered-changes" };
	}
	return { kind: "waiting" };
}

export async function runGate(
	api: GhApi,
	repo: string,
	pr: number,
	headSha: string,
): Promise<string> {
	const { files, complete } = await listPrFiles(api, repo, pr);
	const outcome = gateOutcome(
		files.map((f) => f.filename),
		complete,
	);
	const result = await setCheck(api, repo, headSha, checkFor(outcome, null), {
		onlyIfAbsent: outcome.kind === "waiting",
	});
	return `${outcome.kind}:${result}`;
}

async function main(): Promise<void> {
	const repo = process.env.GH_REPO ?? "";
	const pr = Number(process.env.PR ?? "");
	const headSha = process.env.HEAD_SHA ?? "";
	if (!/^[\w.-]+\/[\w.-]+$/.test(repo) || !Number.isInteger(pr) || pr <= 0) {
		throw new Error("GH_REPO (owner/repo) and PR (a number) are required");
	}
	if (!/^[0-9a-f]{40}$/.test(headSha)) throw new Error("HEAD_SHA must be a full commit sha");
	console.log(`design-review gate: ${await runGate(ghCliApi(), repo, pr, headSha)}`);
}

if (import.meta.main) await main();
