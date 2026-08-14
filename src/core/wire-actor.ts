/**
 * Actor vocabulary (warren-3754 / warren-b875), part of the canonical wire
 * home. Re-exported wholesale by `./wire.ts`, so the import path everyone
 * uses stays `src/core/wire.ts`. It lives in its own module for the same
 * reason the inbox and insight vocabularies do: the file-size ratchet on
 * `wire.ts` only goes down.
 *
 * These names cross the wire on `GET /whoami`, which returns
 * `{ identity, capabilities }` (`src/server/handlers/meta.ts`). The server,
 * the SDK (`src/client/types.ts`) and the UI (`src/ui/src/api/types.ts`)
 * re-export them. None of the three may redeclare one, and
 * `bun run check:wire-types` enforces that.
 */

/**
 * What a caller is permitted to do. The gate branches on these, it does not
 * re-derive them from who the caller is (warren-1ff0). Named for the
 * permission, not the holder: a flag says what the surface allows, so a
 * later provider can grant an arbitrary subset without anyone teaching
 * handlers a new identity vocabulary.
 *
 * `RuntimeCapabilities` (`src/runtime/contract.ts`) reads the same way by
 * design and is a different thing. It describes a sandbox, never crosses
 * the HTTP wire, and stays where it is.
 */
export interface ActorCapabilities {
	/** Read the public projection of runs / projects / agents. */
	readonly readPublic: boolean;
	/**
	 * Read operator-only surfaces: diagnostics, the run inbox, cost
	 * rollups, raw agent transcripts, per-project warren-config.
	 */
	readonly readOperator: boolean;
	/** Dispatch runs / plan-runs and steer, pause, cancel them. */
	readonly dispatch: boolean;
	/** Mutate instance-level state: register projects, triggers, config. */
	readonly admin: boolean;
}

/**
 * One capability name, and one arm of the `capabilities` array `GET /whoami`
 * returns. Derived from `ActorCapabilities` rather than re-listed, so a
 * capability added there is automatically a legal route policy and the two
 * vocabularies cannot drift.
 */
export type CapabilityName = keyof ActorCapabilities;

/**
 * Identity discriminant, reported verbatim as `identity` by `GET /whoami`.
 *
 * `operator` is the single-user V1 caller (SECURITY.md) the token provider
 * authorizes. `anonymous` is the credential-less spectator the
 * `WARREN_AUTH=public` provider mints (warren-851b), which holds
 * `readPublic` and nothing else. `run` is a sandbox calling back with its
 * per-run scoped token (warren-57fd): the request gate pins it to a single
 * run's callback surface, not its capability set. Further kinds land with
 * the providers that mint them.
 */
export type ActorKind = "operator" | "anonymous" | "run";
