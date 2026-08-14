/**
 * The context-waste-proxy callout (warren-6d41), split out of
 * `./insights.ts` under the file-size budget once the per-directory
 * difficulty (warren-8f1b) and context-waste callouts both landed.
 */

import type { ContextWasteProxy } from "./context-waste.ts";
import type { Insight } from "./insights.ts";

/** Minimum measured runs (rollup rows AND known context tokens) before a
 * byte share is worth flagging — below that the proxy is noise. */
const MIN_CONTEXT_WASTE_RUNS_MEASURED = 3;
/** Byte-share thresholds for the context-waste-proxy callout. */
const CONTEXT_WASTE_WARNING_SHARE = 0.5;
const CONTEXT_WASTE_CRITICAL_SHARE = 0.75;

function pct(rate: number): string {
	return `${Math.round(rate * 100)}%`;
}

/**
 * Context-waste proxy (warren-6d41): the tool whose tool_result bytes
 * dominate run context tokens. Fires only over a measured cohort of at
 * least {@link MIN_CONTEXT_WASTE_RUNS_MEASURED} runs — runs predating the
 * rollup or lacking token data are unknown and never ground the share.
 * The detail names the limitation outright: this is the cheap byte-size
 * proxy, not per-turn usage deltas (design record §10 q4, v0 answer).
 */
export function contextWasteProxy(waste: ContextWasteProxy): Insight | null {
	if (waste.runsMeasured < MIN_CONTEXT_WASTE_RUNS_MEASURED) return null;
	const top = waste.byTool.find((t) => t.share !== null);
	if (top === undefined || top.share === null) return null;
	if (top.share < CONTEXT_WASTE_WARNING_SHARE) return null;
	return {
		kind: "context-waste-proxy",
		severity: top.share >= CONTEXT_WASTE_CRITICAL_SHARE ? "critical" : "warning",
		title: "Context dominated by tool output",
		detail:
			`Tool "${top.key}" returned ${top.resultBytesTotal} byte(s) across ${top.runsMeasured} measured run(s) ` +
			`holding ${top.contextTokensTotal} context token(s) — a ${pct(top.share)} byte-share proxy of ` +
			`context use. Byte size against run-level token totals is a ranking proxy, not per-turn ` +
			`usage deltas.`,
		value: top.share,
		subject: top.key,
		denominator: top.runsMeasured,
		confidence: waste.confidence,
	};
}
