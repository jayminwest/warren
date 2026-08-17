/**
 * The runtime-id wire vocabulary (warren-c4be, warren-c80e phase 1 item 4).
 *
 * Split out of `./wire.ts` for the same reason as the actor, inbox and
 * insight modules: the home sits at its file-size budget, and this seam
 * needed one more name. `wire.ts` re-exports the whole module, so the
 * canonical import path stays `src/core/wire.ts` and `check:wire-types`
 * still derives these names (it follows `export *` chains, warren-3754).
 */

/**
 * The burrow/pod runtime ids warren can dispatch an agent onto
 * (warren-c4be). Canonical here because two independent surfaces need the
 * same vocabulary: the per-project `.warren/config.yaml` runtime override
 * (`src/warren-config/schema.ts`, which zod-enforces it) and the agent
 * registry (`src/registry/schema.ts`, which resolves an agent's
 * `frontmatter.runtime` at registration and at dispatch).
 *
 * Before this lived here, only the config half validated. An agent row
 * carrying an unknown runtime id sailed through registration and died
 * sandbox-side at dispatch, past every 4xx boundary: the warren-ebca
 * incident class (the planner agent pinned no runtime, burrow looked up
 * "planner" in its built-in runtime table, and the run died before agent
 * boot). Validating the id where agents enter the system turns that into a
 * typed 422 that names the known ids.
 */
export const KNOWN_RUNTIME_IDS = ["claude-code", "pi"] as const;
export type RuntimeId = (typeof KNOWN_RUNTIME_IDS)[number];

/** Membership predicate for {@link KNOWN_RUNTIME_IDS}. */
export function isKnownRuntimeId(value: unknown): value is RuntimeId {
	return typeof value === "string" && (KNOWN_RUNTIME_IDS as readonly string[]).includes(value);
}

/**
 * A runtime id that has passed validation: either a {@link KNOWN_RUNTIME_IDS}
 * member or an operator-declared extension from `WARREN_EXTRA_RUNTIME_IDS`
 * (`src/registry/schema.ts`). Widens to `string` because the extension list
 * is only known at run time.
 *
 * The widening is why this alias exists instead of `RuntimeId` at the
 * dispatch seam: `RunSpec.runtimeId` and the two k8s entrypoints must still
 * carry `stub-shell` and whatever else an operator declares. What the alias
 * buys is a name the reader can follow back to this file, and a target for
 * `check:runtime-ids`, which is where the actual enforcement lives: the
 * literals themselves may not be written outside the adapter registry.
 */
export type AcceptedRuntimeId = RuntimeId | string;
