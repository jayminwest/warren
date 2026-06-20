/**
 * Resolve a seed's `extensions.repo` to a registered warren project id
 * (cross-repo plan-runs, pl-fb43 step 2).
 *
 * A child seed names its *execution* repo with `extensions.repo` — either
 * a project slug (`owner/name` or a bare `name`) or a git remote URL in
 * any of the GitHub shapes warren already accepts (https / ssh / scp,
 * with or without a trailing `.git`). This module maps that free-form
 * reference back to one of the projects warren has cloned, so the
 * dispatcher can pick the right workspace without any clone or git I/O —
 * it is a pure lookup over `repos.projects.listAll()`.
 *
 * Matching is case-insensitive and normalizes every candidate to its
 * canonical `owner/name` slug. A bare `name` also matches a project whose
 * repo name is unique across the registry. Anything that resolves to zero
 * (or an ambiguous bare-name) match raises `TargetProjectUnresolvedError`,
 * which joins the projects-module error family so callers can route it to
 * the plan-failed path.
 */

import type { ProjectsRepo } from "../db/repos/projects.ts";
import { TargetProjectUnresolvedError } from "./errors.ts";
import { parseGitHubUrl } from "./url.ts";

/** Minimal repos surface this resolver needs — just the projects list. */
export interface ResolveTargetRepos {
	readonly projects: Pick<ProjectsRepo, "listAll">;
}

interface NormalizedRef {
	/** Canonical `owner/name`, lowercased, when both parts are known. */
	readonly slug: string | undefined;
	/** Bare repo name, lowercased — always present. */
	readonly name: string;
}

function stripGitSuffix(value: string): string {
	return value.endsWith(".git") ? value.slice(0, -4) : value;
}

/**
 * Reduce a repo reference (slug or git URL) to its comparable parts.
 * Returns `undefined` only for an empty input.
 */
function normalizeRef(repoRef: string): NormalizedRef | undefined {
	const trimmed = repoRef.trim().replace(/\/+$/, "");
	if (trimmed === "") return undefined;

	// Try the git-URL shapes first (https / ssh / scp, trailing `.git`).
	try {
		const { owner, name } = parseGitHubUrl(trimmed);
		return { slug: `${owner}/${name}`.toLowerCase(), name: name.toLowerCase() };
	} catch {
		// Not a URL — fall through to slug handling.
	}

	const slugBody = stripGitSuffix(trimmed);
	const parts = slugBody.split("/").filter((p) => p !== "");
	if (parts.length >= 2) {
		const owner = parts[parts.length - 2] as string;
		const name = parts[parts.length - 1] as string;
		return { slug: `${owner}/${name}`.toLowerCase(), name: name.toLowerCase() };
	}
	if (parts.length === 1) {
		return { slug: undefined, name: (parts[0] as string).toLowerCase() };
	}
	return undefined;
}

function projectSlug(gitUrl: string): NormalizedRef | undefined {
	try {
		const { owner, name } = parseGitHubUrl(gitUrl);
		return { slug: `${owner}/${name}`.toLowerCase(), name: name.toLowerCase() };
	} catch {
		return undefined;
	}
}

/**
 * Map a seed's `extensions.repo` to a registered project id.
 *
 * @throws TargetProjectUnresolvedError when no project matches, the ref is
 *   empty, or a bare repo name matches more than one project.
 */
export async function resolveTargetProject(
	repos: ResolveTargetRepos,
	repoRef: string,
): Promise<string> {
	const ref = normalizeRef(repoRef);
	if (ref === undefined) {
		throw new TargetProjectUnresolvedError(`empty repo reference: ${JSON.stringify(repoRef)}`, {
			recoveryHint: "set extensions.repo to a project slug or git remote URL",
		});
	}

	const projects = await repos.projects.listAll();

	if (ref.slug !== undefined) {
		const bySlug = projects.find((p) => projectSlug(p.gitUrl)?.slug === ref.slug);
		if (bySlug) return bySlug.id;
	} else {
		const byName = projects.filter((p) => projectSlug(p.gitUrl)?.name === ref.name);
		if (byName.length === 1) return (byName[0] as (typeof byName)[number]).id;
		if (byName.length > 1) {
			throw new TargetProjectUnresolvedError(
				`ambiguous repo name ${JSON.stringify(repoRef)}: matches ${byName.length} projects`,
				{ recoveryHint: "use the full owner/name slug or git remote URL" },
			);
		}
	}

	throw new TargetProjectUnresolvedError(
		`no registered project matches repo reference ${JSON.stringify(repoRef)}`,
		{ recoveryHint: "register the repo as a warren project, or fix extensions.repo" },
	);
}
