/**
 * The salvage intake endpoint for the K8s backend (warren-cd3b) — the
 * control-plane half of salvage-before-destroy.
 *
 * When a run pod's in-pod finalize determines the run's committed work would
 * otherwise be lost — the primary branch push was rejected (`push_failed`,
 * e.g. GitHub push protection) or no reap intent ever arrived before the pod
 * had to exit (`no_intent`, e.g. a control-plane rollout severed the finalize
 * loop) — the pod captures the work itself (a control-plane salvage cannot
 * reach the pod's `emptyDir`) and POSTs a `SalvageEnvelope` here:
 *
 *   - `rescueRef` — the `warren/rescue/<runId>` branch the pod pushed to
 *     origin, when that push landed;
 *   - `bundleBase64` — a git bundle of the run's commits, stored durably at
 *     `<salvageDir>/<runId>.bundle` so it survives the pod AND a warren
 *     restart (the data dir is the persistent volume).
 *
 * The handler records the salvage location on the run row (`salvage_ref` /
 * `salvage_path`) and appends a `reap.workspace_salvaged` run event so the
 * recovery path is operator-visible on the run object and the event stream.
 * Both writes are best-effort past the bundle store: a deleted run row (or a
 * colliding event seq) must not turn the pod's only recoverable copy into a
 * 500 — the bundle on disk is the durable artifact.
 *
 * Bearer-gated like every other `/runs` route; the pod carries its per-run
 * scoped callback token (warren-57fd). Idempotent: a retried POST rewrites
 * the same file and re-stamps the same location, so redelivery is safe.
 */

import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { ValidationError } from "../../../core/errors.ts";
import { parseSalvageEnvelope, type SalvageEnvelope } from "../../../runtime/k8s/finalize-wire.ts";
import { MAX_SALVAGE_BUNDLE_BYTES, salvageBundlePath } from "../../../runtime/salvage.ts";
import { jsonResponse } from "../../response.ts";
import { EventStreamLimiter } from "../../stream-limits.ts";
import type { RouteContext, RouteHandler, ServerDeps } from "../../types.ts";
import { readJsonBody, requireParam } from "../index.ts";
import { stampRunSystemEvent } from "../stamp-event.ts";

/** Run event kind emitted when a salvage lands (best-effort, stream=system). */
export const WORKSPACE_SALVAGED_EVENT = "reap.workspace_salvaged";

/**
 * Per-run in-flight cap on salvage uploads (warren-adc1). Without it, N
 * concurrent POSTs for one run stage N tmp files of up to 32MiB each on the
 * control-plane volume before any of them collapse onto the single final
 * path — and the pod's run-scoped token is reachable by the agent, so the
 * untrusted side holds this write path. One upload per run id at a time is
 * all the intake ever needs: a retried POST is idempotent, so a rejected
 * concurrent upload loses nothing (the pod retries on non-2xx).
 *
 * Reuses the event-stream per-key limiter (warren-25f6) rather than a new
 * counter: keyed on the run id, per-key cap 1, no global cap, no lifetime
 * (an upload is bounded by the 32MiB body, not a wall-clock budget). A
 * second concurrent upload for the same run gets the family's usual
 * rejection — `EventStreamCapacityError` → 503 + `Retry-After`.
 */
export const salvageUploadLimiter = new EventStreamLimiter({
	maxPerClient: 1,
	maxGlobal: 0,
	maxLifetimeMs: 0,
	trustedProxyHops: 0,
});

/**
 * Decode + cap the base64 bundle. Over-cap or malformed base64 is a 400 the
 * pod can log (it has already done its best; the rescue ref may still have
 * landed). Returns the raw bytes, or null when the envelope carried no bundle.
 */
function decodeBundle(bundleBase64: string | null): Uint8Array | null {
	if (bundleBase64 === null) return null;
	let bytes: Uint8Array;
	try {
		bytes = Buffer.from(bundleBase64, "base64");
	} catch {
		throw new ValidationError("body.bundleBase64 is not valid base64");
	}
	if (bytes.byteLength === 0) {
		throw new ValidationError("body.bundleBase64 decoded to zero bytes");
	}
	if (bytes.byteLength > MAX_SALVAGE_BUNDLE_BYTES) {
		throw new ValidationError(
			`body.bundleBase64 decodes to ${bytes.byteLength} bytes, over the ${MAX_SALVAGE_BUNDLE_BYTES}-byte cap`,
		);
	}
	return bytes;
}

/**
 * Store the bundle durably (atomic tmp+rename); null when none was sent.
 *
 * `salvageBundlePath` — not a bare `join` — resolves the target, because
 * `runId` is a percent-decoded route param (warren-7c1e). It throws a
 * `ValidationError` (→ 400) for anything that would land outside
 * `salvageDir`, and it throws BEFORE the `mkdir`, so a refused id creates
 * nothing on disk.
 */
async function storeBundle(
	salvageDir: string,
	runId: string,
	bundleBytes: Uint8Array | null,
): Promise<string | null> {
	if (bundleBytes === null) return null;
	const bundlePath = salvageBundlePath(salvageDir, runId);
	await mkdir(salvageDir, { recursive: true });
	const tmpPath = `${bundlePath}.tmp-${crypto.randomUUID()}`;
	try {
		await writeFile(tmpPath, bundleBytes);
		await rename(tmpPath, bundlePath);
	} finally {
		// Remove the staged tmp file on EVERY path (warren-adc1), not just a
		// successful rename — a failed write must not leak up-to-32MiB files
		// onto the control-plane volume. The rename already moved the file on
		// success, so `force` absorbs the missing-file case; swallow any
		// unlink error so it never masks the original failure.
		await rm(tmpPath, { force: true }).catch(() => {});
	}
	return bundlePath;
}

/** Stamp the run row + emit the operator-visible event (best-effort, see module doc). */
async function recordSalvage(
	deps: ServerDeps,
	ctx: RouteContext,
	runId: string,
	envelope: SalvageEnvelope,
	bundlePath: string | null,
): Promise<void> {
	try {
		await deps.repos.runs.setSalvage(runId, {
			rescueRef: envelope.rescueRef,
			bundlePath,
		});
	} catch (err) {
		ctx.logger.warn(
			{ runId, err: err instanceof Error ? err.message : String(err) },
			"salvage: could not stamp the run row (run deleted?); the bundle is still on disk",
		);
	}
	await stampRunSystemEvent(deps, ctx.logger, {
		runId,
		kind: WORKSPACE_SALVAGED_EVENT,
		payload: {
			trigger: envelope.trigger,
			rescueRef: envelope.rescueRef,
			bundlePath,
			branch: envelope.branch,
			baseBranch: envelope.baseBranch,
			notes: envelope.notes,
		},
		level: "warn",
		message: "salvage: could not append the salvaged event; the bundle is still on disk",
	});
}

/**
 * `POST /runs/:id/salvage` — intake for the pod's salvage capture. Stores the
 * bundle durably (atomic tmp+rename), stamps the run row, and emits the
 * operator-visible event. Every case that received a valid envelope answers
 * 200 so the pod's retry loop stops; the response reports what was stored.
 */
export function postRunSalvageHandler(deps: ServerDeps): RouteHandler {
	return async (ctx) => {
		const id = requireParam(ctx, "id");
		// Hold the per-run slot for the WHOLE intake, body read included, so a
		// second concurrent POST is refused BEFORE we buffer its bundle.
		const slot = salvageUploadLimiter.acquire(id);
		try {
			const body = await readJsonBody(ctx);
			const envelope = parseSalvageEnvelope(body);
			if (deps.salvageDir === undefined) {
				// Fail LOUD: silently dropping the only recoverable copy is exactly
				// the defect warren-cd3b exists to close. The pod retries on non-2xx.
				throw new Error(
					"salvage intake is not configured (ServerDeps.salvageDir is unset); refusing to drop the run's recoverable work",
				);
			}
			const bundlePath = await storeBundle(
				deps.salvageDir,
				id,
				decodeBundle(envelope.bundleBase64),
			);
			await recordSalvage(deps, ctx, id, envelope, bundlePath);
			ctx.logger.info(
				{ runId: id, trigger: envelope.trigger, rescueRef: envelope.rescueRef, bundlePath },
				"salvage captured for run",
			);
			return jsonResponse(200, { stored: bundlePath !== null, rescueRef: envelope.rescueRef });
		} finally {
			slot.release();
		}
	};
}
