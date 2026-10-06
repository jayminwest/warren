/**
 * One forge HTTP call under a deadline, with the body read inside it.
 *
 * Shared by the transports that talk to a forge an operator may host
 * behind a proxy (Azure DevOps, GitLab). A stalled connection or body read
 * would otherwise hold a reap or a poller tick open indefinitely.
 */

/** Statuses whose `Response` must carry no body. */
const NULL_BODY_STATUSES = new Set([101, 204, 205, 304]);

/**
 * Drain `res` and hand back an equivalent response whose body is already
 * in memory, so no later read can block.
 */
async function bufferResponse(res: Response): Promise<Response> {
	const text = await res.text();
	return new Response(NULL_BODY_STATUSES.has(res.status) ? null : text, {
		status: res.status,
		statusText: res.statusText,
		headers: res.headers,
	});
}

/**
 * Fetch `url` and buffer the body, aborting both at `timeoutMs`. Throws
 * what `fetch` throws (the deadline surfaces as a `TimeoutError`); the
 * caller folds that into its transport's `network` error.
 */
export async function fetchWithDeadline(
	fetchImpl: typeof fetch,
	url: string,
	init: RequestInit,
	timeoutMs: number,
): Promise<Response> {
	// An explicit timer rather than `AbortSignal.timeout`: that signal
	// does not retain the event loop on every platform, so a pending
	// fetch could outlive the deadline it was supposed to cut.
	const controller = new AbortController();
	const deadline = setTimeout(
		() => controller.abort(new DOMException("request timed out at the deadline", "TimeoutError")),
		timeoutMs,
	);
	// The body is consumed inside the same window: a proxy that sends the
	// headers and then stalls the body would otherwise hang a caller's read
	// after the timer was already cleared.
	try {
		const fetched = await fetchImpl(url, { ...init, signal: controller.signal });
		return await bufferResponse(fetched);
	} finally {
		clearTimeout(deadline);
	}
}
