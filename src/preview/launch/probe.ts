/**
 * Health-check primitives for the preview readiness loop (warren-62a7 /
 * pl-9088 step 9). Two probes live here, one per phase of the two-phase
 * launch loop in `./orchestrate.ts`:
 *
 *   - `tcpConnectOnce` (phase 1) — raw TCP handshake via `Bun.connect`.
 *     Answers "is anything bound on the port yet?" without speaking HTTP.
 *     warren-49d9 / pl-592f step 1.
 *   - `probeOnce` (phase 2) — HTTP GET with `AbortController` per-call
 *     timeout. Answers "did the bound server return 2xx/3xx?".
 */

/**
 * Tri-state probe outcome (warren-9b15):
 *
 * - `ready`          → 2xx/3xx response. Launch succeeds.
 * - `http_response`  → connected and got a non-2xx/3xx HTTP response
 *                      (e.g. 4xx/5xx while bundler still compiles). Used
 *                      as the phase-1 → phase-2 discriminator.
 * - `not_connected`  → no HTTP response at all (ECONNREFUSED, EHOSTUNREACH,
 *                      AbortController fired before connect completed).
 *                      Keeps the loop in phase 1 under the connect budget.
 *
 * Bun's `fetch()` throws on transport-level failures (refused TCP, DNS,
 * abort) and resolves with a `Response` once headers are in — so the
 * presence of a `Response` object is a reliable "TCP connected + at
 * least some HTTP bytes flowed" signal. We can't perfectly distinguish
 * "bound but hung mid-headers + abort" from "never connected + abort"
 * inside the catch arm; treating that case as `not_connected` is the
 * conservative choice (it keeps the loop in phase 1, which has the
 * larger combined budget for slow-binding servers).
 */
export type ProbeOutcome = "ready" | "http_response" | "not_connected";

export async function probeOnce(
	fetchImpl: typeof fetch,
	url: string,
	perCallTimeoutMs: number,
): Promise<ProbeOutcome> {
	const ac = new AbortController();
	const tid = setTimeout(() => ac.abort(), perCallTimeoutMs);
	try {
		const res = await fetchImpl(url, {
			method: "GET",
			redirect: "manual",
			signal: ac.signal,
		});
		// 2xx ⇒ ready. 3xx is treated as ready too: a dev server that redirects
		// "/" → "/index" is ready; the proxy will follow on real traffic.
		if (res.ok || (res.status >= 300 && res.status < 400)) {
			await drainBody(res);
			return "ready";
		}
		await drainBody(res);
		return "http_response";
	} catch {
		return "not_connected";
	} finally {
		clearTimeout(tid);
	}
}

/**
 * Phase-1 TCP-only probe (warren-49d9 / pl-592f step 1).
 *
 * Phase 1 of `attemptPreviewLaunch` only needs to answer one question:
 * **is anything bound on the host port yet?** `probeOnce` answers a
 * stricter question (did the server send HTTP headers in time?) which
 * misclassifies slow-first-headers dev servers (e.g. Next.js mid-compile)
 * as `not_connected` and burns the connect budget. `tcpConnectOnce` opens
 * a raw TCP socket via `Bun.connect` and resolves as soon as the kernel
 * reports the connection established (or refused / unreachable / timed
 * out), without doing any HTTP work. The socket is closed immediately.
 *
 * Returns:
 *   - `connected`     → kernel accepted the TCP handshake; port is bound.
 *   - `not_connected` → refused, unreachable, or `timeoutMs` elapsed
 *                       before the handshake completed.
 */
export async function tcpConnectOnce(
	host: string,
	port: number,
	timeoutMs: number,
): Promise<"connected" | "not_connected"> {
	return new Promise<"connected" | "not_connected">((resolve) => {
		let settled = false;
		let tid: ReturnType<typeof setTimeout> | undefined;
		let socket: { end: () => void } | undefined;

		const finish = (outcome: "connected" | "not_connected"): void => {
			if (settled) return;
			settled = true;
			if (tid !== undefined) clearTimeout(tid);
			try {
				socket?.end();
			} catch {
				// socket may already be closed; ignore.
			}
			resolve(outcome);
		};

		tid = setTimeout(() => finish("not_connected"), timeoutMs);

		Bun.connect({
			hostname: host,
			port,
			socket: {
				open(sock) {
					socket = sock;
					finish("connected");
				},
				close() {},
				data() {},
				error() {
					finish("not_connected");
				},
			},
		}).catch(() => {
			finish("not_connected");
		});
	});
}

async function drainBody(res: Response): Promise<void> {
	try {
		await res.body?.cancel();
	} catch {
		// stream may already be closed; ignore.
	}
}
