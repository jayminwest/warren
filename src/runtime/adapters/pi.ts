/**
 * The `pi` adapter (warren-c80e phase 1).
 */

import type { AgentRuntimeAdapter } from "./types.ts";

export const piAdapter: AgentRuntimeAdapter = {
	runtimeId: "pi",
	/**
	 * `.pi/sessions/` only, NOT `.pi/`.
	 *
	 * The parent directory is shared between two different kinds of writer.
	 * `.pi/skills/<name>/SKILL.md` and `.pi/prompts/<name>.md` are
	 * materialized by warren from the agent definition's `pi_skills` /
	 * `pi_prompts` (see docs/design/agent-composition.md), so they are
	 * composition output rather than harness scratch, and treating them as
	 * ignorable would weaken the dropped-commit guard against warren's own
	 * writes. `.pi/sessions/` is the harness's own transcript: the 0.9.x
	 * changelog records removing "a stray `.pi/sessions` agent transcript
	 * committed by PR #340" (warren-4c8d), which is exactly the
	 * harness-wrote-it-and-nobody-staged-it shape this list is for.
	 */
	harnessStatePrefixes: [".pi/sessions/"],
	/**
	 * pi attaches the terminal error signal to either the per-turn
	 * (`turn_end`) or the run-terminal (`agent_end`) envelope depending on
	 * which provider error path fired, so both are read (warren-edc3,
	 * warren-e281). This pair is the set `classifyEnvelope` hardcoded before
	 * the seam existed, moved verbatim.
	 */
	terminalErrorEnvelopeTypes: ["turn_end", "agent_end"],
};
