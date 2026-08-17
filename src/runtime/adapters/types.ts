/**
 * The `AgentRuntimeAdapter` seam (warren-c80e phase 1, GH #846).
 *
 * Warren dispatches runs to more than one agent harness. Logic that varies
 * by harness — what its state directory is called, which lifecycle envelope
 * carries its terminal error — was scattered across the domain as flat
 * constants and inline conditionals, so nothing stopped the next
 * runtime-conditional branch from landing anywhere. This is the one place a
 * per-runtime fact is declared.
 *
 * Two capabilities live here in phase 1, both moved from existing sites
 * rather than invented:
 *
 *   - `harnessStatePrefixes`, previously the flat
 *     `HARNESS_STATE_PREFIXES = [".claude/"]` in `src/runs/reap/util.ts`.
 *   - `terminalErrorEnvelopeTypes`, previously the hardcoded
 *     `turn_end` / `agent_end` pair inside `classifyEnvelope` in
 *     `src/runs/reap/provider-error.ts`.
 *
 * `src/core/usage-shape.ts` is the shape this follows: a record keyed off
 * {@link KNOWN_RUNTIME_IDS}, so adding a runtime id to the union forces a
 * declaration here rather than leaving a silent hole.
 *
 * Phase 2 (warren-7933, plan pl-3007) source-lifted burrow's harness
 * capabilities — `buildSpawnCommand`, the stdout parsers, the steering
 * encoders, and the `prepareWorkspace` / `extractMetadata` hooks — onto
 * this interface as optional methods, with the warren-side context types
 * below standing in for burrow's DB-row-shaped contexts. The k8s in-pod
 * dispatcher rewiring onto these hooks is warren-0efe.
 */

import type { EventStream, InboxPriority, RuntimeId } from "../../core/wire.ts";

/**
 * Everything warren's domain needs to know about one agent harness.
 *
 * A capability an adapter has nothing to contribute to declares an EMPTY
 * list, never `undefined`. The distinction matters: empty is a statement
 * that the harness writes no such thing, and the per-runtime doc comment
 * carries the evidence for that claim.
 */
export interface AgentRuntimeAdapter {
	/** The canonical id, matching the {@link KNOWN_RUNTIME_IDS} member. */
	readonly runtimeId: RuntimeId;
	/**
	 * Workspace-relative path prefixes this harness writes at runtime, which
	 * the agent never staged. Reap treats a zero-commit push whose only dirty
	 * paths sit under one of these as a deliberate no-op rather than a
	 * dropped commit (warren-f6f2, warren-89b0).
	 *
	 * Scope carefully: a directory warren itself materializes as part of
	 * agent composition is NOT harness state, even when it shares a parent
	 * with something that is.
	 */
	readonly harnessStatePrefixes: readonly string[];
	/**
	 * Lifecycle envelope `type` values whose `stopReason` is authoritative
	 * for a terminal provider error (warren-edc3). An envelope of one of
	 * these types carrying `stopReason: "error"` plus a non-empty
	 * `errorMessage` is the hard-error signal; any other `stopReason` on the
	 * same types clears an earlier one.
	 *
	 * Empty means this harness emits no envelope warren knows how to read
	 * that way, so a run on it is never failed by the provider-error net.
	 */
	readonly terminalErrorEnvelopeTypes: readonly string[];

	/* ------------------------------------------------------------------ */
	/* Phase-2 harness capabilities (warren-7933, plan pl-3007). Source-  */
	/* lifted from burrow's `AgentRuntime` (`src/runtime/runtime.ts` in    */
	/* `@os-eco/burrow-cli`). All optional: an adapter declares only the  */
	/* hooks its harness supports, exactly as burrow's runtimes did.      */
	/* ------------------------------------------------------------------ */

	/**
	 * Render the harness's argv plus stdin blob for one spawn. Lifted from
	 * burrow's `AgentRuntime.buildSpawnCommand`. The dispatcher owns cwd,
	 * env resolution, and the sandbox boundary; the adapter owns only the
	 * harness-specific command shape.
	 */
	buildSpawnCommand?(ctx: AdapterSpawnContext): SpawnCommand;

	/**
	 * Collapse one stdout line into zero or more structured events in the
	 * stable taxonomy (burrow SPEC §14.1). Lifted from burrow's
	 * `AgentRuntime.parseEvents`; the per-harness collapse rules live in
	 * `./parsers/` and are pinned byte-for-byte by the golden RPC fixtures
	 * under `./parsers/__golden__/`.
	 */
	parseEvents?(line: string): AdapterRuntimeEvent[];

	/**
	 * Fold pending steering messages into the spawn's stdin payload
	 * (burrow SPEC §13.2). Spawn-per-turn harnesses inject the inbox
	 * alongside the user prompt at dispatch time.
	 */
	encodeInboxMessage?(messages: readonly SteeringMessage[]): { stdin: string };

	/**
	 * Mid-run steering encoder (burrow SPEC §13.5). Encodes one inbox
	 * message for delivery to a still-open child stdin. Only effective when
	 * the adapter also declares `shouldCloseStdinOnEvent`. Returning
	 * `undefined` declines mid-stream delivery; the message stays queued
	 * for the next spawn.
	 */
	encodeSteeringMessage?(message: SteeringMessage): { stdin: string } | undefined;

	/**
	 * Stdin-hold predicate. When defined, the dispatcher holds the child's
	 * stdin open after writing the prompt and closes it only when this
	 * predicate returns true for a persisted event (or at process exit).
	 * Harnesses whose CLI exits the instant stdin closes mid-inference
	 * (pi — mx-d9b3ad) MUST declare this; harnesses that rely on stdin EOF
	 * to flush final output (claude-code `--print`) MUST NOT.
	 */
	shouldCloseStdinOnEvent?(event: AdapterRuntimeEvent): boolean;

	/**
	 * Auto-reply hook, invoked once per parser-emitted event. Returning
	 * `{stdin}` writes that string verbatim to the still-open child stdin —
	 * the canonical use is declining pi's interactive
	 * `extension_ui_request` RPC so an extensions-enabled run cannot hang.
	 */
	autoRespondToEvent?(event: AdapterRuntimeEvent): { stdin: string } | undefined;

	/**
	 * Pre-spawn workspace hook: materialize the harness's per-run state
	 * (pi's session dir, claude-code's settings file + private TMPDIR +
	 * forwarded credentials) under `workspacePath`.
	 */
	prepareWorkspace?(ctx: AdapterPrepareContext): Promise<void>;

	/**
	 * Post-spawn hook returning key/value pairs to merge into the run's
	 * metadata — e.g. pi's `session_id` recovered from the pinned session
	 * directory. Best-effort: failures and `undefined` returns are
	 * swallowed so extraction never fails an otherwise successful run.
	 */
	extractMetadata?(
		ctx: AdapterExtractMetadataContext,
	): Promise<Record<string, unknown> | undefined>;
}

/**
 * The minimal steering-message shape the encoders read (burrow's `Message`
 * carried a full row; the encoders only ever consult `body` + `priority`,
 * per `src/runtime/k8s/agent-io.ts`'s mapping note). The seam's
 * `Message` (`src/runtime/contract.ts`) satisfies this structurally.
 */
export interface SteeringMessage {
	readonly body: string;
	readonly priority: InboxPriority;
}

/**
 * Event kinds in the stable taxonomy the parsers collapse into (burrow
 * SPEC §14.1). `state_change` carries lifecycle/ack envelopes and
 * `telemetry` carries best-effort streaming updates, both on the `system`
 * stream; content kinds ride `stdout`.
 */
export type AdapterEventKind =
	| "text"
	| "thinking"
	| "tool_use"
	| "tool_result"
	| "state_change"
	| "telemetry";

/**
 * Partial event shape produced by `parseEvents` — burrow's `RuntimeEvent`
 * lifted without the persistence columns (`id`, `seq`, `sandboxId`,
 * `runId`, `ts`), which the persisting layer fills in.
 */
export interface AdapterRuntimeEvent {
	readonly kind: AdapterEventKind;
	readonly stream: EventStream;
	readonly payload: unknown;
	readonly ts?: Date;
}

/** argv + stdin (+ optional env/cwd) for one harness spawn — burrow's `SpawnCommand`. */
export interface SpawnCommand {
	readonly argv: string[];
	readonly stdin?: string;
	readonly env?: Record<string, string>;
	readonly cwd?: string;
}

/**
 * Allowlisted `pi` CLI option bag accepted under `frontmatter.pi`
 * (burrow-b5b4). Empty or whitespace-only strings are treated as unset.
 */
export interface PiFrontmatterOptions {
	/** Opt in to pi extension discovery by eliding --no-extensions. */
	extensions?: boolean;
	/** Trust project-local .pi settings/resources for this non-interactive run. */
	approve?: boolean;
	/** Disable all tools by default. Maps to --no-tools. */
	noTools?: boolean;
	/** Disable built-in tools while leaving extension/custom tools available. */
	noBuiltinTools?: boolean;
	/** Comma-separated or array-form allowlist for --tools. */
	tools?: string | readonly string[];
	/** Comma-separated or array-form denylist for --exclude-tools. */
	excludeTools?: string | readonly string[];
	/** Extra extension paths to load with repeated --extension flags. */
	extension?: string | readonly string[];
	/** Extra skill paths to load with repeated --skill flags. */
	skill?: string | readonly string[];
	/** Extra prompt template paths to load with repeated --prompt-template flags. */
	promptTemplate?: string | readonly string[];
	/** Extra theme paths to load with repeated --theme flags. */
	theme?: string | readonly string[];
}

/**
 * Per-run agent frontmatter resolved by an upstream caller (warren's
 * `rendered_agent_json.frontmatter`). Adapters that accept provider /
 * model flags honor these to override their pinned defaults (burrow-b5b4).
 */
export interface AgentFrontmatter {
	provider?: string;
	model?: string;
	pi?: PiFrontmatterOptions;
}

/**
 * Input to `buildSpawnContext`-style rendering — burrow's `SpawnContext`
 * narrowed to the fields the lifted harnesses actually read (the k8s
 * in-pod driver stubbed the rest, see `src/runtime/k8s/agent-io.ts`).
 */
export interface AdapterSpawnContext {
	readonly runId: string;
	readonly prompt: string;
	/** Steering messages to deliver as part of this turn (burrow SPEC §13.2). */
	readonly pendingMessages: readonly SteeringMessage[];
	/**
	 * Workspace path on the host. The sandbox bind-mounts this to
	 * `/workspace`, so the agent only ever sees `/workspace`; adapter code
	 * that writes setup files operates on the host path.
	 */
	readonly workspacePath: string;
	/** Optional per-run frontmatter override (see {@link AgentFrontmatter}). */
	readonly frontmatter?: AgentFrontmatter;
}

/** Input to `prepareWorkspace`. */
export interface AdapterPrepareContext {
	readonly runId: string;
	readonly workspacePath: string;
}

/** Input to `extractMetadata`. */
export interface AdapterExtractMetadataContext {
	readonly runId: string;
	readonly workspacePath: string;
}
