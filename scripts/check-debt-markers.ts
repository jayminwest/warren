#!/usr/bin/env bun
/**
 * Debt-marker scanner (warren-7f2b, plan pl-7b06 step 8).
 *
 * Walks every TypeScript file under `src/` and `scripts/` (excluding
 * `src/ui/`, `__golden__/`, and `node_modules/`) and flags any
 * `TODO` / `FIXME` / `HACK` / `XXX` marker that is not paired with a
 * tracker reference on the same line.
 *
 * A marker is considered "tracked" if its line also contains at least
 * one of:
 *
 *   - a seeds/mulch id: `warren-<hex>`, `pl-<hex>`, `mx-<hex>`
 *   - a GitHub-style issue ref: `#<digits>`
 *   - an http(s) URL
 *
 * Untracked markers must either be removed, paired with an id, or — as
 * an escape hatch — grandfathered in
 * `scripts/debt-marker-allowlist.json`. The allowlist is a frozen
 * ceiling: entries point at `path:line` and must match an existing
 * untracked marker. The ratchet only goes down — entries should be
 * removed as debt is paid off; new entries should be added only with
 * justification.
 *
 * Companion to scripts/check-file-sizes.ts; same ergonomics.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ALLOWLIST_PATH = resolve(REPO_ROOT, "scripts/debt-marker-allowlist.json");

const SCAN_ROOTS = ["src", "scripts"] as const;
const EXTENSIONS = [".ts", ".tsx"] as const;
const EXCLUDE_DIR_SEGMENTS = ["node_modules", "__golden__"] as const;
const EXCLUDE_PATH_PREFIXES = ["src/ui/"] as const;
// The scanner and its test naturally contain the marker tokens they
// hunt for. Exclude them to avoid self-reference false positives.
const EXCLUDE_PATH_EXACT: ReadonlySet<string> = new Set([
	"scripts/check-debt-markers.ts",
	"scripts/check-debt-markers.test.ts",
]);

// `\bXXX\b` does not match `XXXX` (no word boundary between consecutive
// X's), which is what we want — placeholder strings like `pl-XXXX` in
// docstrings are not debt markers.
const MARKER_RE = /\b(TODO|FIXME|HACK|XXX)\b/;
const TRACKER_RES: RegExp[] = [/\b(?:warren|pl|mx)-[0-9a-f]+\b/i, /#\d+\b/, /https?:\/\/\S+/];

type AllowlistFile = {
	allowlist: string[];
};

type AllowlistEntry = { path: string; line: number };

function loadAllowlist(): { entries: AllowlistEntry[]; raw: string[] } {
	if (!existsSync(ALLOWLIST_PATH)) return { entries: [], raw: [] };
	const raw = JSON.parse(readFileSync(ALLOWLIST_PATH, "utf8")) as Record<string, unknown>;
	const list = raw.allowlist;
	if (!Array.isArray(list)) {
		throw new Error(`${ALLOWLIST_PATH}: "allowlist" must be an array of "path:line" strings`);
	}
	const entries: AllowlistEntry[] = [];
	const rawStrings: string[] = [];
	for (const item of list) {
		if (typeof item !== "string") {
			throw new Error(`${ALLOWLIST_PATH}: allowlist entries must be strings ("path:line")`);
		}
		const idx = item.lastIndexOf(":");
		if (idx < 0) {
			throw new Error(`${ALLOWLIST_PATH}: "${item}" is not formatted as "path:line"`);
		}
		const path = item.slice(0, idx);
		const lineStr = item.slice(idx + 1);
		const line = Number.parseInt(lineStr, 10);
		if (!path || !Number.isInteger(line) || line <= 0) {
			throw new Error(`${ALLOWLIST_PATH}: "${item}" is not a valid "path:line" entry`);
		}
		entries.push({ path, line });
		rawStrings.push(item);
	}
	return { entries, raw: rawStrings };
}

function shouldExclude(relPath: string): boolean {
	if (EXCLUDE_PATH_EXACT.has(relPath)) return true;
	for (const prefix of EXCLUDE_PATH_PREFIXES) {
		if (relPath.startsWith(prefix)) return true;
	}
	return false;
}

function* walk(dir: string): Generator<string> {
	if (!existsSync(dir)) return;
	for (const entry of readdirSync(dir)) {
		if ((EXCLUDE_DIR_SEGMENTS as readonly string[]).includes(entry)) continue;
		const full = join(dir, entry);
		const st = statSync(full);
		if (st.isDirectory()) {
			yield* walk(full);
		} else if (st.isFile()) {
			yield full;
		}
	}
}

function isTsFile(name: string): boolean {
	return EXTENSIONS.some((ext) => name.endsWith(ext));
}

function lineHasTracker(line: string): boolean {
	for (const re of TRACKER_RES) {
		if (re.test(line)) return true;
	}
	return false;
}

export type Marker = { path: string; line: number; marker: string; text: string };

export function scan(): {
	untracked: Marker[];
	staleAllowlistEntries: string[];
	allowedSilenced: Marker[];
} {
	const { entries: allowlist, raw: rawAllowlist } = loadAllowlist();
	const allowSet = new Set(rawAllowlist);
	const matchedAllow = new Set<string>();

	const roots: string[] = [];
	for (const r of SCAN_ROOTS) roots.push(resolve(REPO_ROOT, r));

	const allFiles: string[] = [];
	for (const root of roots) {
		for (const f of walk(root)) allFiles.push(f);
	}

	const untracked: Marker[] = [];
	const allowedSilenced: Marker[] = [];

	for (const abs of allFiles) {
		const rel = relative(REPO_ROOT, abs).replaceAll("\\", "/");
		if (!isTsFile(rel)) continue;
		if (shouldExclude(rel)) continue;

		const content = readFileSync(abs, "utf8");
		const lines = content.split("\n");
		for (let i = 0; i < lines.length; i++) {
			const line = lines[i] ?? "";
			const match = line.match(MARKER_RE);
			if (!match) continue;
			if (lineHasTracker(line)) continue;
			const lineNo = i + 1;
			const key = `${rel}:${lineNo}`;
			const marker: Marker = {
				path: rel,
				line: lineNo,
				marker: match[1] ?? match[0],
				text: line.trim(),
			};
			if (allowSet.has(key)) {
				matchedAllow.add(key);
				allowedSilenced.push(marker);
			} else {
				untracked.push(marker);
			}
		}
	}

	const staleAllowlistEntries: string[] = [];
	for (const entry of allowlist) {
		const key = `${entry.path}:${entry.line}`;
		if (!matchedAllow.has(key)) staleAllowlistEntries.push(key);
	}

	return { untracked, staleAllowlistEntries, allowedSilenced };
}

function main(): void {
	const { untracked, staleAllowlistEntries } = scan();

	if (staleAllowlistEntries.length > 0) {
		console.error(
			"scripts/debt-marker-allowlist.json has entries that no longer match an untracked marker:",
		);
		for (const k of staleAllowlistEntries) console.error(`  - ${k}`);
		console.error("Remove these entries — the ratchet only goes down.");
		console.error("");
	}

	if (untracked.length > 0) {
		console.error("Untracked debt markers found:");
		for (const m of untracked) {
			console.error(`  ${m.path}:${m.line}  ${m.marker}: ${m.text}`);
		}
		console.error("");
		console.error(
			"Pair each marker with a tracker reference on the same line " +
				"(warren-XXXX / pl-XXXX / mx-XXXX / #NNN / URL), remove it, " +
				"or — only with justification — add it to scripts/debt-marker-allowlist.json.",
		);
		process.exit(1);
	}

	if (staleAllowlistEntries.length > 0) process.exit(1);

	console.log("Debt-marker guard ok.");
}

// Re-export the file shape so tests can spot-check the schema.
export type { AllowlistFile };

if (import.meta.main) main();
