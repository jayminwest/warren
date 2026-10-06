/**
 * `parseRepoRef` support for GitLab — the instance the arm is bound to,
 * the clone-URL grammars it owns, and the packed `RepoRef.key` shape.
 *
 * GitLab is self-hosted as often as not, so the arm answers for ONE
 * instance, named by `WARREN_GITLAB_URL` (default `https://gitlab.com`).
 * A URL on any other host is foreign and returns `null`, the same way the
 * GitHub arm disowns everything off `github.com`. An instance served under
 * a relative URL root (`https://example.com/gitlab`) keeps that root on the
 * web and https grammars; ssh paths never carry it.
 *
 * A GitLab project lives under a namespace of one or more groups
 * (`group/sub/project`). The full path packs into `key` as
 * `<host>/<namespace>/<project>` and only this arm unpacks it.
 *
 * Accepted grammars, for the configured host:
 *   - `https://<host>[/<root>]/<namespace>/<project>[.git]`
 *   - `git@<host>:<namespace>/<project>[.git]`
 *   - `ssh://git@<host>[:port]/<namespace>/<project>[.git]`
 *   - any web URL under the project, cut at the `/-/` route separator:
 *     `.../<project>/-/merge_requests/<n>` is how the CI-fixer hands a
 *     PR URL back.
 *
 * Everything here NEVER throws — a URL this forge does not own returns
 * `null` so the registry can try the next forge (§1.1).
 */

import type { RepoRef } from "../contract.ts";

/** Registry key this forge answers to (`FORGE_KINDS`). */
export const GITLAB_FORGE_KIND = "gitlab";

/** The instance a blank `WARREN_GITLAB_URL` resolves to. */
export const DEFAULT_GITLAB_URL = "https://gitlab.com";

/** The GitLab instance the arm is bound to, resolved once at boot. */
export interface GitLabInstance {
	/** Scheme and authority, e.g. `https://gitlab.example.com:8443`. */
	readonly origin: string;
	/** Lowercased `host[:port]`, compared against https clone URLs. */
	readonly host: string;
	/** Lowercased host without the port, compared against ssh clone URLs. */
	readonly hostname: string;
	/** Relative URL root without a trailing slash: `""` or `/gitlab`. */
	readonly basePath: string;
}

/** The unpacked project coordinate — provider-private. */
export interface GitLabCoordinate {
	/** Groups, outermost first. Never empty. */
	readonly namespace: readonly string[];
	readonly project: string;
}

/**
 * GitLab's own path rule for groups and projects: letters, digits, `_`,
 * `-` and `.`, never starting with `-`. The same set
 * `src/projects/url.ts` guards `/data/projects` with, so every accepted
 * segment is already path-safe.
 */
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

function isSegment(segment: string): boolean {
	return SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

/**
 * Parse `WARREN_GITLAB_URL` into an instance. `null` for anything that is
 * not an http(s) URL with a host, or that carries credentials, a query or
 * a fragment; the registry turns that into a boot-time `ForgeConfigError`.
 */
export function parseGitLabInstance(raw: string): GitLabInstance | null {
	let parsed: URL;
	try {
		parsed = new URL(raw.trim());
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	if (parsed.host === "" || parsed.username !== "" || parsed.password !== "") return null;
	if (parsed.search !== "" || parsed.hash !== "") return null;
	return {
		origin: parsed.origin,
		host: parsed.host.toLowerCase(),
		hostname: parsed.hostname.toLowerCase(),
		basePath: parsed.pathname.replace(/\/+$/, ""),
	};
}

/** Parse a clone or web URL on `instance` into this forge's opaque ref. */
export function parseGitLabRepoRef(instance: GitLabInstance, cloneUrl: string): RepoRef | null {
	const coordinate = parseGitLabCoordinate(instance, cloneUrl);
	if (coordinate === null) return null;
	return { forge: GITLAB_FORGE_KIND, key: `${instance.host}/${projectPath(coordinate)}` };
}

/** Unpack a key this arm produced into the project path. Only the provider calls this. */
export function unpackGitLabRef(ref: RepoRef): string {
	const slash = ref.key.indexOf("/");
	return slash === -1 ? "" : ref.key.slice(slash + 1);
}

/** The `namespace/project` path the API and the web routes address a project by. */
export function projectPath(c: GitLabCoordinate): string {
	return [...c.namespace, c.project].join("/");
}

/**
 * The on-disk layout for `/data/projects/<owner>/<name>` (`Forge.repoLayout`).
 * Every group folds into one owner segment, so `a/sub/app` and `b/sub/app`
 * never share a directory, which the last-two-segments default would do.
 *
 * The fold is injective. A literal `-` in a group doubles (`--`) before the
 * single-`-` join, so the group `a-b` and the nested `a/b` land on distinct
 * owners. The same rule the Azure DevOps arm folds org and project with.
 */
export function gitLabRepoLayout(
	instance: GitLabInstance,
	cloneUrl: string,
): { owner: string; name: string } | null {
	const coordinate = parseGitLabCoordinate(instance, cloneUrl);
	if (coordinate === null) return null;
	const owner = coordinate.namespace.map((group) => group.replace(/-/g, "--")).join("-");
	return { owner, name: coordinate.project };
}

/** Extract the coordinate from any accepted grammar; `null` when foreign. */
export function parseGitLabCoordinate(
	instance: GitLabInstance,
	input: string,
): GitLabCoordinate | null {
	const trimmed = input.trim();
	const scp = /^[^@\s/:]+@([^:\s/]+):\/?(.+)$/.exec(trimmed);
	if (scp !== null) {
		if ((scp[1] as string).toLowerCase() !== instance.hostname) return null;
		return fromPath(scp[2] as string);
	}

	let parsed: URL;
	try {
		parsed = new URL(trimmed);
	} catch {
		return null;
	}
	if (parsed.search !== "" || parsed.hash !== "") return null;
	if (parsed.protocol === "ssh:") {
		return parsed.hostname.toLowerCase() === instance.hostname ? fromPath(parsed.pathname) : null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	if (parsed.host.toLowerCase() !== instance.host) return null;
	const root = `${instance.basePath}/`;
	if (!parsed.pathname.startsWith(root)) return null;
	return fromPath(parsed.pathname.slice(root.length));
}

/**
 * `path` is `<namespace>/<project>[.git]`, optionally followed by a web
 * route after the `-` separator segment, which no group or project can be
 * named (a path never starts with `-`).
 */
function fromPath(path: string): GitLabCoordinate | null {
	const all = path.split("/").filter((p) => p !== "");
	const separator = all.indexOf("-");
	const parts = separator === -1 ? all : all.slice(0, separator);
	const last = parts.at(-1);
	if (parts.length < 2 || last === undefined) return null;
	const project = last.endsWith(".git") ? last.slice(0, -4) : last;
	const namespace = parts.slice(0, -1);
	if (!isSegment(project) || !namespace.every(isSegment)) return null;
	return { namespace, project };
}
