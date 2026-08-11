/**
 * Shared GitHub-transport test doubles, promoted from
 * `src/runs/pr.test-helpers.ts` (plan pl-d1c9 step 1) so every consumer of
 * `src/forge/github/` tests against the same fake. The legacy path
 * re-exports these symbols so existing `src/runs/` tests keep resolving.
 *
 * `recordingFetch` replays canned `Response`s (or thunks for per-attempt
 * variety, e.g. a throw-then-succeed retry test) while capturing each
 * call's url, method, headers, and body for assertion.
 */

export interface RecordedCall {
	readonly url: string;
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string | null;
}

export function recordingFetch(responses: ReadonlyArray<Response | (() => Response)>): {
	fetch: typeof fetch;
	calls: RecordedCall[];
} {
	const calls: RecordedCall[] = [];
	let i = 0;
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const headersInit = init?.headers as Record<string, string> | undefined;
		calls.push({
			url,
			method: (init?.method ?? "GET").toUpperCase(),
			headers: headersInit ?? {},
			body: typeof init?.body === "string" ? init.body : null,
		});
		const next = responses[i++];
		if (next === undefined) throw new Error("recordingFetch: ran out of canned responses");
		return typeof next === "function" ? next() : next;
	}) as unknown as typeof fetch;
	return { fetch: fn, calls };
}

export function jsonResponse(status: number, body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
