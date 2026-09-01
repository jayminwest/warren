/**
 * `parseRepoRef` support for Azure DevOps Repos — the clone-URL grammars
 * the arm owns and the packed `RepoRef.key` shape.
 *
 * An Azure DevOps repository is a three-part coordinate: organization,
 * project, repository. The contract's `RepoRef` stays two fields
 * (forge-contract.md §2): the triple packs into `key` as
 * `dev.azure.com/<org>/<project>/<repo>` and only this arm unpacks it.
 *
 * Accepted grammars:
 *   - `https://dev.azure.com/<org>/<project>/_git/<repo>`
 *   - `https://<org>@dev.azure.com/<org>/<project>/_git/<repo>` (the
 *     clone URL the Azure DevOps UI hands out)
 *   - `git@ssh.dev.azure.com:v3/<org>/<project>/<repo>`
 *   - `https://<org>.visualstudio.com/<project>/_git/<repo>` (legacy host)
 *   - `https://<org>.visualstudio.com/DefaultCollection/<project>/_git/<repo>`
 *   - the pull-request web URL of any of the above: `.../_git/<repo>/pullrequest/<n>`
 *
 * Everything here NEVER throws — a URL this forge does not own returns
 * `null` so the registry can try the next forge (§1.1).
 */

import { createHash } from "node:crypto";
import type { RepoRef } from "../contract.ts";

/** Registry key this forge answers to (`FORGE_KINDS`). */
export const ADO_FORGE_KIND = "ado";

/** Host every packed key and API call is anchored on. */
export const ADO_HOST = "dev.azure.com";

const KEY_PREFIX = `${ADO_HOST}/`;

/** The unpacked three-part coordinate — provider-private. */
export interface AdoCoordinate {
	readonly org: string;
	readonly project: string;
	readonly repo: string;
}

/**
 * The character set `src/projects/url.ts` guards `/data/projects` with.
 * Segments outside it still parse — Azure DevOps allows spaces and
 * punctuation in project and repository names — but `adoRepoLayout`
 * sanitizes them onto this set before they touch a filesystem path.
 */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

/**
 * Project and repository names travel URL-encoded in API paths, so both
 * are held to "printable, no slash". Organizations follow Azure DevOps'
 * own stricter rule (letters, digits, hyphen).
 */
const LOOSE_SEGMENT = /^[^/\\\s][^/\\]*$/;

const ORG_SEGMENT = /^[A-Za-z0-9-]+$/;

function isSafeSegment(segment: string): boolean {
	return (
		SAFE_SEGMENT.test(segment) && segment !== "." && segment !== ".." && !segment.startsWith("-")
	);
}

function isLooseSegment(segment: string): boolean {
	return LOOSE_SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

/** Parse a clone or pull-request URL into this forge's opaque ref. */
export function parseAdoRepoRef(cloneUrl: string): RepoRef | null {
	const coordinate = parseAdoCoordinate(cloneUrl);
	if (coordinate === null) return null;
	return { forge: ADO_FORGE_KIND, key: packKey(coordinate) };
}

/** Unpack a key this arm produced. Only the provider calls this. */
export function unpackAdoRef(ref: RepoRef): AdoCoordinate {
	const [org = "", project = "", repo = ""] = ref.key.slice(KEY_PREFIX.length).split("/");
	return { org, project: decodeURIComponent(project), repo: decodeURIComponent(repo) };
}

function packKey(c: AdoCoordinate): string {
	return `${KEY_PREFIX}${c.org}/${encodeURIComponent(c.project)}/${encodeURIComponent(c.repo)}`;
}

/**
 * The on-disk layout for `/data/projects/<owner>/<name>` (`Forge.repoLayout`).
 * The organization and project fold into one owner segment so two
 * repositories with the same name in different projects never collide.
 *
 * The fold is injective. A literal `-` in either part doubles (`--`)
 * before the single-`-` join, so `acme-web`/`app` and `acme`/`web-app`
 * land on distinct owners. A part outside the path-safe character set is
 * sanitized and suffixed with a short content hash, so `My Project` and
 * `My-Project` stay distinct too. A name already on the safe set keeps
 * its spelling.
 */
export function adoRepoLayout(cloneUrl: string): { owner: string; name: string } | null {
	const coordinate = parseAdoCoordinate(cloneUrl);
	if (coordinate === null) return null;
	const owner = `${escapeDashes(coordinate.org)}-${layoutPart(coordinate.project)}`;
	const name = isSafeSegment(coordinate.repo) ? coordinate.repo : layoutPart(coordinate.repo);
	if (!isSafeSegment(owner) || !isSafeSegment(name)) return null;
	return { owner, name };
}

function escapeDashes(part: string): string {
	return part.replace(/-/g, "--");
}

/** A path-safe stand-in for one coordinate part, injective across parts. */
function layoutPart(part: string): string {
	if (isSafeSegment(part) && SAFE_SEGMENT.test(part)) return escapeDashes(part);
	const sanitized = part.replace(/[^A-Za-z0-9._]+/g, "-").replace(/^[-.]+|[-.]+$/g, "");
	const digest = createHash("sha256").update(part).digest("hex").slice(0, 8);
	return sanitized === "" ? digest : `${sanitized}-${digest}`;
}

/** Extract the coordinate from any accepted grammar; `null` when foreign. */
export function parseAdoCoordinate(input: string): AdoCoordinate | null {
	const trimmed = input.trim();
	const scp =
		/^git@(?:ssh\.dev\.azure\.com|vs-ssh\.visualstudio\.com):v3\/([^/]+)\/([^/]+)\/([^/]+?)\/?$/.exec(
			trimmed,
		);
	if (scp !== null) {
		const project = safeDecode(scp[2] as string);
		if (project === null) return null;
		return finish(scp[1] as string, project, scp[3] as string);
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	const host = parsed.hostname.toLowerCase();
	const decoded = parsed.pathname
		.split("/")
		.filter((p) => p !== "")
		.map(safeDecode);
	if (decoded.some((p) => p === null)) return null;
	const parts = decoded as string[];

	if (host === ADO_HOST) return fromParts(parts[0], parts.slice(1));
	const legacy = /^([a-z0-9-]+)\.visualstudio\.com$/.exec(host);
	if (legacy !== null) {
		const rest = parts[0]?.toLowerCase() === "defaultcollection" ? parts.slice(1) : parts;
		return fromParts(legacy[1], rest);
	}
	return null;
}

/**
 * `rest` is `[<project>, "_git", <repo>]`, optionally followed by
 * `["pullrequest", <n>]` for a PR web URL.
 */
function fromParts(org: string | undefined, rest: string[]): AdoCoordinate | null {
	if (org === undefined) return null;
	const [project, marker, repoRaw, tail, tailArg] = rest;
	if (project === undefined || marker !== "_git" || repoRaw === undefined) return null;
	if (rest.length === 5) {
		if (tail !== "pullrequest" || !/^\d+$/.test(tailArg ?? "")) return null;
	} else if (rest.length !== 3) {
		return null;
	}
	return finish(org, project, stripGitSuffix(repoRaw));
}

function stripGitSuffix(segment: string): string {
	return segment.endsWith(".git") ? segment.slice(0, -4) : segment;
}

/** `null` for malformed percent-encoding: `parseRepoRef` never throws. */
function safeDecode(segment: string): string | null {
	try {
		return decodeURIComponent(segment);
	} catch {
		return null;
	}
}

function finish(org: string, project: string, repo: string): AdoCoordinate | null {
	if (!ORG_SEGMENT.test(org)) return null;
	if (!isLooseSegment(project) || !isLooseSegment(repo)) return null;
	return { org, project, repo };
}
