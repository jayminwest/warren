/**
 * Public-instance allowlist (warren-ce9b / pl-b82d step 17, widened to
 * repo granularity by warren-1841).
 *
 * `WARREN_AUTH=public` admits credential-less spectators to the public
 * projection of every project on the instance (`src/server/auth.ts`). The
 * redaction work that precedes it (warren-946f / 4f6c / 1cb7) is a field
 * allowlist per response; this module is the STRUCTURAL half — if the only
 * repos that can ever be registered are public ones, a redaction miss
 * discloses already-public content instead of a private repo's source,
 * prompts, or transcripts.
 *
 * `WARREN_PUBLIC_ALLOWLIST` is a comma-separated list whose entries are
 * EITHER a bare GitHub owner (`os-eco`) or one specific repo
 * (`some-owner/some-repo`). Both shapes may appear in the same list. It is
 * consulted ONLY under `WARREN_AUTH=public` (token mode is entirely
 * unaffected — `resolvePublicAllowlist` returns `undefined` and every
 * assertion below is a no-op). Two enforcement points:
 *
 *   - **boot** (`bootServer`) — the list is parsed before the db opens,
 *     then every already-registered project is held to it. A project
 *     outside the allowlist refuses the boot, naming the offenders, rather
 *     than serving them anonymously for however long nobody notices.
 *   - **registration** (`POST /projects`) — a non-allowlisted repo is a
 *     `ValidationError` → HTTP 400, raised before `addProject` so nothing
 *     is cloned.
 *
 * Fail closed, three ways: public mode with an absent or empty allowlist
 * refuses the boot (an empty list is a misconfiguration, never "allow
 * everything"); a db row whose `gitUrl` no longer parses counts as NOT
 * allowlisted; and the selector that reaches here can never resolve to
 * `public` by accident (see `resolveAuthKind`).
 *
 * **Why repo entries exist.** The original design admitted bare owners
 * only, reasoning that an operator should "put an org on the list only
 * when every repo in it is one you are happy to publish". That premise
 * silently fails whenever the owner is a personal account, which is the
 * common case: a personal account nearly always holds private work
 * alongside whatever is being demoed, so an owner entry admits every one
 * of those private repos and the boot assertion meant to catch exactly
 * that passes clean. Owner entries remain, because they are the right
 * tool for a dedicated org whose contents are uniformly public. They are
 * no longer the only tool.
 *
 * **Tradeoff retained (deliberate):** neither entry shape asks the forge
 * whether a repo is really public. That would put a network call on
 * `POST /projects` (and on boot, for the already-registered sweep) that
 * can fail, rate-limit, or need credentials warren does not otherwise
 * require to add a public repo. The list stays offline and deterministic:
 * it cannot wedge a boot on a GitHub outage, and it keeps the operator's
 * responsibility legible. A repo entry simply lets that responsibility be
 * discharged precisely instead of wholesale.
 *
 * Comparison is case-insensitive (GitHub owners and names are), matched
 * against what `parseGitHubUrl` extracts — so the allowlist is checked
 * against the same strings the on-disk layout uses, not against raw URL
 * text a caller controls. Repo entries are themselves validated by routing
 * them through `parseGitHubUrl`, so a `.git` suffix is tolerated and this
 * module can never disagree with registration about what a legal
 * owner/name pair is.
 */

import { ValidationError, WarrenError } from "../core/errors.ts";
import { parseGitHubUrl } from "../projects/url.ts";
import type { AuthKind } from "./auth.ts";

export const WARREN_PUBLIC_ALLOWLIST_ENV = "WARREN_PUBLIC_ALLOWLIST" as const;

/**
 * Pre-warren-1841 name, when the list held owners only. Still read, so an
 * operator who copied it out of `.env.example` is not silently switched to
 * "no allowlist" — which under public mode refuses the boot outright.
 * Mirrors the `.warren/defaults.json` → `config.yaml` deprecation.
 */
export const LEGACY_PUBLIC_ORG_ALLOWLIST_ENV = "WARREN_PUBLIC_ORG_ALLOWLIST" as const;

export type EnvLike = Readonly<Record<string, string | undefined>>;

/**
 * What a public instance may hold. Two sets rather than one, so an entry's
 * granularity survives parsing: `owners` admits everything beneath it,
 * `repos` admits exactly itself. `ReadonlySet` rather than arrays so the
 * membership tests cannot drift into a substring match down the line.
 */
export interface PublicAllowlist {
	/** Bare-owner entries, lowercased. Every repo under these is admitted. */
	readonly owners: ReadonlySet<string>;
	/** `owner/name` entries, lowercased. Exactly these repos are admitted. */
	readonly repos: ReadonlySet<string>;
}

/** Same character set `parseGitHubUrl` validates an owner against. */
const OWNER = /^[A-Za-z0-9._-]+$/;

/**
 * Public mode is misconfigured, or an already-registered project falls
 * outside the allowlist. Only ever thrown at boot — there is no HTTP
 * status for it because the process refuses to start.
 */
export class PublicAllowlistError extends WarrenError {
	readonly code = "public_allowlist_invalid";
}

/** Canonical key for a repo entry. */
function repoKey(owner: string, name: string): string {
	return `${owner.trim().toLowerCase()}/${name.trim().toLowerCase()}`;
}

function invalidEntry(entry: string, why: string): PublicAllowlistError {
	return new PublicAllowlistError(
		`${WARREN_PUBLIC_ALLOWLIST_ENV} entry ${JSON.stringify(entry)} ${why}`,
		{
			recoveryHint:
				"each entry is either a bare owner (my-org) or one repo (some-owner/some-repo) — not a URL, and not owner/name/extra",
		},
	);
}

/**
 * Read the raw list, preferring the current env name. Returns the value
 * and which name supplied it, so the caller can deprecate the legacy one
 * without a second lookup.
 */
function readRawAllowlist(env: EnvLike): { raw: string; source: string } {
	const current = env[WARREN_PUBLIC_ALLOWLIST_ENV];
	if (current !== undefined && current.trim() !== "") {
		return { raw: current, source: WARREN_PUBLIC_ALLOWLIST_ENV };
	}
	const legacy = env[LEGACY_PUBLIC_ORG_ALLOWLIST_ENV];
	if (legacy !== undefined && legacy.trim() !== "") {
		return { raw: legacy, source: LEGACY_PUBLIC_ORG_ALLOWLIST_ENV };
	}
	return { raw: "", source: WARREN_PUBLIC_ALLOWLIST_ENV };
}

/**
 * Parse the allowlist. Absent, blank, or all-empty-entries throws — public
 * mode with no allowlist is the misconfiguration this whole module exists
 * to refuse, so it must never mean "allow everything".
 */
export function loadPublicAllowlistFromEnv(
	env: EnvLike = process.env,
	warn: (message: string) => void = console.warn,
): PublicAllowlist {
	const { raw, source } = readRawAllowlist(env);
	if (source === LEGACY_PUBLIC_ORG_ALLOWLIST_ENV) {
		warn(
			`${LEGACY_PUBLIC_ORG_ALLOWLIST_ENV} is deprecated — rename it to ${WARREN_PUBLIC_ALLOWLIST_ENV}. It now accepts owner/repo entries (e.g. some-owner/some-repo), not owners only.`,
		);
	}
	const entries = raw
		.split(",")
		.map((entry) => entry.trim())
		.filter((entry) => entry !== "");
	if (entries.length === 0) {
		throw new PublicAllowlistError(
			`WARREN_AUTH=public requires a non-empty ${WARREN_PUBLIC_ALLOWLIST_ENV}`,
			{
				recoveryHint: `export ${WARREN_PUBLIC_ALLOWLIST_ENV}=<owner>|<owner>/<repo>[,...] — the GitHub owners and repos this public instance may hold`,
			},
		);
	}

	const owners = new Set<string>();
	const repos = new Set<string>();
	for (const entry of entries) {
		const slashes = entry.split("/").length - 1;
		if (slashes === 0) {
			if (!OWNER.test(entry) || entry.startsWith("-")) {
				throw invalidEntry(entry, "is not a GitHub owner");
			}
			owners.add(entry.toLowerCase());
			continue;
		}
		if (slashes > 1) {
			throw invalidEntry(entry, "has too many path segments");
		}
		// Route repo entries through the parser registration itself uses, so
		// the two can never disagree about what a legal owner/name pair is.
		// It also gives `.git` stripping and the `.`/`..`/leading-dash
		// rejections for free.
		let parsed: { owner: string; name: string };
		try {
			parsed = parseGitHubUrl(`https://github.com/${entry}`);
		} catch {
			throw invalidEntry(entry, "is not a GitHub owner/repo pair");
		}
		repos.add(repoKey(parsed.owner, parsed.name));
	}
	return { owners, repos };
}

/**
 * The allowlist this process enforces, or `undefined` when it enforces
 * none. Called once at boot: `public` parses the env (throwing on a
 * missing/empty list), every other backend opts out entirely.
 */
export function resolvePublicAllowlist(
	kind: AuthKind,
	env: EnvLike = process.env,
): PublicAllowlist | undefined {
	return kind === "public" ? loadPublicAllowlistFromEnv(env) : undefined;
}

/**
 * Is this repo admitted? An owner entry admits every repo beneath it, a
 * repo entry admits only itself. Case-insensitive, whole-segment match.
 */
export function isRepoAllowlisted(
	allowlist: PublicAllowlist,
	owner: string,
	name: string,
): boolean {
	if (allowlist.owners.has(owner.trim().toLowerCase())) return true;
	return allowlist.repos.has(repoKey(owner, name));
}

/**
 * Would `gitUrl` be allowed? A url that doesn't parse is NOT allowed —
 * a tampered or legacy db row must not slip through on a parse failure.
 */
function isGitUrlAllowlisted(allowlist: PublicAllowlist, gitUrl: string): boolean {
	try {
		const { owner, name } = parseGitHubUrl(gitUrl);
		return isRepoAllowlisted(allowlist, owner, name);
	} catch {
		return false;
	}
}

/**
 * Registration gate for `POST /projects`. `allowlist === undefined` (token
 * mode) is a no-op, so the fresh-install path is untouched. Throws
 * `ValidationError` → HTTP 400; call it BEFORE `addProject` so a refused
 * repo never reaches `git clone`.
 */
export function assertGitUrlAllowlisted(
	allowlist: PublicAllowlist | undefined,
	gitUrl: string,
): void {
	if (allowlist === undefined) return;
	// Parse outside the try/catch of `isGitUrlAllowlisted`: an unparseable
	// url here is the caller's own bad input and deserves its own message.
	const { owner, name } = parseGitHubUrl(gitUrl);
	if (isRepoAllowlisted(allowlist, owner, name)) return;
	throw new ValidationError(`"${owner}/${name}" is not on this public instance's allowlist`, {
		recoveryHint: `this instance may only hold: ${formatAllowlist(allowlist)} — add the owner or the repo to ${WARREN_PUBLIC_ALLOWLIST_ENV} and restart, or register it on a token-mode instance`,
	});
}

/** The subset of a project row this module needs — the whole `ProjectRow` is overkill. */
export interface RegisteredProjectOrigin {
	readonly id: string;
	readonly gitUrl: string;
}

/**
 * Boot gate. Refuses to start when any already-registered project falls
 * outside the allowlist, naming every offender so the operator can delete
 * or re-scope them in one pass instead of one restart per project.
 * `allowlist === undefined` (token mode) is a no-op.
 */
export function assertRegisteredProjectsAllowlisted(
	allowlist: PublicAllowlist | undefined,
	projects: readonly RegisteredProjectOrigin[],
): void {
	if (allowlist === undefined) return;
	const offending = projects.filter((project) => !isGitUrlAllowlisted(allowlist, project.gitUrl));
	if (offending.length === 0) return;
	const named = offending.map((project) => `${project.id} (${project.gitUrl})`).join(", ");
	throw new PublicAllowlistError(
		`WARREN_AUTH=public but ${offending.length} registered project(s) fall outside ${WARREN_PUBLIC_ALLOWLIST_ENV}: ${named}`,
		{
			recoveryHint: `allowed: ${formatAllowlist(allowlist)} — DELETE /projects/:id for each offender, or widen ${WARREN_PUBLIC_ALLOWLIST_ENV}, then restart`,
		},
	);
}

function formatAllowlist(allowlist: PublicAllowlist): string {
	return [...allowlist.owners, ...allowlist.repos].sort().join(", ");
}
