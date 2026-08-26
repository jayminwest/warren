/**
 * Instance facts (warren-2eec / pl-7e38 step 17) — the read-only boot-time
 * facts the operator console's Instance page displays.
 *
 * Warren's config model is env-at-boot plus git-tracked YAML: there is NO
 * mutable server-side settings state, so this is strictly a facts surface,
 * not a settings API. Everything here is resolved from the same boot seams
 * the server itself uses (`resolveRuntimeKind`, `resolveAdmissionCaps`,
 * `resolveAuthKind`) so the answer can never drift from what boot did.
 *
 * Safety contract: buildInstanceFacts only ever emits the fields declared
 * in InstanceFacts. No secrets, tokens, connection strings, internal
 * hostnames, or filesystem paths enter the structure by construction —
 * callers pass a dialect (`"sqlite" | "postgres"`), never `WARREN_DB_URL`.
 */

import { VERSION } from "../index.ts";
import { resolveAdmissionCaps } from "../runtime/k8s/admission.ts";
import { type RuntimeKind, resolveRuntimeKind } from "../runtime/registry.ts";

/** Auth mode as resolved at boot by `resolveAuthKind` (src/server/auth.ts). */
export type InstanceAuthMode = "token" | "public";

/** Database dialect as resolved at boot from `WARREN_DB_URL`. */
export type InstanceDbBackend = "sqlite" | "postgres";

/** Env surface the facts builder reads (a subset of `process.env`). */
export type InstanceEnv = Readonly<Record<string, string | undefined>>;

/** K8s admission caps — surfaced only under `WARREN_RUNTIME=k8s`. */
export interface InstanceAdmissionFacts {
	readonly maxQueueDepth: number;
	readonly maxPendingPods: number;
	readonly maxProjectConcurrency: number | null;
}

/** The full operator projection. */
export interface InstanceFacts {
	readonly version: string;
	readonly runtime: RuntimeKind;
	readonly authMode: InstanceAuthMode;
	readonly dbBackend: InstanceDbBackend | null;
	readonly uptimeSeconds: number;
	/** Null under `local`/`docker` — the knobs are K8s-only there. */
	readonly admission: InstanceAdmissionFacts | null;
}

/**
 * Inputs the caller resolves (env, boot-resolved auth mode + db dialect,
 * live uptime). Keeping them as inputs keeps this module pure and testable;
 * the handler owns the process-level reads.
 */
export interface InstanceFactsInput {
	readonly env: InstanceEnv;
	readonly authMode: InstanceAuthMode;
	readonly dbBackend: InstanceDbBackend | null;
	readonly uptimeSeconds: number;
}

/**
 * Build the full operator facts body. Allowlist by construction: a new env
 * knob never appears here until this function names it.
 */
export function buildInstanceFacts(input: InstanceFactsInput): InstanceFacts {
	const runtime = resolveRuntimeKind(input.env);
	return {
		version: VERSION,
		runtime,
		authMode: input.authMode,
		dbBackend: input.dbBackend,
		uptimeSeconds: Math.max(0, Math.floor(input.uptimeSeconds)),
		admission: runtime === "k8s" ? resolveAdmissionCaps(input.env) : null,
	};
}

/**
 * The reduced `WARREN_AUTH=public` spectator projection. Same shape rules
 * as `src/server/projection.ts`: an allowlist, never a denylist, so a fact
 * added to InstanceFacts tomorrow is absent here until it is deliberately
 * cleared for spectators. Only the three static facts the login/demo
 * surface needs; db backend, uptime, and admission topology stay
 * operator-only.
 */
export function publicInstanceFacts(
	facts: InstanceFacts,
): Pick<InstanceFacts, "version" | "runtime" | "authMode"> {
	return {
		version: facts.version,
		runtime: facts.runtime,
		authMode: facts.authMode,
	};
}
