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

import { mkdir, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ValidationError } from "../../../core/errors.ts";
import { parseSalvageEnvelope, type SalvageEnvelope } from "../../../runtime/k8s/finalize-wire.ts";
import { MAX_SALVAGE_BUNDLE_BYTES, salvageBundleFileName } from "../../../runtime/salvage.ts";
import { jsonResponse } from "../../response.ts";
import type { RouteContext, RouteHandler, ServerDeps } from "../../types.ts";
import { readJsonBody, requireParam } from "../index.ts";
import { stampRunSystemEvent } from "../stamp-event.ts";

/** Run event kind emitted when a salvage lands (best-effort, stream=system). */
export const WORKSPACE_SALVAGED_EVENT = "reap.workspace_salvaged";

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

/** Store the bundle durably (atomic tmp+rename); null when none was sent. */
async function storeBundle(
	salvageDir: string,
	runId: string,
	bundleBytes: Uint8Array | null,
): Promise<string | null> {
	if (bundleBytes === null) return null;
	await mkdir(salvageDir, { recursive: true });
	const bundlePath = join(salvageDir, salvageBundleFileName(runId));
	const tmpPath = `${bundlePath}.tmp-${crypto.randomUUID()}`;
	await writeFile(tmpPath, bundleBytes);
	await rename(tmpPath, bundlePath);
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
		const body = await readJsonBody(ctx);
		const envelope = parseSalvageEnvelope(body);
		if (deps.salvageDir === undefined) {
			// Fail LOUD: silently dropping the only recoverable copy is exactly
			// the defect warren-cd3b exists to close. The pod retries on non-2xx.
			throw new Error(
				"salvage intake is not configured (ServerDeps.salvageDir is unset); refusing to drop the run's recoverable work",
			);
		}
		const bundlePath = await storeBundle(deps.salvageDir, id, decodeBundle(envelope.bundleBase64));
		await recordSalvage(deps, ctx, id, envelope, bundlePath);
		ctx.logger.info(
			{ runId: id, trigger: envelope.trigger, rescueRef: envelope.rescueRef, bundlePath },
			"salvage captured for run",
		);
		return jsonResponse(200, { stored: bundlePath !== null, rescueRef: envelope.rescueRef });
	};
}
