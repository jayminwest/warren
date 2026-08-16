/**
 * pi session-id recovery — source-lifted from burrow's `src/runtime/pi.ts`
 * (warren-7933, plan pl-3007).
 *
 * pi v0.74.0 does NOT emit the session id on `agent_end`; the only stable
 * surface is the `--session-dir` filesystem layout (per-session
 * `<ts>_<uuid>.jsonl`). `extractMetadata` reads the newest session file's
 * first line (a `{"type":"session","id":...}` envelope pi writes
 * synchronously on startup) and persists the UUID as `session_id` in the
 * run's metadata.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the session id from the newest `*.jsonl` in `sessionDir`. Pi writes
 * each session's UUID into the first line of the file as
 * `{"type":"session","version":N,"id":"<uuid>",...}` synchronously on
 * startup, so the file is guaranteed to exist with at least one line by
 * the time the agent has emitted any output. Returns `undefined` when the
 * directory is missing, empty, or the header line doesn't parse —
 * extraction is best-effort and the dispatcher swallows failures.
 *
 * Exported for unit tests.
 */
export function readNewestPiSessionId(sessionDir: string): string | undefined {
	if (!existsSync(sessionDir)) return undefined;
	let entries: string[];
	try {
		entries = readdirSync(sessionDir).filter((n) => n.endsWith(".jsonl"));
	} catch {
		return undefined;
	}
	if (entries.length === 0) return undefined;

	const newest = newestJsonlPath(sessionDir, entries);
	if (!newest) return undefined;
	return readSessionHeaderId(newest.path);
}

/**
 * Pick the most-recently-modified entry, skipping unreadable files.
 * Extracted from `readNewestPiSessionId` for the cognitive-complexity
 * budget (warren-7933) — the selection rule is verbatim burrow's.
 */
function newestJsonlPath(
	sessionDir: string,
	entries: readonly string[],
): { path: string; mtimeMs: number } | undefined {
	let newest: { path: string; mtimeMs: number } | undefined;
	for (const name of entries) {
		const path = join(sessionDir, name);
		try {
			const stat = statSync(path);
			if (newest === undefined || stat.mtimeMs > newest.mtimeMs) {
				newest = { path, mtimeMs: stat.mtimeMs };
			}
		} catch {
			// skip unreadable entries
		}
	}
	return newest;
}

/**
 * Read the session id off the file's first line. Returns `undefined` on
 * an unreadable file, an unparseable header, or a non-`session` envelope.
 */
function readSessionHeaderId(path: string): string | undefined {
	let body: string;
	try {
		body = readFileSync(path, "utf8");
	} catch {
		return undefined;
	}
	const firstNewline = body.indexOf("\n");
	const header = firstNewline === -1 ? body : body.slice(0, firstNewline);
	try {
		const parsed = JSON.parse(header) as { type?: string; id?: unknown };
		if (parsed.type !== "session") return undefined;
		return typeof parsed.id === "string" && parsed.id.length > 0 ? parsed.id : undefined;
	} catch {
		return undefined;
	}
}
