/**
 * The `claude-code` adapter (warren-c80e phase 1).
 */

import type { AgentRuntimeAdapter } from "./types.ts";

export const claudeCodeAdapter: AgentRuntimeAdapter = {
	runtimeId: "claude-code",
	/**
	 * The harness drops `.claude/settings.local.json` into the workspace at
	 * runtime. This is the prefix `HARNESS_STATE_PREFIXES` carried before the
	 * seam existed, moved verbatim (warren-f6f2).
	 */
	harnessStatePrefixes: [".claude/"],
	/**
	 * Empty by evidence, not by omission. The provider-error net (warren-edc3)
	 * was written against pi's turn lifecycle, and warren has never observed
	 * a claude-code envelope carrying `stopReason`. The generic classifier
	 * still reads the union of every adapter's types, so this declaration
	 * does not narrow what a claude-code run is checked against today; see
	 * `providerErrorEnvelopeTypes` in `./index.ts`.
	 */
	terminalErrorEnvelopeTypes: [],
};
