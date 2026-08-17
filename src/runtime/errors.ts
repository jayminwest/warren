/**
 * Errors for the runtime-provider seam (`RuntimeProvider` — see `contract.ts`).
 *
 * Following the warren per-module idiom (cf. `src/workspace/errors.ts`),
 * the runtime cluster owns its own error classes
 * extending the shared `WarrenError` base so callers can catch by class or
 * switch on `code`, and the CLI/HTTP renderers format them uniformly.
 */

import { WarrenError } from "../core/errors.ts";

/**
 * Thrown by a provider method that is a deliberate stub — the shell exists so
 * the contract compiles and is wired, but the behavior lands in a later step.
 * The message names the method + the plan step that fills it (see
 * `notImplemented()` in `local/provider.ts`).
 */
export class RuntimeNotImplementedError extends WarrenError {
	readonly code = "runtime_not_implemented";
}

/**
 * Thrown when `WARREN_RUNTIME` names a runtime the registry doesn't know. The
 * selector fails loudly rather than silently falling back to the default, so a
 * typo can never route a run onto the wrong backend.
 */
export class UnknownRuntimeError extends WarrenError {
	readonly code = "unknown_runtime";
}

/**
 * Thrown when a provider cannot satisfy a `RunSpec` it was handed — the
 * neutral intent is missing something the backend requires (e.g. LocalProvider
 * needs a host clone path but `hostClonePathHint` was omitted), or the backing
 * client pool has no resolvable worker. Distinct from a transport failure
 * (`RuntimeUnreachableError`) or a backend-side validation error: this fires
 * on warren's side, before the request leaves the process.
 */
export class RuntimeProviderError extends WarrenError {
	readonly code = "runtime_provider_error";
}

/**
 * Provider-neutral "the run/sandbox this handle points at no longer exists" —
 * the seam's replacement for a backend not-found (K8s: a GC'd pod). A
 * provider raises this from `sendMessage` / `cancel` when the backend reports
 * the run is gone; `status()` reports
 * the same condition as `exists:false` rather than throwing. The domain
 * call-sites (`steerRun`, `cancelRun`) catch THIS instead of importing a
 * backend error class, so the error taxonomy stops leaking the backend across
 * the seam (warren-1f56). Distinct from `RuntimeProviderError` (warren-side,
 * before the request leaves) and `RuntimeUnreachableError` (transport).
 */
export class RuntimeRunNotFoundError extends WarrenError {
	readonly code = "runtime_run_not_found";
}

/**
 * Provider-neutral transport failure — the runtime backend could not be reached
 * (a dead socket, a refused connection, a fetch timeout, a GC'd control
 * endpoint). Maps to `503 Service Unavailable`. This is the neutral base the
 * HTTP layer catches so the error taxonomy stops naming a specific backend
 * (warren-36cb): K8sProvider raises this class directly on its own transport
 * failures. Distinct from `RuntimeProviderError`
 * (warren-side, before the request leaves) and `RuntimeRunNotFoundError` (the
 * run is simply gone).
 */
export class RuntimeUnreachableError extends WarrenError {
	readonly code: string = "runtime_unreachable";
}

/**
 * Provider-neutral "the backend refused this request because the run/workspace
 * is in a conflicting state" — the seam's replacement for a backend conflict
 * class. Maps to `409 Conflict`.
 * A provider raises this when the backend reports a state clash rather than a
 * transport or not-found condition (warren-36cb).
 */
export class RuntimeConflictError extends WarrenError {
	readonly code = "runtime_conflict";
}

/**
 * Admission rejection — the provider refused a `create()` because a capacity
 * cap is exceeded (pl-829f step 21 / warren-b6f2, K8s-native admission control,
 * design §3.3). A soft control that sits in front of the scheduler: cluster
 * queue-depth / max-pending-pods saturation, or a per-project concurrency cap.
 * The HTTP layer maps this to `429 Too Many Requests` + a `Retry-After` header
 * (`src/server/errors.ts`); the `reason` discriminates which cap tripped so a
 * caller can distinguish "the cluster is busy" from "your project is at its
 * cap". `reason` is a plain string here so this backend-neutral error file
 * doesn't couple to the K8s admission module's `AdmissionRejectReason`.
 */
export class RuntimeAdmissionError extends WarrenError {
	readonly code = "runtime_admission_rejected";
	/** Machine-readable cap that tripped (an `AdmissionRejectReason`). */
	readonly reason: string;
	/** Seconds the caller should back off before retrying (the `Retry-After`). */
	readonly retryAfterSeconds: number;

	constructor(
		message: string,
		options: {
			reason: string;
			retryAfterSeconds: number;
			cause?: unknown;
			recoveryHint?: string;
		},
	) {
		super(message, {
			...(options.cause !== undefined ? { cause: options.cause } : {}),
			...(options.recoveryHint !== undefined ? { recoveryHint: options.recoveryHint } : {}),
		});
		this.reason = options.reason;
		this.retryAfterSeconds = options.retryAfterSeconds;
	}
}
