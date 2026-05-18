/**
 * Map thrown errors to `{ status, ErrorEnvelope }` for the warren HTTP
 * server (SPEC §8.1 + §11.D).
 *
 * Three error families flow through here:
 *   - `WarrenError` subclasses (NotFoundError, ValidationError,
 *      StateTransitionError, BurrowUnreachableError, RunSpawnError,
 *      AgentSchemaError, CanopyUnavailableError, ProjectUnavailableError)
 *      → mapped to a stable status by class.
 *   - `BurrowError` subclasses from `@os-eco/burrow-cli` (the rehydrated
 *      server envelope from the burrow HTTP API) → forwarded with the
 *      same code/hint and a status table shaped like burrow's own. The
 *      pass-through is deliberate: an HTTP consumer hitting warren sees
 *      the same `{code, message, hint}` they'd see hitting burrow
 *      directly, so nothing has to be re-mapped at the consumer side.
 *   - Anything else → 500 internal_error with the bare message.
 *
 * `notFound` / `methodNotAllowed` / `notImplemented` are the canned
 * envelopes used by the router when no route matches or a route is a
 * scaffold-only stub.
 */

import {
	AgentNotInstalled,
	AgentRuntimeError,
	BurrowError,
	NotFoundError as BurrowNotFoundError,
	ValidationError as BurrowValidationError,
	CredentialError,
	SandboxError,
	SecretResolutionError,
	ToolchainMismatch,
	WorkspaceMaterializationError,
} from "@os-eco/burrow-cli";
import { BurrowUnreachableError } from "../burrow-client/errors.ts";
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
import { PlotIntentFrozenError } from "../plots/errors.ts";
import { ProjectUnavailableError } from "../projects/errors.ts";
import { AgentSchemaError, CanopyUnavailableError } from "../registry/errors.ts";
import { RunSpawnError } from "../runs/errors.ts";
import { NoEligibleWorkerError, StickyWorkerUnreachableError } from "../runs/placement.ts";
import { WarrenConfigUnavailableError } from "../warren-config/errors.ts";
import type { ErrorEnvelope } from "./types.ts";

export interface RenderedError {
	readonly status: number;
	readonly envelope: ErrorEnvelope;
}

export function renderError(err: unknown): RenderedError {
	if (err instanceof WarrenError) {
		const envelope = buildEnvelope(err.code, err.message, err.recoveryHint);
		return { status: warrenStatusFor(err), envelope };
	}
	if (err instanceof BurrowError) {
		const envelope = buildEnvelope(err.code, err.message, err.recoveryHint);
		return { status: burrowStatusFor(err), envelope };
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

function warrenStatusFor(err: WarrenError): number {
	if (err instanceof NotFoundError) return 404;
	if (err instanceof ValidationError) return 400;
	if (err instanceof ProjectLacksSeedsError) return 400;
	if (err instanceof ProjectLacksPlotError) return 400;
	if (err instanceof PlanHasNoOpenChildrenError) return 400;
	if (err instanceof StateTransitionError) return 409;
	if (err instanceof PlotIntentFrozenError) return 409;
	if (err instanceof BurrowUnreachableError) return 503;
	if (err instanceof CanopyUnavailableError) return 503;
	if (err instanceof ProjectUnavailableError) return 503;
	if (err instanceof WarrenConfigUnavailableError) return 503;
	// Placement errors (warren-14ad / pl-9ba1): both surface as 503 since
	// they signal a worker-side capacity / reachability problem on a route
	// that depended on a healthy worker. NotFoundError handles the "warren
	// never recorded this burrow id" case before placement is consulted —
	// see `getBurrowHandler` in handlers.ts.
	if (err instanceof NoEligibleWorkerError) return 503;
	if (err instanceof StickyWorkerUnreachableError) return 503;
	if (err instanceof AgentSchemaError) return 422;
	if (err instanceof RunSpawnError) return 500;
	return 500;
}

function burrowStatusFor(err: BurrowError): number {
	if (err instanceof BurrowNotFoundError) return 404;
	if (err instanceof BurrowValidationError) return 400;
	if (err instanceof CredentialError) return 401;
	if (err instanceof AgentNotInstalled) return 424;
	if (err instanceof AgentRuntimeError) return 502;
	if (err instanceof SandboxError) return 502;
	if (err instanceof WorkspaceMaterializationError) return 500;
	if (err instanceof ToolchainMismatch) return 409;
	if (err instanceof SecretResolutionError) return 502;
	return 500;
}
