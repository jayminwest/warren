/**
 * `LocalProvider.cancel` body (pl-829f step 11, phase CONTRACT). Wraps burrow's
 * `POST /runs/:id/cancel` (`http.runs.cancel`) — the SAME graceful-stop call the
 * domain's `cancelRun` (`src/runs/cancel.ts`) and the watchdog
 * (`src/runs/watchdog.ts`) make today — as the seam's `cancel(handle, reason?)`.
 *
 * The seam method is a *graceful stop*, deliberately distinct from `terminate`
 * (which tears the sandbox down). Design §3/§4: cancel is best-effort; the domain
 * still reaps + terminates afterward. So this body does the one burrow-touching
 * thing and nothing else — the state-machine transition, the `cancel.requested`
 * audit event, and the inline reap all stay DOMAIN concerns at the call-site
 * (untouched until step 13).
 *
 * Faithful to `cancelRun`'s burrow-touching half:
 *   - Target: burrow's cancel is scoped per-RUN, so the POST addresses
 *     `handle.providerRunId` (the burrowRunId), exactly as `cancelRun` resolves
 *     `run.burrowRunId`.
 *   - Reason: `reason` rides ONLY when the caller supplied it
 *     (`... ? { reason } : {}`), byte-for-byte with `cancelRun`
 *     (`input.reason !== undefined ? { reason: input.reason } : {}`). The
 *     provider invents no default.
 *   - Return: burrow's cancel replies with the run's post-cancel `Run` row; the
 *     seam returns `void`. The domain reads that row (`burrowRun.state`) to
 *     decide whether to reap inline — DOMAIN logic that stays at the call-site,
 *     so the provider discards the row.
 *   - Idempotency: burrow's cancel is itself idempotent — cancelling an
 *     already-terminal run it knows about returns 200 with the current row (no
 *     throw), so this resolves to a clean `void`. The domain's own
 *     already-terminal short-circuit (answering locally without a wire call) is
 *     a warren-side optimization, not something the provider needs to reproduce.
 *   - Transport: wrapped in `withTransportMapping` so a dead socket surfaces as
 *     `BurrowUnreachableError` (`cancelRun` does the same). A burrow 404 (the
 *     run is a ghost) is NEUTRALIZED at the seam (warren-1f56): it re-throws as
 *     the provider-neutral `RuntimeRunNotFoundError` so the domain
 *     (`cancelRun` → terminalize-the-row; the watchdog → swallow) recognizes a
 *     lost run without importing `@os-eco/burrow-cli`'s error class. Other
 *     `BurrowError` subclasses propagate unchanged.
 */

import { type BurrowClient, withTransportMapping } from "../../burrow-client/index.ts";
import type { RunHandle } from "../contract.ts";
import { mapBurrowError } from "./error-map.ts";

/**
 * Forward a graceful cancel to burrow's `POST /runs/:id/cancel` for the run this
 * handle points at. `handle.providerRunId` is the burrowRunId cancel is scoped
 * to; `handle.sandboxId` is deliberately NOT used — cancel targets the run, not
 * the burrow. Returns `void`: the post-cancel `Run` row burrow replies with is a
 * domain reap-decision input, not a seam value.
 */
export async function cancelLocalRun(
	client: BurrowClient,
	handle: RunHandle,
	reason?: string,
): Promise<void> {
	try {
		await withTransportMapping(client.config, () =>
			client.http.runs.cancel(handle.providerRunId, reason !== undefined ? { reason } : {}),
		);
	} catch (err) {
		// Neutralize burrow errors at the seam (warren-1f56, warren-36cb): a ghost
		// run (burrow 404) surfaces to the domain as the provider-neutral
		// `RuntimeRunNotFoundError` so `cancelRun` / the watchdog never import
		// `@os-eco/burrow-cli`'s error class to recognize a lost run. Any burrow
		// class with no neutral analogue propagates unchanged.
		throw mapBurrowError(err, {
			runNotFoundHint: "the run is unknown to the backend; terminalize the warren row",
		});
	}
}
