/**
 * Built-in `pi` agent definition.
 *
 * Pi (`@earendil-works/pi-coding-agent`) is a coding-agent runtime
 * warren ships out of the box, alongside `claude-code`. Including it
 * as a built-in lets a fresh warren install dispatch a multi-provider
 * run without standing up a canopy library first.
 *
 * The pi-specific surfaces (multi-provider override, cost reporting,
 * `.pi/skills/` and `.pi/prompts/` materialization) layer on top in
 * follow-on steps of pl-4374; this file is the minimal parity shape.
 *
 * Operators with a custom canopy library override this by registering a
 * same-named library agent — refresh upserts on top.
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
- Use git as you normally would. Commit your changes; warren reaps the branch and pushes upstream.
- Committing is mandatory, not the same as staging. \`git add\` ALONE IS NOT ENOUGH — you must run \`git commit\` so the work lands as a real commit. A run that ends with staged-but-uncommitted changes is treated as a FAILURE (\`dropped_commit\`), not a success. Before you report completion, run \`git status\`/\`git log\` and confirm your changes are in a commit, not just staged. The only exception is when you have genuinely made no file changes at all.
- Do not run \`git push\` yourself — warren handles the push host-side after the run terminates.
`;

export const PI_BUILTIN: AgentDefinition = {
	name: "pi",
	version: 1,
	sections: {
		system: SYSTEM_BODY,
		burrow_config: '[sandbox]\nnetwork = "open"\n',
	},
	// warren-cb46: tracker/mulch text as capability-gated fragments — a
	// project with no .seeds/ / .mulch/ gets no false tooling assertions.
	gatedPrompts: { tracker: TRACKER_FRAGMENT, mulch: MULCH_FRAGMENT },
	resolvedFrom: ["builtin:pi"],
	frontmatter: {
		source: "builtin",
		tags: ["agent"],
		// pi is the default runtime (warren-16f8); declared explicitly
		// here for parity with the other harness built-ins even though
		// readRuntimeId would fall back to it anyway.
		runtime: "pi",
		// warren-3305: this harness consumes steering only at spawn
		// (encodeInboxMessage folds pending inbox rows into the prompt);
		// no builtin runtime reads steering mid-run, so a steer against
		// a running run must fail 409 rather than record a dead
		// steer.sent. Flip to "mid-run" only when the runtime gains a
		// proven live steering channel.
		steering: "spawn-only",
		// Sonnet tier (model-tiers.ts): pi is the plan-run child executor
		// — the bulk of run volume, running well-decomposed steps where
		// Sonnet matches Opus at lower cost.
		...MODEL_TIERS.sonnet,
	},
};
