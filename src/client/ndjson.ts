import { WarrenClientError } from "./errors.ts";
import type { ApiErrorEnvelope } from "./types.ts";

/**
 * Shared NDJSON tail reader backing `WarrenClient.streamRunEvents` and
 * `WarrenClient.streamPlanRunEvents`. Given an `open` thunk that returns
 * the already-fetched `Response` (transport errors mapped by the
 * caller's `withTransportMapping`), it maps non-OK responses to
 * {@link WarrenClientError}, then yields one parsed `T` per `\n`
 * terminated line.
 *
 * Partial lines are buffered across reads, the trailing line (no
 * terminator) is flushed, and malformed lines are dropped silently —
 * best-effort by design, mirroring the UI consumer in
 * `src/ui/src/api/client.ts`.
 */
export async function* readNdjsonStream<T>(
	open: () => Promise<Response>,
): AsyncGenerator<T, void, void> {
	const res = await open();
	if (!res.ok) {
		throw await errorFromResponse(res);
	}
	if (res.body === null) return;

	const reader = res.body.getReader();
	const decoder = new TextDecoder();
	let buf = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buf += decoder.decode(value, { stream: true });
			let nl = buf.indexOf("\n");
			while (nl !== -1) {
				const line = buf.slice(0, nl);
				buf = buf.slice(nl + 1);
				if (line.length > 0) yield* parseLine<T>(line);
				nl = buf.indexOf("\n");
			}
		}
		const tail = buf.trim();
		if (tail.length > 0) yield* parseLine<T>(tail);
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// ignore — releaseLock can throw if we already errored out
		}
	}
}

/** Yield a parsed line, dropping it silently if it isn't valid JSON. */
function* parseLine<T>(line: string): Generator<T, void, void> {
	try {
		yield JSON.parse(line) as T;
	} catch {
		// drop malformed line; keep streaming
	}
}

/** Build a {@link WarrenClientError} from a non-OK NDJSON/JSON response. */
export async function errorFromResponse(res: Response): Promise<WarrenClientError> {
	let envelope: ApiErrorEnvelope | null = null;
	try {
		envelope = (await res.json()) as ApiErrorEnvelope;
	} catch {
		// Non-JSON or malformed body — fall through to the default code/message.
	}
	const code = envelope?.error?.code ?? `http_${res.status}`;
	const message = envelope?.error?.message ?? `warren request failed with status ${res.status}`;
	const hint = envelope?.error?.hint;
	return new WarrenClientError(res.status, code, message, hint);
}
