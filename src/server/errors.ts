/**
 * Map thrown errors to `{ status, ErrorEnvelope }` for the warren HTTP
 * server (SPEC §8.1 + §11.D).
 *
 * Three error families flow through here:
 *   - `WarrenError` subclasses → mapped to a stable status by class.
 *      `warrenStatusFor` is the authoritative status table; the subclass
 *      set spans many modules and grows over time, so it is intentionally
 *      not enumerated here to avoid drift. The provider-neutral runtime
 *      errors (`RuntimeUnreachableError`, `RuntimeRunNotFoundError`,
 *      `RuntimeConflictError`, `RuntimeAdmissionError`) live in this family.
 *   - Backend-reported failures that reach the HTTP layer still carrying a
 *      backend `code` — a provider surfaced a server envelope without wrapping
 *      it in a neutral runtime class (a `@os-eco/burrow-cli` `BurrowError` from
 *      a call the runtime seam does not yet route through `RuntimeProvider`).
 *      Mapped by `code` alone via `runtimeBackendStatusFor` (warren-36cb): this
 *      file imports NOTHING from `@os-eco/burrow-cli` or `src/burrow-client`, yet
 *      an HTTP consumer still sees the same `{code, message, hint}` they'd see
 *      hitting the backend directly.
 *   - Anything else → 500 internal_error with the bare message.
 *
 * `notFound` / `methodNotAllowed` / `notImplemented` are the canned
 * envelopes used by the router when no route matches or a route is a
 * scaffold-only stub.
 */

import {
	NotFoundError,
	StateTransitionError,
	ValidationError,
	WarrenError,
} from "../core/errors.ts";
import {
	PlanHasNoOpenChildrenError,
	ProjectLacksPlotError,
	ProjectLacksSeedsError,
} from "../plan-runs/errors.ts";
import { NoDispatchableSeedsError, SdPlanSynthesisError } from "../plot-plan-runs/index.ts";
import {
	PlotAttachmentNotFoundError,
	PlotIdInvalidError,
	PlotIdNotFoundError,
	PlotIllegalStatusTransitionError,
	PlotIntentFrozenError,
	PlotPrAttachmentInvalidError,
	PlotPrAttachmentMismatchedKindError,
	PlotQuestionAlreadyAnsweredError,
	PlotQuestionNotFoundError,
} from "../plots/errors.ts";
import { ProjectUnavailableError } from "../projects/errors.ts";
import { AgentSchemaError, CanopyUnavailableError } from "../registry/errors.ts";
import { RunSpawnError } from "../runs/errors.ts";
import {
	RuntimeAdmissionError,
	RuntimeConflictError,
	RuntimeRunNotFoundError,
	RuntimeUnreachableError,
	runtimeBackendStatusFor,
} from "../runtime/errors.ts";
import { WarrenConfigUnavailableError } from "../warren-config/errors.ts";
import type { ErrorEnvelope } from "./types.ts";

export interface RenderedError {
	readonly status: number;
	readonly envelope: ErrorEnvelope;
	/**
	 * Extra HTTP response headers to emit alongside the envelope (e.g.
	 * `Retry-After` on a 429 admission rejection). Absent for most errors — the
	 * server forwards these to `jsonResponse` when present.
	 */
	readonly headers?: Readonly<Record<string, string>>;
}

export function renderError(err: unknown): RenderedError {
	if (err instanceof RuntimeAdmissionError) {
		// 429 + Retry-After (warren-b6f2): the cluster/project is at capacity. The
		// header advertises the backoff the provider chose; the envelope carries
		// the machine-readable reason in the hint so a caller can distinguish
		// "cluster busy" from "project at cap".
		const envelope = buildEnvelope(err.code, err.message, err.recoveryHint);
		return {
			status: 429,
			envelope,
			headers: { "Retry-After": String(err.retryAfterSeconds) },
		};
	}
	if (err instanceof WarrenError) {
		const envelope = buildEnvelope(err.code, err.message, err.recoveryHint);
		return { status: warrenStatusFor(err), envelope };
	}
	// Backend-reported failure leaking from a call the runtime seam does not yet
	// route through `RuntimeProvider` (a raw burrow server envelope). Mapped by
	// its own `code` so the envelope forwards verbatim — no `@os-eco/burrow-cli`
	// import (warren-36cb). WarrenError is handled above, so this only fires for
	// non-warren backend errors; a warren class that shares a code (e.g.
	// `validation_error`) never reaches here.
	const backendStatus = runtimeBackendStatusFor(err);
	if (backendStatus !== undefined) {
		const { code, message, hint } = readBackendEnvelope(err);
		return { status: backendStatus, envelope: buildEnvelope(code, message, hint) };
	}
	if (err instanceof Error) {
		return {
			status: 500,
			envelope: buildEnvelope("internal_error", err.message),
		};
	}
	return {
		status: 500,
		envelope: buildEnvelope("internal_error", String(err)),
	};
}

export function notFound(pathname: string): RenderedError {
	return {
		status: 404,
		envelope: buildEnvelope("not_found", `no route matches ${pathname}`),
	};
}

export function methodNotAllowed(method: string, pathname: string): RenderedError {
	return {
		status: 405,
		envelope: buildEnvelope("method_not_allowed", `${method} not allowed on ${pathname}`),
	};
}

export function notImplemented(route: string): RenderedError {
	return {
		status: 501,
		envelope: buildEnvelope(
			"not_implemented",
			`route ${route} is scaffolded but has no handler yet`,
		),
	};
}

function buildEnvelope(code: string, message: string, hint?: string): ErrorEnvelope {
	const error: ErrorEnvelope["error"] = { code, message };
	if (hint !== undefined) error.hint = hint;
	return { error };
}

/**
 * Read the `{code, message, hint}` an error already carries, defensively off an
 * `unknown`. Used for backend-reported failures whose status came from
 * `runtimeBackendStatusFor` — the envelope forwards the backend's own fields so
 * a consumer sees the same shape they'd see hitting the backend directly, with
 * NO `@os-eco/burrow-cli` import (warren-36cb). `recoveryHint` is warren's field
 * name; `hint` is the raw wire name — either is honored.
 */
function readBackendEnvelope(err: unknown): { code: string; message: string; hint?: string } {
	const e = err as { code?: unknown; message?: unknown; recoveryHint?: unknown; hint?: unknown };
	const code = typeof e.code === "string" ? e.code : "internal_error";
	const message = typeof e.message === "string" ? e.message : String(err);
	const hintValue = e.recoveryHint ?? e.hint;
	const hint = typeof hintValue === "string" ? hintValue : undefined;
	return hint !== undefined ? { code, message, hint } : { code, message };
}

function warrenStatusFor(err: WarrenError): number {
	if (err instanceof NotFoundError) return 404;
	if (err instanceof ValidationError) return 400;
	if (err instanceof ProjectLacksSeedsError) return 400;
	if (err instanceof ProjectLacksPlotError) return 400;
	if (err instanceof PlanHasNoOpenChildrenError) return 400;
	if (err instanceof NoDispatchableSeedsError) return 400;
	if (err instanceof SdPlanSynthesisError) return 500;
	if (err instanceof StateTransitionError) return 409;
	if (err instanceof PlotIntentFrozenError) return 409;
	if (err instanceof PlotIllegalStatusTransitionError) return 409;
	if (err instanceof PlotAttachmentNotFoundError) return 404;
	if (err instanceof PlotPrAttachmentMismatchedKindError) return 400;
	if (err instanceof PlotPrAttachmentInvalidError) return 400;
	if (err instanceof PlotQuestionNotFoundError) return 404;
	if (err instanceof PlotQuestionAlreadyAnsweredError) return 409;
	if (err instanceof PlotIdInvalidError) return 400;
	if (err instanceof PlotIdNotFoundError) return 400;
	// Provider-neutral runtime errors (warren-36cb). `RuntimeUnreachableError`
	// covers the LocalProvider's `BurrowUnreachableError` (which extends it) and
	// K8sProvider transport failures alike; the run-not-found / conflict cases
	// mirror burrow's `not_found`→404 / `toolchain_mismatch`→409.
	if (err instanceof RuntimeUnreachableError) return 503;
	if (err instanceof RuntimeRunNotFoundError) return 404;
	if (err instanceof RuntimeConflictError) return 409;
	if (err instanceof CanopyUnavailableError) return 503;
	if (err instanceof ProjectUnavailableError) return 503;
	if (err instanceof WarrenConfigUnavailableError) return 503;
	// Multi-worker placement errors were retired with the K8s migration
	// (warren-76c5): the self-host backend is a single local burrow, so there
	// is no placement/sticky-worker failure to map. The /workers + /burrows
	// admin surface was likewise removed (warren-288f); NotFoundError now only
	// maps the run/project/plot not-found cases below.
	if (err instanceof AgentSchemaError) return 422;
	if (err instanceof RunSpawnError) return 500;
	return 500;
}
