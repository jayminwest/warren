// Relative imports only: the repo-root `bun test` resolves no `@/` alias.
import type { RunRow } from "../api/types.ts";

/**
 * One readable title per run (warren-44a2), shared by Home, the command
 * palette, and any list that shows runs by what they do.
 */

const ISSUE_PROMPT = /^Work (?:GitHub )?issue (#?[\w-]+) in [\w.-]+\/[\w.-]+: "?(.+?)"?$/;

/**
 * A readable run title from the prompt's first line. The tracker trigger's
 * "Work GitHub issue #12 in owner/repo: \"title\"" shape collapses to
 * "#12 title"; any other prompt passes through.
 */
export function promptTitle(line: string): string {
	const m = ISSUE_PROMPT.exec(line);
	return m ? `${m[1]} ${m[2]}` : line;
}

/** First prompt line, as a title; the seed id or agent when the prompt is empty. */
export function runTitle(run: Pick<RunRow, "prompt" | "seedId" | "agentName">): string {
	const line = run.prompt.trim().split("\n", 1)[0] ?? "";
	return promptTitle(line) || run.seedId || run.agentName;
}
