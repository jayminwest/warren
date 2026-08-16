/**
 * The `sapling` adapter (warren-c80e phase 1).
 */

import type { AgentRuntimeAdapter } from "./types.ts";

export const saplingAdapter: AgentRuntimeAdapter = {
	runtimeId: "sapling",
	/**
	 * Empty, and this one is a genuine unknown rather than a decision.
	 *
	 * The issue asks that each runtime's prefixes be decided by reading what
	 * the harness actually writes. warren's own tree carries no evidence of
	 * a sapling state directory: no path literal, no changelog incident, and
	 * nothing in docs/design/agent-composition.md, which does describe the
	 * claude-code and pi cases. Empty preserves today's behavior exactly,
	 * since the flat constant this replaces listed only `.claude/`. If
	 * sapling does write scratch into the workspace, the cost of the hole is
	 * a false dropped-commit on a zero-commit run, and the fix is one line
	 * here.
	 */
	harnessStatePrefixes: [],
	/**
	 * Empty. sapling reports no usage envelope either (`src/core/usage-shape.ts`
	 * leaves it out, noted as the "sapling usageShape hole" in
	 * docs/design/agent-analytics.md), so there is no lifecycle envelope
	 * warren knows how to read a `stopReason` from.
	 */
	terminalErrorEnvelopeTypes: [],
};
