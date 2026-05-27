/**
 * Small shared helpers for the launch flow (warren-62a7 / pl-9088 step 9).
 * These are the pieces both `./orchestrate.ts` and `./setup.ts` reach for
 * when capturing failure context, cleaning up sidecars, or formatting
 * `preview_failure_message`.
 */

import { PREVIEW_FAILURE_TAIL_BYTES, type PreviewSidecarsClient } from "./types.ts";

/**
 * Default env block injected into every preview sidecar (warren-79b2).
 * Burrow's inbound forwarder connects via `nc 127.0.0.1 <sandboxPort>` from
 * inside the sandbox netns, so a dev server bound to `localhost`/`::1` only
 * (Next.js 13.5+ default) is unreachable. CRA reads `HOST`; several
 * Express-style servers read `HOST`/`HOSTNAME`; forcing both to `0.0.0.0`
 * is a no-op for projects already binding to all interfaces. `PORT` lets
 * Vite/Next.js/Express/CRA avoid hard-coding the sandbox port twice.
 *
 * Next.js's CLI silently IGNORES `HOSTNAME`/`HOST` env vars (its commander
 * `-H, --hostname` is NOT chained with `.env(...)`); Next.js projects must
 * still pass `-H 0.0.0.0` in their `command:`. The framework matrix in
 * `.warren/preview.yaml` documents this. Project commands override these
 * defaults by inlining `HOST=...` / `PORT=...` ahead of the command (sh -c).
 */
export function defaultSidecarEnv(sandboxPort: number): Record<string, string> {
	return {
		HOST: "0.0.0.0",
		HOSTNAME: "0.0.0.0",
		PORT: String(sandboxPort),
	};
}

export async function captureFailureTail(
	sidecars: PreviewSidecarsClient,
	burrowId: string,
	sidecarId: string,
): Promise<string> {
	try {
		const logs = await sidecars.logs(burrowId, sidecarId, {
			tailBytes: PREVIEW_FAILURE_TAIL_BYTES,
		});
		const tail = logs.stderr.trim() !== "" ? logs.stderr : logs.stdout;
		return truncate(tail, PREVIEW_FAILURE_TAIL_BYTES);
	} catch {
		return "";
	}
}

export async function safeDeleteSidecar(
	sidecars: PreviewSidecarsClient,
	burrowId: string,
	sidecarId: string,
): Promise<void> {
	try {
		await sidecars.delete(burrowId, sidecarId);
	} catch {
		// Best-effort cleanup — eviction worker also terminates lingering sidecars.
	}
}

export function composeFailureMessage(headline: string, tail: string): string {
	if (tail === "") return headline;
	return `${headline}\n\n${tail}`;
}

export function truncate(input: string, max: number): string {
	if (input.length <= max) return input;
	return `${input.slice(input.length - max)}`;
}

export function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
