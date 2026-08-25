/**
 * GitHub coordinate and git-ref grammar validation (plan pl-91b6 step 2,
 * warren-5055). Shared by the campaign manifest (upstream + fork + branch)
 * and the repository policy (upstream). Everything here is pure string
 * grammar — no network, no secrets.
 */

/** `owner/repo` pair identifying a GitHub repository. */
export interface RepoCoordinates {
	owner: string;
	repo: string;
}

/**
 * GitHub user/org login: 1–39 chars, ASCII alphanumerics and hyphens, and
 * cannot begin or end with a hyphen.
 */
const OWNER_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;

/**
 * GitHub repository name: 1–100 chars from ASCII alphanumerics, `.`, `_`,
 * `-`; cannot begin or end with `.` or `-`.
 */
const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;

/** Is `owner` a syntactically valid GitHub login? */
export function isValidOwner(owner: string): boolean {
	return OWNER_PATTERN.test(owner);
}

/** Is `repo` a syntactically valid GitHub repository name? */
export function isValidRepo(repo: string): boolean {
	if (!REPO_PATTERN.test(repo)) return false;
	return !repo.endsWith(".git");
}

/**
 * Git refname grammar, aligned with `git check-ref-format` one-level rules:
 * non-empty, ≤255 bytes, no ASCII control, none of ` ~^:?*[\`, no `..`, no
 * `@{`, no empty or trailing-dslash components, no component starting with
 * `.`, no component ending in `.lock`, and no leading `-`.
 */
export function isValidRefName(ref: string): boolean {
	if (ref.length === 0 || ref.length > 255) return false;
	if (ref.startsWith("-") || ref.startsWith(".")) return false;
	if (ref.endsWith("/") || ref.endsWith(".")) return false;
	if (ref.includes("..") || ref.includes("@{") || ref.includes("//")) return false;
	return hasNoForbiddenCharacters(ref) && hasValidComponents(ref);
}

function hasNoForbiddenCharacters(ref: string): boolean {
	for (const ch of ref) {
		const code = ch.charCodeAt(0);
		if (code < 0x20 || code === 0x7f) return false;
		if (" ~^:?*[\\".includes(ch)) return false;
	}
	return true;
}

function hasValidComponents(ref: string): boolean {
	for (const part of ref.split("/")) {
		if (part.length === 0 || part.startsWith(".") || part.endsWith(".lock")) return false;
	}
	return true;
}

/** Validate a `{owner, repo}` pair, returning `null` on any grammar failure. */
export function checkRepoCoordinates(value: unknown): RepoCoordinates | null {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
	const record = value as Record<string, unknown>;
	const owner = record.owner;
	const repo = record.repo;
	if (typeof owner !== "string" || typeof repo !== "string") return null;
	if (!isValidOwner(owner) || !isValidRepo(repo)) return null;
	return { owner, repo };
}

/** Human-readable grammar hint reused by both schemas' error messages. */
export const REF_GRAMMAR_HINT =
	"a git refname: 1–255 bytes, no leading '-' or '.', no trailing '/' or '.', no '..'/'@{'/'//', no ' ~^:?*[\\' or control characters, and no '.lock' component";
