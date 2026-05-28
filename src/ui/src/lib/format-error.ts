/*
 * formatError (warren-36f0 / pl-55a3 step 5):
 *
 * Single canonical formatter for the `unknown`-typed error values that
 * react-query exposes on `query.error` / `mutation.error`. The audit
 * (mx-search "instanceof Error" in src/ui) found the same
 * `err instanceof Error ? err.message : String(err)` ternary copy-pasted
 * across ~20 sites — Chat.tsx additionally peels a `{code, message}`
 * envelope off our `ApiError`-shaped throws (api/client.ts:767). This
 * helper consolidates both shapes so callers can write
 * `<Alert>{formatError(error)}</Alert>` instead of re-deriving the
 * ternary every time.
 *
 * Recognised shapes, in order:
 *   1. `{ code, message }` — our HTTP envelope (ApiError thrown by
 *      api/client.ts). Renders as "<code>: <message>" to match the
 *      Chat.tsx convention so the wire code stays visible for
 *      debugging.
 *   2. `Error` (or anything with a string `.message`) — render
 *      `.message`.
 *   3. `string` — return as-is.
 *   4. fallback — `String(err)`.
 *
 * Returns the empty string for `null` / `undefined` so callers can use
 * `formatError(err) || "Something went wrong."` for a default.
 */
export function formatError(err: unknown): string {
	if (err === null || err === undefined) return "";
	if (typeof err === "string") return err;
	if (typeof err === "object") {
		const e = err as { code?: unknown; message?: unknown };
		if (typeof e.code === "string" && typeof e.message === "string") {
			return `${e.code}: ${e.message}`;
		}
		if (typeof e.message === "string") return e.message;
	}
	return String(err);
}
