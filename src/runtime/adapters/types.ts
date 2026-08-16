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
 * Phase-2 scope stays out by name: burrow's own `AgentRuntime` interface,
 * the k8s in-pod dispatcher, and steering encoding are not modelled here.
 */

import type { RuntimeId } from "../../core/wire.ts";

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
}
