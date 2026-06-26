/**
 * File-local helper group for scenario 20-path (`20-preview-path.ts`).
 *
 * Mirrors the precedent in `20-preview.helpers.ts` (warren-65f6) and
 * `32-plot-workbench-loop.helpers.ts`: the wire-shape interfaces,
 * module constants, fixture builder, run/preview polling, and the
 * path-mode proxy/login handshake helpers live here so the scenario
 * body stays under the per-file line budget. The scenario body imports
 * the exported symbols back.
 */

import { randomBytes } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, type ScenarioCtx, type ScenarioLogger } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";

export interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
}

export interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly burrowId: string | null;
	readonly previewState: "starting" | "live" | "failed" | "torn-down" | null;
	readonly previewPort: number | null;
	readonly previewFailureMessage: string | null;
}

export interface CreateRunResponse {
	readonly run: RunRow;
}

export const POLL_INTERVAL_MS = 250;
/** Same generous budget as scenario 20: reap → branch_push → pr_open →
 *  preview_launch can take up to ~60s of readiness probing. */
export const LIVE_PREVIEW_TIMEOUT_MS = 90_000;
export const TERMINAL_TIMEOUT_MS = 30_000;
export const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

export const PREVIEW_SANDBOX_PORT = 3000;
export const PREVIEW_OK_MARKER = "warren-preview-ok";
export const PREVIEW_ASSET_MARKER = "warren-asset-ok";
export const PREVIEW_ASSET_FILENAME = "asset.txt";
/** A real HTML doc (with a `<head>` tag) so the path-mode response
 *  rewriter has somewhere to splice the injected `<base>` element. The
 *  subdomain-mode scenario doesn't need this — its index can be a bare
 *  string — so this fixture is path-mode-specific. */
export const PREVIEW_INDEX_HTML = `<!doctype html>
<html>
<head><title>warren preview</title></head>
<body>${PREVIEW_OK_MARKER}</body>
</html>
`;

/* ------------------------------------------------------------------ */
/* Fixture builder — preview-opted-in project source                   */
/* ------------------------------------------------------------------ */

export interface BuildFixtureInput {
	readonly ctx: ScenarioCtx;
	readonly scenarioRoot: string;
}

export interface BuiltPreviewFixture {
	readonly gitUrl: string;
	readonly sourceRepoPath: string;
	readonly gitConfigPath: string;
}

/**
 * Copy the harness's `sample-source` clone into the scenario's tmp dir,
 * drop a `.warren/defaults.json` with a `preview.command` that runs the
 * stdlib python http server, write a proper-HTML `index.html` (so the
 * path-mode `<base>` rewriter has something to splice), commit on a
 * fresh branch, and return a scenario-unique fake URL + an augmented
 * git-config that redirects it onto the on-disk repo.
 */
export async function buildPreviewProjectFixture(
	input: BuildFixtureInput,
): Promise<BuiltPreviewFixture> {
	const sourceRepoPath = join(input.scenarioRoot, "sample-source");
	await cp(input.ctx.fixtures.sampleProjectPath, sourceRepoPath, { recursive: true });

	const defaultsJson = JSON.stringify(
		{
			defaultRole: input.ctx.fixtures.stubAgentName,
			preview: {
				type: "server",
				command: `python3 -m http.server ${PREVIEW_SANDBOX_PORT} --bind 0.0.0.0 --directory ./.warren/preview-www`,
				port: PREVIEW_SANDBOX_PORT,
				readiness_path: "/",
			},
		},
		null,
		2,
	);
	await Bun.write(join(sourceRepoPath, ".warren", "defaults.json"), defaultsJson);
	await Bun.write(join(sourceRepoPath, ".warren", "preview-www", "index.html"), PREVIEW_INDEX_HTML);
	// Asset served by the sidecar's static file server at /asset.txt — the
	// referer-routing assertion (warren-63e1) hits this through the proxy.
	await Bun.write(
		join(sourceRepoPath, ".warren", "preview-www", PREVIEW_ASSET_FILENAME),
		PREVIEW_ASSET_MARKER,
	);

	const suffix = `p-${randomBytes(3).toString("hex")}`;
	const fakeUrl = `https://github.com/warren-acceptance/preview-path-sample-${suffix}.git`;

	await commitInSource(sourceRepoPath, `scenario-20-path: enable preview (${suffix})`);

	const outerGitConfig = await readFile(join(input.ctx.tmp, "git-config"), "utf8");
	const extension = [
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = ${fakeUrl}`,
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = git@github.com:warren-acceptance/preview-path-sample-${suffix}.git`,
		"",
	].join("\n");
	const gitConfigPath = join(input.scenarioRoot, "git-config");
	await writeFile(gitConfigPath, `${outerGitConfig}\n${extension}`);

	return { gitUrl: fakeUrl, sourceRepoPath, gitConfigPath };
}

export async function commitInSource(repoPath: string, message: string): Promise<void> {
	await runGit(repoPath, ["add", "."]);
	await runGit(repoPath, ["commit", "-m", message]);
}

export async function runGit(cwd: string, args: readonly string[]): Promise<void> {
	const proc = Bun.spawn({
		cmd: ["git", ...args],
		cwd,
		env: {
			PATH: process.env.PATH ?? "",
			HOME: process.env.HOME ?? "/tmp",
			GIT_AUTHOR_NAME: "Warren Acceptance",
			GIT_AUTHOR_EMAIL: "acceptance@warren.invalid",
			GIT_COMMITTER_NAME: "Warren Acceptance",
			GIT_COMMITTER_EMAIL: "acceptance@warren.invalid",
		},
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	if ((exitCode ?? 0) !== 0) {
		throw new AcceptanceError(
			`git ${args.join(" ")} in ${cwd}: exit ${exitCode}\nstdout: ${stdout}\nstderr: ${stderr}`,
		);
	}
}

/* ------------------------------------------------------------------ */
/* HTTP helpers                                                         */
/* ------------------------------------------------------------------ */

export async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

export async function waitForRunTerminal(
	http: WarrenHttp,
	runId: string,
	logger: ScenarioLogger,
): Promise<void> {
	const deadline = Date.now() + TERMINAL_TIMEOUT_MS;
	let last = "<unknown>";
	while (Date.now() < deadline) {
		const row = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		last = row.state;
		if (TERMINAL_STATES.has(row.state)) {
			logger.debug(`scenario-20-path: run ${runId} terminal in state=${row.state}`);
			if (row.state !== "succeeded") {
				throw new AcceptanceError(
					`expected run ${runId} to succeed (preview launches only on success); got state=${row.state}`,
				);
			}
			return;
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`run ${runId} did not reach terminal within ${TERMINAL_TIMEOUT_MS}ms (last state=${last})`,
	);
}

export async function waitForPreviewState(
	http: WarrenHttp,
	runId: string,
	target: RunRow["previewState"],
	timeoutMs: number,
): Promise<RunRow> {
	const deadline = Date.now() + timeoutMs;
	let last: RunRow | undefined;
	while (Date.now() < deadline) {
		last = await http.expectJson<RunRow>("GET", `/runs/${encodeURIComponent(runId)}`, 200);
		if (last.previewState === target) return last;
		if (last.previewState === "failed") {
			throw new AcceptanceError(
				`preview transitioned to 'failed' before reaching '${target}' on run ${runId}: ` +
					`${last.previewFailureMessage ?? "<no message>"}`,
			);
		}
		await sleep(POLL_INTERVAL_MS);
	}
	throw new AcceptanceError(
		`preview did not reach '${target}' within ${timeoutMs}ms on run ${runId} ` +
			`(last preview_state=${JSON.stringify(last?.previewState ?? null)}, ` +
			`failure_message=${JSON.stringify(last?.previewFailureMessage ?? null)})`,
	);
}

/* ------------------------------------------------------------------ */
/* Path-mode proxy + login helpers                                       */
/* ------------------------------------------------------------------ */

export interface RawResponse {
	readonly status: number;
	readonly bodySnippet: string;
}

/**
 * Hit warren on `<warrenUrl><path>` directly. Unlike the subdomain
 * variant we don't override `Host:` — the path-mode preamble keys off
 * the URL pathname, so the inbound Host is whatever the loopback
 * binding presents. Body is captured up to 2 KiB so the injected
 * `<base>` tag is always visible to the assertion (real preview HTML
 * is small in this fixture; the cap exists only to keep the failure
 * message readable on a regression).
 */
export async function fetchRaw(
	warrenUrl: string,
	path: string,
	init: { cookie?: string; referer?: string } = {},
): Promise<RawResponse> {
	const headers: Record<string, string> = {};
	if (init.cookie !== undefined) headers.cookie = init.cookie;
	if (init.referer !== undefined) headers.referer = init.referer;
	const res = await fetch(`${warrenUrl}${path}`, {
		method: "GET",
		headers,
		redirect: "manual",
	});
	const text = await res.text();
	return {
		status: res.status,
		bodySnippet: text.length > 2048 ? `${text.slice(0, 2048)}…` : text,
	};
}

export interface LoginInput {
	readonly warrenUrl: string;
	readonly token: string;
	readonly runId: string;
	readonly cookieName: string;
}

export interface LoginResult {
	readonly cookieValue: string;
	readonly cookiePath: string;
	readonly cookieDomain: string | undefined;
}

/**
 * Walk `/runs/:id/preview/login?token=…&redirect=…` in path mode and
 * return the issued cookie + its Path / Domain attributes so the caller
 * can verify the scope contract (warren-63e1: path mode emits a per-run
 * `warren_preview_<runId>` cookie at `Path=/` with no Domain).
 */
export async function loginAndIssueCookie(input: LoginInput): Promise<LoginResult> {
	const redirect = `${input.warrenUrl}/p/${input.runId}/`;
	const url = `${input.warrenUrl}/runs/${encodeURIComponent(input.runId)}/preview/login?token=${encodeURIComponent(input.token)}&redirect=${encodeURIComponent(redirect)}`;
	const res = await fetch(url, { method: "GET", redirect: "manual" });
	if (res.status !== 302) {
		const body = await res.text();
		throw new AcceptanceError(
			`path-mode preview login: expected 302, got ${res.status}: ${body.slice(0, 256)}`,
		);
	}
	const setCookie = res.headers.get("set-cookie");
	if (setCookie === null || setCookie.length === 0) {
		throw new AcceptanceError("path-mode preview login: missing Set-Cookie on 302");
	}
	const parsed = parseSetCookie(setCookie, input.cookieName);
	if (parsed === null) {
		throw new AcceptanceError(
			`path-mode preview login: Set-Cookie did not carry a ${input.cookieName} entry: ${setCookie}`,
		);
	}
	return {
		cookieValue: parsed.value,
		cookiePath: parsed.attributes.Path ?? "",
		cookieDomain: parsed.attributes.Domain,
	};
}

export interface ParsedCookie {
	readonly value: string;
	readonly attributes: Readonly<Record<string, string>>;
}

/**
 * Tiny Set-Cookie parser: pulls the `<name>=<value>` head and a
 * case-sensitive attribute map ({Path, Domain, Max-Age, HttpOnly,
 * Secure, SameSite}). We don't need full RFC 6265 conformance — we
 * issue exactly the attributes in `src/preview/cookie.ts`, and the
 * scope assertions key off Path / Domain only.
 */
export function parseSetCookie(setCookie: string, name: string): ParsedCookie | null {
	const parts = setCookie.split(";");
	const first = parts[0];
	if (first === undefined) return null;
	const eq = first.indexOf("=");
	if (eq === -1) return null;
	if (first.slice(0, eq).trim() !== name) return null;
	const value = first.slice(eq + 1);
	const attributes: Record<string, string> = {};
	for (let i = 1; i < parts.length; i++) {
		const part = parts[i];
		if (part === undefined) continue;
		const trimmed = part.trim();
		if (trimmed.length === 0) continue;
		const attrEq = trimmed.indexOf("=");
		if (attrEq === -1) {
			attributes[trimmed] = "";
		} else {
			attributes[trimmed.slice(0, attrEq)] = trimmed.slice(attrEq + 1);
		}
	}
	return { value, attributes };
}

export function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
