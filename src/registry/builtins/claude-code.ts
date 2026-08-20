/**
 * Built-in `claude-code` agent definition.
 *
 * A fresh warren install can dispatch a run against this agent with no
 * external tooling. `parseRenderedAgent` round-trips the shape through
 * warren's schema validation in the test suite.
 *
 * Warren re-seeds the built-ins into the agents registry on every server
 * boot. The external canopy agent library was removed in the deletion
 * pass (pl-3a79), so no library-refresh path remains — the built-in is
 * the whole registry entry.
 */

import type { AgentDefinition } from "../schema.ts";
import { MODEL_TIERS } from "./model-tiers.ts";
import {
	BASE_WORKSPACE_BULLETS,
	MULCH_FRAGMENT,
	QUALITY_GATE_CHAIN,
	TRACKER_FRAGMENT,
} from "./prompt-fragments.ts";

const SYSTEM_BODY = `You are a helpful coding assistant. Be concise.

Workspace map:
${BASE_WORKSPACE_BULLETS}

Operating contract:
- Edit files in place. Run tests when relevant.
- Quality gates are terminal, not advisory. You are NOT done until the gate exits zero. Resolve the command in this order: ${QUALITY_GATE_CHAIN}. Run it before committing and again before reporting completion. Do not declare the task complete, hand off, or end the session with a red gate — fix failures (including lint warnings, which CI treats as errors) until it is green. If the gate is genuinely unfixable in this run, say so explicitly and leave the work open rather than claiming success.
- Use git as you normally would. Commit your changes; warren reaps the branch and pushes upstream. Committing is mandatory, and staging is not committing. \`git add\` on its own leaves the work uncommitted, and reap classifies a run that ends with uncommitted changes as a FAILURE (\`dropped_commit\`) even when the agent otherwise succeeded — the workspace is then destroyed and the work is lost. Before you report completion, run \`git status\` and \`git log\` and confirm your edits are in a commit. The only exception is a run that genuinely changed no files.
- Do not run \`git push\` yourself — warren handles the push host-side after the run terminates.
`;

export const CLAUDE_CODE_BUILTIN: AgentDefinition = {
	name: "claude-code",
	version: 1,
	sections: {
		system: SYSTEM_BODY,
		burrow_config: '[sandbox]\nnetwork = "open"\n',
	},
	// warren-cb46: tracker/mulch text as capability-gated fragments — a
	// project with no .seeds/ / .mulch/ gets no false tooling assertions.
	gatedPrompts: { tracker: TRACKER_FRAGMENT, mulch: MULCH_FRAGMENT },
	resolvedFrom: ["builtin:claude-code"],
	frontmatter: {
		source: "builtin",
		tags: ["agent"],
		// claude-code is opt-in since the default runtime flipped to pi
		// (warren-16f8); pin it explicitly so this built-in keeps
		// dispatching onto the claude-code burrow runtime.
		runtime: "claude-code",
		// warren-3305: this harness consumes steering only at spawn
		// (encodeInboxMessage folds pending inbox rows into the prompt);
		// no builtin runtime reads steering mid-run, so a steer against
		// a running run must fail 409 rather than record a dead
		// steer.sent. Flip to "mid-run" only when the runtime gains a
		// proven live steering channel.
		steering: "spawn-only",
		// Sonnet tier (model-tiers.ts): decomposed/scoped coding work;
		// operators raise to Opus per-run when a raw prompt needs it.
		...MODEL_TIERS.sonnet,
	},
};
