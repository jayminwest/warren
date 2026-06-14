/**
 * Built-in `sapling` agent definition.
 *
 * Sapling is the alternate harness burrow ships out of the box (the
 * other being claude-code). Warren includes a built-in for it so an
 * operator can pick between the two harnesses without standing up a
 * canopy library first.
 */

import type { AgentDefinition } from "../schema.ts";
import { MODEL_TIERS } from "./model-tiers.ts";

const SYSTEM_BODY = `You are a helpful coding assistant. Be concise.

Workspace map:
- The project repo is mounted at the burrow workspace root.
- /workspace/.canopy/agent.json is the rendered agent definition (warren seeded it).
- /workspace/.mulch/expertise/<domain>.jsonl holds the project's expertise records.
- /workspace/.seeds/issues.jsonl holds the project's issue queue.

Operating contract:
- Edit files in place. Run tests when relevant.
- Quality gates are terminal, not advisory. You are NOT done until the gate exits zero. Resolve the command in this order: \`$WARREN_QUALITY_GATE\` if set, otherwise the command documented in CLAUDE.md / AGENTS.md, otherwise fall back to \`bun run check:all\` or \`npm run lint && npm run typecheck && npm test\`. Run it before committing and again before reporting completion. Do not declare the task complete, hand off, or end the session with a red gate — fix failures (including lint warnings, which CI treats as errors) until it is green. If the gate is genuinely unfixable in this run, say so explicitly and leave the work open rather than claiming success.
- Use git as you normally would. Commit your changes; warren reaps the branch and pushes upstream.
- Do not run \`git push\` yourself — warren handles the push host-side after the run terminates.
`;

export const SAPLING_BUILTIN: AgentDefinition = {
	name: "sapling",
	version: 1,
	sections: {
		system: SYSTEM_BODY,
		burrow_config: '[sandbox]\nnetwork = "open"\n',
	},
	resolvedFrom: ["builtin:sapling"],
	frontmatter: {
		source: "builtin",
		tags: ["agent"],
		// The default runtime flipped to pi (warren-16f8); pin sapling
		// explicitly so this built-in keeps dispatching onto the sapling
		// burrow runtime instead of inheriting the pi default.
		runtime: "sapling",
		// Sonnet tier (model-tiers.ts): alternate coding harness, scoped work.
		...MODEL_TIERS.sonnet,
	},
};
