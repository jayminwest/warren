/**
 * `[workers]` block helpers (pl-9ba1 step 8 / warren-272c).
 *
 * The Zod schema (`schema.ts`) checks shape — every entry has a non-empty
 * `name` and `url` string. This module owns the cross-row + URL-format
 * checks that don't fit Zod cleanly:
 *
 *   - `parseWorkerUrl` accepts `unix:///path` or `http(s)://host:port` and
 *     returns the burrow `Transport` warren's `BurrowClient` consumes.
 *     The format mirrors `transportToUrl` in burrow-client/index.ts so a
 *     `[workers]` row round-trips through the worker row's `url` column.
 *   - `validateWorkerEntries` enforces name regex + uniqueness + URL
 *     parseability across the array. Failures collapse into a single
 *     message with a `workers[i].field` path so operators can fix the
 *     offending entry directly.
 *   - `requireSharedBurrowToken` is the acceptance-criterion #8 gate:
 *     when `[workers]` is non-empty, warren needs a bearer token to
 *     authenticate with every worker. Per-worker tokens were rejected
 *     (plan alternative #3) in favor of a single shared token. The
 *     supervisor (src/supervisor/tokens.ts) requires
 *     `BURROW_API_TOKEN == WARREN_BURROW_TOKEN`; the warren-server
 *     layer reads `WARREN_BURROW_TOKEN` (the client-side var) and
 *     surfaces a structured ValidationError if it is missing.
 */

import type { Transport } from "@os-eco/burrow-cli";
import { ValidationError } from "../core/errors.ts";
import type { EnvLike } from "./config.ts";
import type { WorkerEntry } from "./schema.ts";

export interface ParsedWorkerEntry {
	readonly name: string;
	readonly url: string;
	readonly transport: Transport;
}

export type ParseUrlResult =
	| { readonly ok: true; readonly transport: Transport }
	| { readonly ok: false; readonly message: string };

export const UNIX_URL_PREFIX = "unix://";

/**
 * Worker names double as path segments on `POST /workers/:name/drain`
 * and as `runs.worker_id` / `burrows.worker_id` row keys. Constrain to
 * `[A-Za-z0-9][A-Za-z0-9_-]*` so operators don't end up with workers
 * whose names need URL-encoding or shell-quoting in admin scripts.
 */
const WORKER_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Parse a worker URL string into a burrow `Transport`. Accepted shapes:
 *   unix:///absolute/path  → { kind: 'unix', path: '/absolute/path' }
 *   http://host:port       → { kind: 'tcp', hostname, port }
 *
 * Mirrors the inverse of `transportToUrl` in burrow-client/index.ts so a
 * worker row written by `BurrowClient.fromConfig` can be re-derived
 * from its stored `url` column with no other context. `https://` is not
 * accepted — burrow V1 binds plain HTTP on unix sockets or loopback TCP
 * inside a VPC; operator-supplied TLS is out of scope until a real
 * driver lands.
 */
export function parseWorkerUrl(raw: string): ParseUrlResult {
	if (raw.startsWith(UNIX_URL_PREFIX)) {
		const path = raw.slice(UNIX_URL_PREFIX.length);
		if (path === "") {
			return { ok: false, message: `unix:// URL has an empty path: ${JSON.stringify(raw)}` };
		}
		return { ok: true, transport: { kind: "unix", path } };
	}
	if (raw.startsWith("http://")) {
		let parsed: URL;
		try {
			parsed = new URL(raw);
		} catch {
			return { ok: false, message: `is not a valid URL: ${JSON.stringify(raw)}` };
		}
		if (parsed.pathname !== "" && parsed.pathname !== "/") {
			return { ok: false, message: `must not include a path: ${JSON.stringify(raw)}` };
		}
		if (parsed.search !== "" || parsed.hash !== "") {
			return {
				ok: false,
				message: `must not include a query string or fragment: ${JSON.stringify(raw)}`,
			};
		}
		const hostname = parsed.hostname;
		if (hostname === "") {
			return { ok: false, message: `is missing a hostname: ${JSON.stringify(raw)}` };
		}
		const portRaw = parsed.port;
		if (portRaw === "") {
			return { ok: false, message: `is missing a port: ${JSON.stringify(raw)}` };
		}
		// `new URL` already rejects ports outside 0..65535 with TypeError, but
		// `0` parses successfully — defensive bound here keeps the message
		// readable when an operator types it.
		const port = Number.parseInt(portRaw, 10);
		if (!Number.isInteger(port) || port <= 0 || port > 65535) {
			return {
				ok: false,
				message: `port must be an integer 1..65535: ${JSON.stringify(raw)}`,
			};
		}
		return { ok: true, transport: { kind: "tcp", hostname, port } };
	}
	return {
		ok: false,
		message: `must start with unix:// or http://: ${JSON.stringify(raw)}`,
	};
}

export type ValidateWorkersResult =
	| { readonly ok: true; readonly workers: readonly ParsedWorkerEntry[] }
	| { readonly ok: false; readonly message: string };

/**
 * Validate the raw `[workers]` array post-Zod: each `name` matches the
 * URL-safe regex, names are unique across the array, every `url` parses
 * to a `Transport`. Returns the parsed array (one `ParsedWorkerEntry`
 * per row) so the loader can hand burrow-client/index.ts a ready-to-bind
 * transport without re-parsing.
 */
export function validateWorkerEntries(entries: readonly WorkerEntry[]): ValidateWorkersResult {
	const seen = new Set<string>();
	const parsed: ParsedWorkerEntry[] = [];
	for (let i = 0; i < entries.length; i++) {
		const e = entries[i];
		if (e === undefined) continue;
		if (!WORKER_NAME_RE.test(e.name)) {
			return {
				ok: false,
				message: `workers[${i}].name ${JSON.stringify(e.name)} must match ${WORKER_NAME_RE.source} (letters, digits, '-', '_'; starts alphanumeric)`,
			};
		}
		if (seen.has(e.name)) {
			return {
				ok: false,
				message: `workers[${i}].name ${JSON.stringify(e.name)} is duplicated`,
			};
		}
		seen.add(e.name);
		const url = parseWorkerUrl(e.url);
		if (!url.ok) {
			return { ok: false, message: `workers[${i}].url ${url.message}` };
		}
		parsed.push({ name: e.name, url: e.url, transport: url.transport });
	}
	return { ok: true, workers: parsed };
}

/**
 * Env var warren reads to authenticate with every burrow worker (the
 * "send" side of the BURROW_API_TOKEN / WARREN_BURROW_TOKEN pair the
 * supervisor enforces — see src/supervisor/tokens.ts). One value shared
 * across the whole pool; per-worker tokens were rejected as plan
 * alternative #3.
 */
export const WARREN_BURROW_TOKEN_ENV = "WARREN_BURROW_TOKEN";

export const SHARED_BURROW_TOKEN_HINT =
	"Generate one secret and set both vars to it: TOKEN=$(openssl rand -hex 32); " +
	"export BURROW_API_TOKEN=$TOKEN WARREN_BURROW_TOKEN=$TOKEN. " +
	"Every worker in [workers] must run `burrow serve` with the same BURROW_API_TOKEN. " +
	"On Fly: fly secrets set BURROW_API_TOKEN=$TOKEN WARREN_BURROW_TOKEN=$TOKEN.";

/**
 * Acceptance criterion #8: when `[workers]` is non-empty, warren refuses
 * to start without the bearer token shared across the pool. The
 * supervisor separately requires `BURROW_API_TOKEN == WARREN_BURROW_TOKEN`
 * to be set + equal at boot; this call fails fast at the warren-server
 * layer when the var is missing entirely (e.g., warren deployed without
 * the matching supervisor, or running in a test harness that boots
 * `bootServer` directly).
 */
export function requireSharedBurrowToken(env: EnvLike): string {
	const token = env[WARREN_BURROW_TOKEN_ENV];
	if (token !== undefined && token !== "") return token;
	throw new ValidationError(`[workers] is configured but ${WARREN_BURROW_TOKEN_ENV} is unset`, {
		recoveryHint: SHARED_BURROW_TOKEN_HINT,
	});
}
