/**
 * Map thrown errors to `{ status, ErrorEnvelope }` for the warren HTTP
 * server (docs/http-api.md + SECURITY.md).
 *
 * Three error families flow through here:
 *   - `WarrenError` subclasses → mapped to a stable status by class.
 *      `warrenStatusFor` is the authoritative status table; the subclass
 *      set spans many modules and grows over time, so it is intentionally
 *      not enumerated here to avoid drift. The provider-neutral runtime
 *      errors (`RuntimeUnreachableError`, `RuntimeRunNotFoundError`,
 *      `RuntimeConflictError`, `RuntimeAdmissionError`) live in this family.
 *   - Anything else → 500 internal_error with a FIXED generic message plus
 *      the request's correlation id (warren-4385). An untyped throw carries
 *      whatever the failing layer produced — subprocess stderr, filesystem
 *      paths, driver text — and every route can raise one, so the body must
 *      never forward it. The caller logs the full error under the same
 *      correlation id (see `errorLogFields` + `server.ts`), so operators
 *      lose nothing.
 *
 * `notFound` / `methodNotAllowed` / `notImplemented` are the canned
 * envelopes used by the router when no route matches or a route is a
 * scaffold-only stub; `forbidden` is the canned envelope the capability
 * gate returns when the admitted caller can't reach the matched route.
 *
 * `collectedErrorMessage` extends the same body/log split to errors a
 * handler CATCHES and reports inside a 2xx body rather than throwing
 * (warren-bf4c) — `renderError` never sees those, so they need their own
 * entry point to the one policy.
 */

import {
	NotFoundError,
	StateTransitionError,
	ValidationError,
	WarrenError,
} from "../core/errors.ts";
import { PlanHasNoOpenChildrenError, ProjectLacksTrackerError } from "../plan-runs/errors.ts";
import { ProjectUnavailableError } from "../projects/errors.ts";
import { AgentSchemaError } from "../registry/errors.ts";
import { RunSpawnError } from "../runs/errors.ts";
import {
	RuntimeAdmissionError,
	RuntimeConflictError,
	RuntimeRunNotFoundError,
	RuntimeUnreachableError,
} from "../runtime/errors.ts";
import { SandboxGitPreflightError } from "../sandbox/git-preflight.ts";
import { WarrenConfigInvalidError, WarrenConfigUnavailableError } from "../warren-config/errors.ts";
import { EventStreamCapacityError } from "./stream-limits.ts";
import type { ErrorEnvelope, RoutePolicy } from "./types.ts";

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

/**
 * The only message an unhandled 500 ever puts on the wire. Fixed so no
 * caller can smuggle detail into it and so consumers can match on it.
 */
export const INTERNAL_ERROR_MESSAGE = "internal server error";

/**
 * Render a thrown value as `{ status, envelope }`. `requestId` is the
 * per-request correlation id (`RouteContext.requestId`, also stamped as
 * `X-Request-ID`); it is echoed in the hint of the generic 500 envelope so a
 * caller can quote it and an operator can find the full error in the logs.
 * Optional because typed errors don't need it — omitting it only degrades
 * the hint on the untyped path.
 */
export function renderError(err: unknown, requestId?: string): RenderedError {
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
	if (err instanceof EventStreamCapacityError) {
		// 503 + Retry-After (warren-25f6): the event-stream concurrency cap is
		// full. 503 rather than 429 — the caller isn't being rate-limited on a
		// request budget, a finite resource (open connections on a
		// single-replica control plane) is temporarily exhausted.
		const envelope = buildEnvelope(err.code, err.message, err.recoveryHint);
		return {
			status: 503,
			envelope,
			headers: { "Retry-After": String(err.retryAfterSeconds) },
		};
	}
	if (err instanceof WarrenError) {
		const envelope = buildEnvelope(err.code, err.message, err.recoveryHint);
		return { status: warrenStatusFor(err), envelope };
	}
	// Untyped throw (Error or otherwise): nothing above claimed it, so its
	// message is unvetted and never reaches the body (warren-4385).
	return internalError(requestId);
}

/**
 * The generic 500 envelope. Same body whether an `Error`, a string, or any
 * other value was thrown — the distinction is only interesting on the log
 * side, and telling the two apart on the wire is itself a small disclosure.
 */
function internalError(requestId: string | undefined): RenderedError {
	return {
		status: 500,
		envelope: buildEnvelope("internal_error", INTERNAL_ERROR_MESSAGE, logPointerHint(requestId)),
	};
}

/**
 * The "your detail is in the logs, here's how to find it" cue. One
 * spelling, shared by the generic 500 hint and by
 * {@link collectedErrorMessage}, so a caller reads the same sentence
 * whichever half of the body/log split withheld the text.
 */
function logPointerHint(requestId: string | undefined): string {
	return requestId === undefined
		? "check the warren server logs for the underlying error"
		: `check the warren server logs for request id ${requestId}`;
}

/**
 * The only message a CAUGHT error ever puts on the wire — the same
 * body/log split as the untyped-500 path (warren-4385), applied where a
 * handler catches a per-item failure and reports it inside a 2xx body
 * instead of throwing it.
 *
 * Deliberately unconditional: unlike `renderError` it does NOT keep a
 * `WarrenError`'s own message. The errors collected at such a site may
 * interpolate subprocess stderr and on-disk paths, so the typed-is-vetted
 * assumption `renderError` leans on does not hold there. The caller logs
 * the real error under the same correlation id via {@link errorLogFields}.
 */
export function collectedErrorMessage(requestId?: string): string {
	return `${INTERNAL_ERROR_MESSAGE}; ${logPointerHint(requestId)}`;
}

/**
 * Structured log fields for a thrown value — the log half of the
 * body/log split (warren-4385). `renderError` withholds an untyped error's
 * message from the response, so this is the only place the detail survives:
 * `err` is pino's conventional key (its default serializer expands
 * type/message/stack), and `err_message` / `err_stack` repeat it flat so
 * console-shaped loggers and log search see it too. The caller's logger is
 * already bound to `request_id`, which is what ties this record to the
 * correlation id in the response envelope.
 */
export function errorLogFields(err: unknown): Record<string, unknown> {
	if (err instanceof Error) {
		return { err, err_message: err.message, err_stack: err.stack };
	}
	return { err, err_message: String(err) };
}

export function notFound(pathname: string): RenderedError {
	return {
		status: 404,
		envelope: buildEnvelope("not_found", `no route matches ${pathname}`),
	};
}

/**
 * The caller was admitted but its capability set doesn't satisfy the route's
 * declared policy (warren-b875). The body names the capability the route
 * wants and nothing else — not who the caller is, not why it fell short, not
 * whether the resource exists. 403 rather than 404: the route table is public
 * (`docs/openapi.yaml`), so hiding its existence buys nothing, and a
 * spectator that gets a 403 knows to authenticate rather than to retry.
 */
export function forbidden(policy: RoutePolicy): RenderedError {
	return {
		status: 403,
		envelope: buildEnvelope(
			"forbidden",
			`this route requires the '${policy}' capability`,
			"authenticate with an operator bearer token",
		),
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

function warrenStatusFor(err: WarrenError): number {
	if (err instanceof NotFoundError) return 404;
	if (err instanceof ValidationError) return 400;
	if (err instanceof ProjectLacksTrackerError) return 400;
	if (err instanceof PlanHasNoOpenChildrenError) return 400;
	if (err instanceof StateTransitionError) return 409;
	// Provider-neutral runtime errors (warren-36cb): K8sProvider transport
	// failures ride `RuntimeUnreachableError`; run-not-found maps to 404 and a
	// backend state clash (`RuntimeConflictError`) to 409.
	if (err instanceof RuntimeUnreachableError) return 503;
	if (err instanceof RuntimeRunNotFoundError) return 404;
	if (err instanceof RuntimeConflictError) return 409;
	if (err instanceof ProjectUnavailableError) return 503;
	// warren-1219: the resolved git cannot execute inside the sandbox —
	// a host toolchain problem (fix the host), same family as 503.
	if (err instanceof SandboxGitPreflightError) return 503;
	if (err instanceof WarrenConfigUnavailableError) return 503;
	// warren-02aa: a present-but-broken guardrail file is operator-fixable
	// input, not a host failure — 422, same family as AgentSchemaError.
	if (err instanceof WarrenConfigInvalidError) return 422;
	// Multi-worker placement errors were retired with the K8s migration
	// (warren-76c5): the self-host backend is a single local sandbox, so there
	// is no placement/sticky-worker failure to map. The /workers + /burrows
	// admin surface was likewise removed (warren-288f); NotFoundError now only
	// maps the run/project/plot not-found cases below.
	if (err instanceof AgentSchemaError) return 422;
	if (err instanceof RunSpawnError) return 500;
	return 500;
}
