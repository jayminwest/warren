/**
 * Stream-bridge side of the `tool_calls` rollup (warren-7746 / pl-103e
 * step 9). Split out of `bridge.ts` to keep the pump under the file-size
 * budget; the two call sites there are one-liners over these helpers.
 *
 * Both writers are best-effort by design: a rollup failure must never
 * interrupt the stream pump, because the boot-time backfill
 * (`src/runs/tool-calls-backfill.ts`) re-extracts the run's tool history
 * from `events` later. The events transcript stays the source of truth;
 * the rollup is a derived, rebuildable projection of it.
 */

import type { RuntimeId } from "../../core/wire.ts";
import type { Repos } from "../../db/repos/index.ts";
import type { EventRow } from "../../db/schema.ts";
import {
	extractToolResult,
	extractToolUse,
	runtimeFromRenderedAgent,
} from "../analytics/tool-call-extract.ts";
import type { BridgeLogger } from "./types.ts";

/**
 * Resolve the run's runtime id from its frozen
 * `runs.rendered_agent_json`. Best-effort: a missing row or read error
 * resolves to `null` (rollup rows land unextracted — the backfill
 * re-extracts them once the row is readable), so a DB hiccup never
 * blocks streaming.
 */
export async function resolveBridgeToolRuntime(
	repos: Repos,
	runId: string,
	logger: BridgeLogger | undefined,
): Promise<RuntimeId | null> {
	try {
		const run = await repos.runs.require(runId);
		return runtimeFromRenderedAgent(run.renderedAgentJson);
	} catch (err) {
		logger?.warn?.(
			{ runId, err: err instanceof Error ? err.message : String(err) },
			"failed to resolve runtime; tool-calls rollup rows will land unextracted",
		);
		return null;
	}
}

/**
 * Fold one persisted event into the `tool_calls` rollup. `tool_use`
 * inserts a structured row; `tool_result` joins `is_error` /
 * `result_bytes` back onto it by (run_id, tool_use_id). Other kinds are
 * ignored. Never throws: failures are logged and dropped.
 */
export async function recordToolCallRollup(
	repos: Repos,
	runId: string,
	row: EventRow,
	runtime: RuntimeId | null,
	logger: BridgeLogger | undefined,
): Promise<void> {
	if (row.kind !== "tool_use" && row.kind !== "tool_result") return;
	try {
		if (row.kind === "tool_use") {
			const extraction = extractToolUse(runtime, row.payloadJson);
			await repos.toolCalls.recordUse({
				runId,
				seq: row.sandboxEventSeq,
				ts: row.ts,
				toolName: extraction.toolName,
				command: extraction.command,
				filePaths: extraction.filePaths,
				toolUseId: extraction.toolUseId,
				origin: row.origin,
			});
		} else {
			const extraction = extractToolResult(runtime, row.payloadJson);
			if (extraction !== null) {
				await repos.toolCalls.recordResult({
					runId,
					toolUseId: extraction.toolUseId,
					isError: extraction.isError,
					resultBytes: extraction.resultBytes,
				});
			}
		}
	} catch (err) {
		logger?.warn?.(
			{ runId, seq: row.sandboxEventSeq, err: err instanceof Error ? err.message : String(err) },
			"failed to record tool-calls rollup row",
		);
	}
}
