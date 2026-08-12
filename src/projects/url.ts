/**
 * Parse a GitHub URL into the `{owner, name}` pair warren uses to lay
 * out `/data/projects/<owner>/<name>` (docs/design/runtime-and-supervisor.md).
 *
 * Three accepted shapes — the operator pastes whichever GitHub UI gave
 * them:
 *   - `https://github.com/<owner>/<name>[.git]`
 *   - `git@github.com:<owner>/<name>[.git]`
 *   - `ssh://git@github.com/<owner>/<name>[.git]`
 *
 * The `.git` suffix and trailing slashes are stripped. `owner` and `name`
 * are validated against GitHub's character set (`[A-Za-z0-9._-]+`) and
 * explicitly forbidden from being `.`, `..`, or starting with `-`, so
 * the resulting on-disk path can't escape the projects root or shadow a
 * dotfile.
 *
 * Non-GitHub URLs (gitlab, self-hosted, file://) are rejected up-front:
 * V1 scope is "paste a GitHub URL" (ACCEPTANCE.md), and accepting other hosts
 * silently would let bad inputs flow into `git clone`.
 */

import { ValidationError } from "../core/errors.ts";
import type { Forge } from "../forge/contract.ts";

export interface ParsedGitHubUrl {
	readonly owner: string;
	readonly name: string;
}

const SEGMENT = /^[A-Za-z0-9._-]+$/;

export function parseGitHubUrl(input: string): ParsedGitHubUrl {
	const trimmed = input.trim();
	if (trimmed === "") {
		throw new ValidationError("gitUrl is empty", {
			recoveryHint: "pass a GitHub URL, e.g. https://github.com/owner/name",
		});
	}

	const segments = extractOwnerName(trimmed);
	if (segments === undefined) {
		throw new ValidationError(`unrecognized GitHub URL: ${trimmed}`, {
			recoveryHint:
				"use https://github.com/<owner>/<name>[.git] or git@github.com:<owner>/<name>[.git]",
		});
	}

	const owner = stripGitSuffix(segments.owner);
	const name = stripGitSuffix(segments.name);
	validateSegment(owner, "owner");
	validateSegment(name, "name");
	return { owner, name };
}

function extractOwnerName(url: string): { owner: string; name: string } | undefined {
	// scp-style: git@github.com:owner/name(.git)?
	const scp = /^git@github\.com:([^/]+)\/(.+?)\/?$/.exec(url);
	if (scp !== null) {
		return { owner: scp[1] as string, name: scp[2] as string };
	}

	// https or ssh (URL-parseable)
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return undefined;
	}
	const host = parsed.hostname.toLowerCase();
	const protocol = parsed.protocol;
	if (host !== "github.com") return undefined;
	if (protocol !== "https:" && protocol !== "http:" && protocol !== "ssh:") {
		return undefined;
	}
	const parts = parsed.pathname.split("/").filter((p) => p !== "");
	if (parts.length < 2) return undefined;
	return { owner: parts[0] as string, name: parts.slice(1).join("/") };
}

function stripGitSuffix(segment: string): string {
	return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

/**
 * Forge-owned fallback (warren-2600, falsification test 1): the github.com
 * grammars above are not the only clone URLs warren can host — the boot
 * forge decides OWNERSHIP (`parseRepoRef`), and a URL the forge owns but
 * `parseGitHubUrl` rejects (today: FakeForge's `fake://<owner>/<name>`)
 * still needs on-disk path segments for `/data/projects/<owner>/<name>`.
 *
 * The derivation here is LAYOUT-ONLY: the last two path segments after the
 * scheme, held to the same path-safety character set. The segments never
 * cross back into the forge — `RepoRef.key` stays forge-private per
 * forge-contract.md §0. Returns null when the forge disowns the URL or the
 * path can't supply two safe segments, so the caller can fall back to the
 * original validation error.
 */
export function parseForgeOwnedUrl(input: string, forge: Forge): ParsedGitHubUrl | null {
	const trimmed = input.trim();
	if (trimmed === "" || forge.parseRepoRef(trimmed) === null) return null;
	const withoutScheme = trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
	if (withoutScheme === trimmed) return null;
	const parts = withoutScheme.split("/").filter((p) => p !== "");
	if (parts.length < 2) return null;
	const owner = stripGitSuffix(parts[parts.length - 2] as string);
	const name = stripGitSuffix(parts[parts.length - 1] as string);
	if (!isSafeSegmentForPath(owner) || !isSafeSegmentForPath(name)) return null;
	return { owner, name };
}

/** Boolean twin of `validateSegment` for the null-returning fallback. */
function isSafeSegmentForPath(segment: string): boolean {
	return (
		segment !== "" &&
		segment !== "." &&
		segment !== ".." &&
		!segment.startsWith("-") &&
		SEGMENT.test(segment)
	);
}

function validateSegment(segment: string, label: string): void {
	if (segment === "" || segment === "." || segment === "..") {
		throw new ValidationError(`invalid ${label} in GitHub URL: ${JSON.stringify(segment)}`, {
			recoveryHint: "owner and repo name must be non-empty path segments",
		});
	}
	if (segment.startsWith("-")) {
		throw new ValidationError(`invalid ${label} in GitHub URL: ${JSON.stringify(segment)}`, {
			recoveryHint: "owner and repo name must not start with a dash",
		});
	}
	if (!SEGMENT.test(segment)) {
		throw new ValidationError(`invalid ${label} in GitHub URL: ${JSON.stringify(segment)}`, {
			recoveryHint: "owner and repo name may only contain letters, digits, '.', '_', '-'",
		});
	}
}
