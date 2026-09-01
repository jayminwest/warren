/**
 * Bulk project registration against a running warren (warren-1841).
 *
 * The public-launch checkpoint cuts over to a fresh, empty database, which
 * drops every registered project. Re-registering by hand is slow (each
 * `POST /projects` performs a real `git clone`) and, worse, not repeatable —
 * a half-finished click-through leaves nobody able to say which repos landed.
 * This script is the repeatable half.
 *
 * Idempotent by construction, which is the property that matters when a
 * clone times out halfway through a batch: it reads `GET /projects` first
 * and skips anything already registered, so a re-run resumes instead of
 * failing on duplicates. It also treats warren's own "project already
 * exists" 400 as a skip rather than an error, which covers the gap between
 * the listing and the write.
 *
 * The agent registry is entirely inline now (`BUILTIN_AGENTS` boot-seeded,
 * pl-3a79), so registration is a single `POST /projects` — the per-project
 * `POST /projects/:id/agents/refresh` follow-up this script used to make
 * went away with canopy, and no route serves it.
 *
 * Usage:
 *   WARREN_URL=... WARREN_API_TOKEN=... \
 *     bun run scripts/register-projects.ts https://github.com/owner/name ...
 *   ... bun run scripts/register-projects.ts --from repos.txt
 *   ... bun run scripts/register-projects.ts --dry-run <urls>
 *
 * Repos are always supplied by the caller. There is no built-in list —
 * this script ships in every warren checkout, so a default manifest would
 * be one deployment's repos hardcoded into everyone else's.
 *
 * `WARREN_URL` is deliberately required with no default — this script
 * mutates whatever instance it is pointed at, and a default would eventually
 * point it at production by accident.
 */

import { parseAdoCoordinate } from "../src/forge/ado/repo-ref.ts";
import { parseGitHubUrl } from "../src/projects/url.ts";

/**
 * Client-side budget for one registration. The server's own clone timeout
 * is 120s (DEFAULT_GIT_TIMEOUT_MS); this sits above it so a slow clone is
 * reported by warren as a real error rather than severed by the client.
 */
const REGISTER_TIMEOUT_MS = 180_000;
const DEFAULT_TIMEOUT_MS = 30_000;

export interface Args {
	readonly repos: readonly string[];
	readonly dryRun: boolean;
	/** Path passed to `--from`, if any. Read by the caller (keeps this pure). */
	readonly fromFile?: string;
}

/**
 * Repos come from the caller — as arguments or via `--from <file>` — and
 * there is no built-in list. A default manifest here would be one
 * deployment's repos hardcoded into everyone else's checkout.
 */
export function parseArgs(argv: readonly string[]): Args {
	const dryRun = argv.includes("--dry-run");
	const repos: string[] = [];
	let fromFile: string | undefined;
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i] as string;
		if (arg === "--from") {
			fromFile = argv[i + 1];
			i++;
			continue;
		}
		if (!arg.startsWith("--")) repos.push(arg);
	}
	return { repos, dryRun, ...(fromFile !== undefined ? { fromFile } : {}) };
}

/** Parse a `--from` file: one repo URL per line, `#` comments and blanks ignored. */
export function parseRepoFile(contents: string): readonly string[] {
	return contents
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "" && !line.startsWith("#"));
}

/**
 * Identity for dedupe: lowercased `owner/name`.
 *
 * Deliberately stricter than warren's own check. `findByGitUrl` is an exact
 * string match, so `.../warren` and `.../warren.git` are two different rows
 * to it — registering both would clone the same repo twice. Comparing on
 * the parsed owner/name means this script refuses to do that regardless of
 * which spelling the manifest and the database each happen to use.
 */
export function repoKey(gitUrl: string): string {
	try {
		const { owner, name } = parseGitHubUrl(gitUrl);
		return `${owner.toLowerCase()}/${name.toLowerCase()}`;
	} catch {
		// An Azure DevOps row keys on its coordinate, so every accepted
		// grammar of the same repository (https, ssh, legacy host) dedupes
		// to one key. Anything else falls back to the normalized raw URL.
		const coordinate = parseAdoCoordinate(gitUrl);
		if (coordinate !== null) {
			const { org, project, repo } = coordinate;
			return `ado:${org}/${project}/${repo}`.toLowerCase();
		}
		return gitUrl
			.trim()
			.toLowerCase()
			.replace(/\/+$/, "")
			.replace(/\.git$/, "");
	}
}

export interface Plan {
	readonly toRegister: readonly string[];
	readonly skipped: readonly string[];
}

/** Split the target list into what needs registering and what already exists. */
export function planRegistrations(
	targets: readonly string[],
	existing: readonly { gitUrl: string }[],
): Plan {
	const have = new Set(existing.map((p) => repoKey(p.gitUrl)));
	const toRegister: string[] = [];
	const skipped: string[] = [];
	const seen = new Set<string>();
	for (const url of targets) {
		const key = repoKey(url);
		// A duplicate inside the manifest itself is a skip too, not two clones.
		if (have.has(key) || seen.has(key)) skipped.push(url);
		else toRegister.push(url);
		seen.add(key);
	}
	return { toRegister, skipped };
}

export type FetchLike = typeof fetch;

export interface ClientOptions {
	readonly baseUrl: string;
	readonly token: string;
	readonly fetchImpl?: FetchLike;
}

interface ErrorEnvelope {
	error?: { code?: string; message?: string; hint?: string };
}

/** Is this the "already registered" 400, as opposed to a real failure? */
export function isAlreadyExists(status: number, body: unknown): boolean {
	if (status !== 400) return false;
	const env = body as ErrorEnvelope;
	return (
		env?.error?.code === "validation_error" &&
		(env.error.message ?? "").includes("project already exists")
	);
}

async function call(
	opts: ClientOptions,
	method: string,
	path: string,
	body?: unknown,
	timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<{ status: number; body: unknown }> {
	const doFetch = opts.fetchImpl ?? fetch;
	const res = await doFetch(`${opts.baseUrl.replace(/\/$/, "")}${path}`, {
		method,
		headers: {
			Authorization: `Bearer ${opts.token}`,
			...(body !== undefined ? { "Content-Type": "application/json" } : {}),
		},
		...(body !== undefined ? { body: JSON.stringify(body) } : {}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	let parsed: unknown = text;
	try {
		parsed = text === "" ? null : JSON.parse(text);
	} catch {
		// non-JSON body (proxy error page, HTML 502) — keep the raw text
	}
	return { status: res.status, body: parsed };
}

export interface Outcome {
	readonly gitUrl: string;
	readonly state: "registered" | "skipped" | "failed";
	readonly id?: string;
	readonly detail?: string;
}

function describeFailure(status: number, body: unknown): string {
	const env = body as ErrorEnvelope;
	const code = env?.error?.code;
	const message = env?.error?.message;
	if (code || message) return `HTTP ${status} ${code ?? ""} ${message ?? ""}`.trim();
	return `HTTP ${status} ${typeof body === "string" ? body.slice(0, 200) : ""}`.trim();
}

/**
 * Register one repo. Sequential by design: each call clones a repo on the
 * server, and firing them concurrently would multiply peak disk and network
 * on a single-replica control plane.
 */
export async function registerOne(opts: ClientOptions, gitUrl: string): Promise<Outcome> {
	let res: { status: number; body: unknown };
	try {
		res = await call(opts, "POST", "/projects", { gitUrl }, REGISTER_TIMEOUT_MS);
	} catch (err) {
		return { gitUrl, state: "failed", detail: err instanceof Error ? err.message : String(err) };
	}
	if (isAlreadyExists(res.status, res.body)) {
		return { gitUrl, state: "skipped", detail: "already registered" };
	}
	if (res.status !== 201) {
		return { gitUrl, state: "failed", detail: describeFailure(res.status, res.body) };
	}
	const id = (res.body as { id?: string })?.id;
	if (id === undefined) {
		return { gitUrl, state: "failed", detail: "201 without an id in the body" };
	}
	return { gitUrl, state: "registered", id, detail: "registered" };
}

export function formatSummary(outcomes: readonly Outcome[]): string {
	const by = (s: Outcome["state"]) => outcomes.filter((o) => o.state === s);
	const lines = outcomes.map((o) => {
		const mark = o.state === "failed" ? "✗" : o.state === "skipped" ? "–" : "✓";
		return `  ${mark} ${o.gitUrl}${o.detail ? `  (${o.detail})` : ""}`;
	});
	lines.push(
		"",
		`${by("registered").length} registered, ${by("skipped").length} skipped, ${by("failed").length} failed`,
	);
	return lines.join("\n");
}

async function main(): Promise<number> {
	const baseUrl = process.env.WARREN_URL;
	const token = process.env.WARREN_API_TOKEN;
	if (!baseUrl || !token) {
		console.error("WARREN_URL and WARREN_API_TOKEN are both required.");
		console.error("  WARREN_URL has no default on purpose — this script mutates the instance.");
		return 2;
	}
	const { repos: argRepos, dryRun, fromFile } = parseArgs(process.argv.slice(2));
	const repos =
		fromFile !== undefined
			? [...argRepos, ...parseRepoFile(await Bun.file(fromFile).text())]
			: argRepos;
	if (repos.length === 0) {
		console.error("No repos given.");
		console.error("  bun run scripts/register-projects.ts <git-url>...");
		console.error("  bun run scripts/register-projects.ts --from repos.txt");
		return 2;
	}
	const opts: ClientOptions = { baseUrl, token };

	// Preflight doubles as an auth + reachability check before any write.
	const listed = await call(opts, "GET", "/projects");
	if (listed.status !== 200) {
		console.error(`GET /projects failed: ${describeFailure(listed.status, listed.body)}`);
		return 1;
	}
	const existing = ((listed.body as { projects?: { gitUrl: string }[] })?.projects ?? []).filter(
		(p) => typeof p.gitUrl === "string",
	);
	const plan = planRegistrations(repos, existing);

	console.log(`${baseUrl} holds ${existing.length} project(s).`);
	console.log(`${plan.toRegister.length} to register, ${plan.skipped.length} already present.`);
	if (dryRun) {
		for (const url of plan.toRegister) console.log(`  would register ${url}`);
		for (const url of plan.skipped) console.log(`  would skip     ${url}`);
		return 0;
	}

	const outcomes: Outcome[] = plan.skipped.map((gitUrl) => ({
		gitUrl,
		state: "skipped" as const,
		detail: "already registered",
	}));
	for (const [i, gitUrl] of plan.toRegister.entries()) {
		console.log(`[${i + 1}/${plan.toRegister.length}] cloning ${gitUrl} …`);
		outcomes.push(await registerOne(opts, gitUrl));
	}
	console.log(`\n${formatSummary(outcomes)}`);
	return outcomes.some((o) => o.state === "failed") ? 1 : 0;
}

if (import.meta.main) {
	process.exit(await main());
}
