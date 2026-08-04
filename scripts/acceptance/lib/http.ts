/**
 * Bearer-token aware HTTP client for hitting warren during acceptance.
 *
 * Wraps `fetch` with three things every scenario needs:
 *   - automatic Authorization header injection (skipped for /healthz),
 *   - `expectStatus()` and `expectJson<T>()` helpers that raise an
 *     `AcceptanceError` with the response body so test failures don't
 *     swallow the warren error envelope,
 *   - `streamNdjson()` for `/runs/:id/events?follow=1`, which yields
 *     parsed envelope rows until the response closes or the consumer
 *     calls `abort()`.
 *
 * Deliberately tiny — no retry logic, no caching. The harness is the
 * caller; if a request needs to be retried, the scenario does it.
 */
import { WarrenClient } from "../../../src/client/client.ts";
import { AcceptanceError } from "./assert.ts";

export interface WarrenHttpOptions {
	readonly baseUrl: string;
	readonly token: string;
	readonly fetchImpl?: typeof fetch;
}

export class WarrenHttp {
	private readonly baseUrl: string;
	private readonly token: string;
	private readonly fetchImpl: typeof fetch;

	constructor(opts: WarrenHttpOptions) {
		this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
		this.token = opts.token;
		this.fetchImpl = opts.fetchImpl ?? fetch;
	}

	url(path: string): string {
		const p = path.startsWith("/") ? path : `/${path}`;
		return `${this.baseUrl}${p}`;
	}

	async request(
		method: string,
		path: string,
		init: { body?: unknown; signal?: AbortSignal } = {},
	): Promise<Response> {
		const headers: Record<string, string> = { "user-agent": "warren-acceptance/1" };
		if (path !== "/healthz") headers.authorization = `Bearer ${this.token}`;
		const reqInit: RequestInit = { method, headers };
		if (init.body !== undefined) {
			headers["content-type"] = "application/json";
			reqInit.body = JSON.stringify(init.body);
		}
		if (init.signal !== undefined) reqInit.signal = init.signal;
		return this.fetchImpl(this.url(path), reqInit);
	}

	async expectStatus(
		method: string,
		path: string,
		expected: number,
		init: { body?: unknown; signal?: AbortSignal } = {},
	): Promise<Response> {
		const res = await this.request(method, path, init);
		if (res.status !== expected) {
			const body = await safeText(res);
			throw new AcceptanceError(
				`${method} ${path}: expected status ${expected}, got ${res.status}: ${body}`,
			);
		}
		return res;
	}

	async expectJson<T>(
		method: string,
		path: string,
		expected: number,
		init: { body?: unknown; signal?: AbortSignal } = {},
	): Promise<T> {
		const res = await this.expectStatus(method, path, expected, init);
		try {
			return (await res.json()) as T;
		} catch (err) {
			throw new AcceptanceError(
				`${method} ${path}: response body was not JSON: ${err instanceof Error ? err.message : String(err)}`,
			);
		}
	}

	/**
	 * Subscribe to `/runs/:id/events?follow=1` (or any chunked NDJSON
	 * stream warren exposes). Returns an async iterable of parsed JSON
	 * envelopes. Caller can `abort()` to stop streaming.
	 */
	/**
	 * Build an SDK client over the same baseUrl/token/fetch so scenarios
	 * wait on run terminality through `waitForRun` (warren-bb51) instead
	 * of hand-rolled poll loops.
	 */
	sdkClient(): WarrenClient {
		return new WarrenClient({
			config: { baseUrl: this.baseUrl, token: this.token },
			fetch: this.fetchImpl,
		});
	}

	async *streamNdjson(path: string, signal?: AbortSignal): AsyncGenerator<unknown, void, void> {
		const res = await this.request("GET", path, signal !== undefined ? { signal } : {});
		if (res.status !== 200) {
			const body = await safeText(res);
			throw new AcceptanceError(
				`GET ${path}: expected status 200 for streaming, got ${res.status}: ${body}`,
			);
		}
		if (res.body === null) throw new AcceptanceError(`GET ${path}: response had no body`);
		const reader = res.body.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;
				buffer += decoder.decode(value, { stream: true });
				let nlIdx: number;
				// biome-ignore lint/suspicious/noAssignInExpressions: stream parsing
				while ((nlIdx = buffer.indexOf("\n")) >= 0) {
					const line = buffer.slice(0, nlIdx);
					buffer = buffer.slice(nlIdx + 1);
					if (line.trim() === "") continue;
					try {
						yield JSON.parse(line);
					} catch (err) {
						throw new AcceptanceError(
							`malformed NDJSON line on ${path}: ${err instanceof Error ? err.message : String(err)}: ${line}`,
						);
					}
				}
			}
			if (buffer.trim() !== "") {
				try {
					yield JSON.parse(buffer);
				} catch {
					/* trailing non-JSON, ignore */
				}
			}
		} finally {
			try {
				await reader.cancel();
			} catch {
				/* harmless */
			}
		}
	}
}

async function safeText(res: Response): Promise<string> {
	try {
		const text = await res.text();
		return text.length > 1024 ? `${text.slice(0, 1024)}…` : text;
	} catch {
		return "<unreadable body>";
	}
}
