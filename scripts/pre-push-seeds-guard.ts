#!/usr/bin/env bun
/**
 * Pre-push seeds integrity gate (warren-53c0).
 *
 * Invoked by `scripts/hooks/pre-push`. Reads the standard git pre-push
 * stdin protocol (one `<local-ref> <local-oid> <remote-ref> <remote-oid>`
 * line per updated ref) and, when any `.seeds/*.jsonl` path appears in the
 * pushed range, runs `check:seeds-integrity` against the issues.jsonl blob
 * at the local tip being pushed — not the worktree — so a dirty or
 * divergent checkout cannot smuggle a corrupt queue past the gate.
 *
 * A push that does not touch `.seeds/*.jsonl` exits 0 without spawning the
 * checker, so ordinary code pushes stay fast. Branch deletes are skipped.
 *
 * Pure helpers below are unit-tested; the git I/O lives in `main` only.
 */

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const REPO_ROOT = resolve(import.meta.dir, "..");
const ZERO_OID = "0000000000000000000000000000000000000000";
const SEEDS_JSONL_RE = /^\.seeds\/[^/]+\.jsonl$/;

/** Env keys stripped, mirrored from scripts/hooks/pre-commit (warren-8664). */
const STRIPPED_GIT_KEYS = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_PREFIX"] as const;

export interface PushRef {
	readonly localRef: string;
	readonly localOid: string;
	readonly remoteRef: string;
	readonly remoteOid: string;
}

/** Parse one pre-push stdin line. Returns null for blank / malformed input. */
export function parsePushLine(line: string): PushRef | null {
	const trimmed = line.trim();
	if (trimmed === "") return null;
	const parts = trimmed.split(/\s+/);
	if (parts.length < 4) return null;
	const [localRef, localOid, remoteRef, remoteOid] = parts;
	if (
		localRef === undefined ||
		localOid === undefined ||
		remoteRef === undefined ||
		remoteOid === undefined
	) {
		return null;
	}
	return { localRef, localOid, remoteRef, remoteOid };
}

/**
 * Build the git revision range covering commits being pushed.
 * Returns null for a branch delete (nothing to inspect).
 * A new branch (remote oid all-zeros) returns just the local tip; the
 * caller diffs that tip against an empty tree.
 */
export function buildDiffRange(ref: PushRef, zeroOid: string = ZERO_OID): string | null {
	if (ref.localOid === zeroOid) return null;
	if (ref.remoteOid === zeroOid) return ref.localOid;
	return `${ref.remoteOid}..${ref.localOid}`;
}

/** True when a path is a top-level `.seeds/*.jsonl` file. */
export function isSeedsJsonlPath(path: string): boolean {
	return SEEDS_JSONL_RE.test(path);
}

/** True when any of the changed paths is a seeds JSONL queue file. */
export function seedsTouched(paths: readonly string[]): boolean {
	return paths.some(isSeedsJsonlPath);
}

/** Drop GIT_* keys rather than setting them to undefined/"" — both break git. */
function strippedEnv(): NodeJS.ProcessEnv {
	const env = { ...process.env };
	for (const key of STRIPPED_GIT_KEYS) {
		delete env[key];
	}
	return env;
}

function git(args: readonly string[]): { ok: boolean; stdout: string; stderr: string } {
	const res = spawnSync("git", args, {
		cwd: REPO_ROOT,
		encoding: "utf8",
		// issues.jsonl is multi-MB; the default 1 MiB maxBuffer ENOBUFSs it.
		maxBuffer: 32 * 1024 * 1024,
		env: strippedEnv(),
	});
	if (res.error) {
		return { ok: false, stdout: res.stdout ?? "", stderr: res.error.message };
	}
	return {
		ok: res.status === 0,
		stdout: res.stdout ?? "",
		stderr: res.stderr ?? "",
	};
}

function splitPaths(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((l) => l.trim())
		.filter((l) => l !== "");
}

/** Paths changed in the push range for one ref update. */
export function listChangedPaths(
	ref: PushRef,
	runGit: typeof git = git,
	zeroOid: string = ZERO_OID,
): string[] {
	const range = buildDiffRange(ref, zeroOid);
	if (range === null) return [];
	if (ref.remoteOid === zeroOid) {
		// New branch: every path at the tip counts as "in the pushed range".
		// Empty tree via git's well-known empty-tree OID (git hash-object -t
		// tree /dev/null) so we do not need a working tree.
		const emptyTree = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
		const diff = runGit([
			"diff-tree",
			"--no-commit-id",
			"--name-only",
			"-r",
			emptyTree,
			ref.localOid,
		]);
		if (!diff.ok) return [];
		return splitPaths(diff.stdout);
	}
	const diff = runGit(["diff", "--name-only", range]);
	if (!diff.ok) return [];
	return splitPaths(diff.stdout);
}

/** Run check:seeds-integrity against the issues.jsonl blob at `oid`. */
function checkIssuesAtOid(oid: string): number {
	const show = git(["show", `${oid}:.seeds/issues.jsonl`]);
	if (!show.ok) {
		// File absent at the tip — nothing to scan.
		if (show.stderr.includes("does not exist")) return 0;
		console.error(`pre-push: could not read .seeds/issues.jsonl at ${oid}:\n${show.stderr}`);
		return 1;
	}
	const check = spawnSync("bun", ["run", "scripts/check-seeds-integrity.ts", "--stdin"], {
		cwd: REPO_ROOT,
		encoding: "utf8",
		input: show.stdout,
		maxBuffer: 32 * 1024 * 1024,
		env: strippedEnv(),
	});
	if (check.stdout) process.stdout.write(check.stdout);
	if (check.stderr) process.stderr.write(check.stderr);
	return check.status === 0 ? 0 : (check.status ?? 1);
}

function main(): void {
	let input = "";
	try {
		input = readFileSync(0, "utf8");
	} catch {
		// No stdin — nothing to check.
		process.exit(0);
	}
	for (const line of input.split("\n")) {
		const ref = parsePushLine(line);
		if (ref === null) continue;
		if (buildDiffRange(ref) === null) continue;
		const paths = listChangedPaths(ref);
		if (!seedsTouched(paths)) continue;
		console.error(
			`pre-push: .seeds/*.jsonl in range for ${ref.localRef} — running check:seeds-integrity`,
		);
		const code = checkIssuesAtOid(ref.localOid);
		if (code !== 0) {
			console.error(
				"pre-push: refusing push — .seeds/issues.jsonl at the pushed tip fails " +
					"check:seeds-integrity. Deduplicate contradictory rows before pushing " +
					"(see warren-53c0 / warren-a71f).",
			);
			process.exit(code);
		}
	}
}

if (import.meta.main) main();
