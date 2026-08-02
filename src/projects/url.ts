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
