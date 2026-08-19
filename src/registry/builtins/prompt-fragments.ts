/**
 * Shared prompt-fragment text for the built-in agents (warren-cb46,
 * plan pl-a37b).
 *
 * Builtin prompts must not assert tooling a project does not have. The
 * tracker-workflow and expertise paragraphs live in each definition's
 * `gatedPrompts` (assembled at dispatch against the project's real
 * capabilities — `src/registry/prompt-gating.ts`); the quality-gate chain
 * below is shared, always-present, and deliberately stack-neutral: it
 * never assumes `bun run check:all` on an unknown repo.
 */

/**
 * The neutral quality-gate resolution chain (warren-cb46):
 * `$WARREN_QUALITY_GATE` → CLAUDE.md / AGENTS.md → discover the project's
 * own test and lint commands.
 */
export const QUALITY_GATE_CHAIN =
	"`$WARREN_QUALITY_GATE` if set, otherwise the command documented in CLAUDE.md / AGENTS.md, otherwise discover the project's own test and lint commands (package.json scripts, Makefile targets, CI config) and run those";

/** Harness-agent mulch fragment: expertise load ritual + workspace path. */
export const MULCH_FRAGMENT = `## Project expertise (mulch)

- /workspace/.mulch/expertise/<domain>.jsonl holds the project's expertise records.
- Run \`ml prime\` at the start of the session to load them, and record insights worth preserving with \`ml record\` before finishing.`;

/** Harness-agent tracker fragment: the project's issue queue + sd CLI. */
export const TRACKER_FRAGMENT = `## Project issue queue (seeds)

- /workspace/.seeds/issues.jsonl holds the project's issue queue.
- The \`sd\` CLI manages it (\`sd ready\`, \`sd create\`, \`sd close\`, \`sd sync\`); see AGENTS.md for the workflow.`;

/** Workspace-map bullets shared by every harness builtin (ungated). */
export const BASE_WORKSPACE_BULLETS = `- The project repo is mounted at the burrow workspace root.
- /workspace/.warren/agent.json is the rendered agent definition (warren seeded it).`;
