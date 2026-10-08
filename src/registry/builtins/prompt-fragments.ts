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

/**
 * When the quality gate must run, and when it must not run again
 * (warren-7e82). Replaces the old "run it before committing and again
 * before reporting completion" wording, which made agents re-run the
 * complete gate on unchanged inputs. One green run on the final inputs
 * is still mandatory. The red-gate rule lives beside it in each
 * operating contract and is unchanged.
 */
export const GATE_FINAL_RUN_RULE =
	"Run the complete gate on your final inputs before your final commit. One green run on those inputs is the completion evidence: committing or reporting completion does not by itself require another run. Rerun it only when relevant inputs changed since the last green run, to confirm the fix for a diagnosed failure, or as a bounded flake experiment you name as one.";

/**
 * Validation-discipline bullets shared by every source-editing builtin
 * (warren-7e82). Each line targets a measured waste pattern: unchanged
 * full-suite reruns to change a tail/grep filter, pipelines that hid the
 * test exit status, tests run before UI/extension dependencies were
 * installed, bare test-runner calls that bypassed configured timeouts,
 * and slow gates that kept running after a cheap static check failed.
 */
export const VALIDATION_DISCIPLINE_BULLETS = `- Validation discipline. Broad test runs are the most expensive thing you do, so never repeat one on unchanged inputs:
  - Prepare dependencies once, before the first test run: the project's install/bootstrap steps, including nested packages (UI, extensions) its tests or gate exercise.
  - Use the project's configured test entry points (package scripts, Makefile targets), which carry its timeouts and flags, rather than a bare test-runner call.
  - While iterating, run focused tests for the code you touched plus the relevant cheap static checks, not the full suite.
  - Prefer the gate's fail-fast mode when it has one (a \`--bail\` or stop-on-first-failure flag), so a cheap static failure does not wait behind a slow test or coverage step. After a failure, iterate on the failing gate or focused tests, then finish with the complete gate.
  - Capture each broad run's full output and true exit status once, for example \`<cmd> > /tmp/gate.log 2>&1; echo "exit=$?"\` (use \`set -o pipefail\` if you pipe through \`tee\`). Then search the saved log. Never re-run an unchanged command just to apply a different tail/grep filter, and never pipe a test command into tail/grep without pipefail, because the pipe hides its exit status.
  - Do not bypass project git hooks (\`--no-verify\`) to save time.`;

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
