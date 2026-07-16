/**
 * Errors specific to talking to burrow over its HTTP API.
 *
 * The base `@os-eco/burrow-cli` `HttpClient` already rehydrates the
 * `{error: {code, message, hint}}` envelope into typed `BurrowError`
 * subclasses (see burrow's lib/http-client.ts `rehydrateError`). Warren
 * lets those flow through to callers untouched — they carry the right
 * status semantics for the warren HTTP server's own error envelope to
 * forward.
 *
 * `BurrowUnreachableError` is the only category the facade *adds*: a
 * transport-layer failure (socket missing, connection refused, fetch
 * timeout) that the HttpClient surfaces as an unstructured `Error`.
 * Catching it lets warren's HTTP layer return a 503 with an actionable
 * hint instead of a raw stack trace.
 *
 * It is the LocalProvider's concrete form of the provider-neutral
 * `RuntimeUnreachableError` (warren-36cb): the HTTP layer catches the neutral
 * base (so `src/server/errors.ts` never imports this burrow-client class), while
 * this subclass keeps its own `burrow_unreachable` code so the rendered envelope
 * is unchanged.
 */

import { RuntimeUnreachableError } from "../runtime/errors.ts";

export class BurrowUnreachableError extends RuntimeUnreachableError {
	override readonly code = "burrow_unreachable";
}
