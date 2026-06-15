/**
 * File-local helper group for scenario 20 (`20-preview.ts`).
 *
 * Mirrors the precedent in `32-plot-workbench-loop.helpers.ts`: the
 * fixture builder, run/preview polling, event fetch, and proxy/login
 * handshake helpers live here so the scenario body stays under the
 * per-file line budget. The scenario body imports the exported symbols
 * back; `RunRow` is owned by the scenario file (it co-locates with the
 * `CreateRunResponse` wire shape) and imported here as a type.
 */

import { randomBytes } from "node:crypto";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, type ScenarioCtx, type ScenarioLogger } from "../lib/assert.ts";
import type { WarrenHttp } from "../lib/http.ts";

import type { RunRow } from "./20-preview.ts";

export interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
}

export interface EventRow {
	readonly id: number;
	readonly runId: string;
	readonly seq: number;
	readonly ts: string;
	readonly kind: string;
	readonly stream: string | null;
	readonly payload: Record<string, unknown> | null;
}

const POLL_INTERVAL_MS = 250;
/** A run that never reaches a terminal state inside this window is treated
 *  as a harness failure — the stub agent exits in well under a second. */
const TERMINAL_TIMEOUT_MS = 30_000;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

const PREVIEW_SANDBOX_PORT = 3000;
const PREVIEW_OK_BODY = "warren-preview-ok\n";

/* ------------------------------------------------------------------ */
/* Fixture builder — preview-opted-in project source                   */
/* ------------------------------------------------------------------ */

export interface BuildFixtureInput {
	readonly ctx: ScenarioCtx;
	readonly scenarioRoot: string;
	/** Suffix on the fake git URL so each variant's clone is isolated. */
	readonly variantTag: string;
}

export interface BuiltPreviewFixture {
	readonly gitUrl: string;
	readonly sourceRepoPath: string;
	readonly gitConfigPath: string;
}

/**
 * Build a preview-enabled source repo by copying the harness's
 * `sample-source` clone into the scenario's tmp dir, dropping a
 * `.warren/defaults.json` with a `preview.command` that runs the
 * stdlib python http server, and committing the result on a fresh
 * branch. Returns a unique fake git URL + an augmented git-config that
 * redirects the URL onto the new on-disk repo.
 *
 * The harness's outer git-config is preserved verbatim (so the canopy
 * repo + the original sample URL keep resolving), with a single extra
 * `[url "..."].insteadOf` rule appended for our scenario-owned source.
 */
export async function buildPreviewProjectFixture(
	input: BuildFixtureInput,
): Promise<BuiltPreviewFixture> {
	const sourceRepoPath = join(input.scenarioRoot, "sample-source");
	await cp(input.ctx.fixtures.sampleProjectPath, sourceRepoPath, { recursive: true });

	// .warren/defaults.json with a `preview` block opting the project in.
	// python3 -m http.server is on PATH on every supported Linux + macOS
	// runner, and the sandbox inherits PATH (PASSTHROUGH_ENV_KEYS in
	// inproc.ts). The `--directory` flag points it at a deterministic
	// dir containing a `preview-ok` marker so the proxy 200 assertion can
	// prove it actually round-tripped through the sidecar.
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
	await Bun.write(join(sourceRepoPath, ".warren", "preview-www", "index.html"), PREVIEW_OK_BODY);

	const suffix = `${input.variantTag}-${randomBytes(3).toString("hex")}`;
	const fakeUrl = `https://github.com/warren-acceptance/preview-sample-${suffix}.git`;

	await commitInSource(sourceRepoPath, `scenario-20: enable preview (${input.variantTag})`);

	const outerGitConfig = await readFile(join(input.ctx.tmp, "git-config"), "utf8");
	const extension = [
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = ${fakeUrl}`,
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = git@github.com:warren-acceptance/preview-sample-${suffix}.git`,
		"",
	].join("\n");
	const gitConfigPath = join(input.scenarioRoot, "git-config");
	await writeFile(gitConfigPath, `${outerGitConfig}\n${extension}`);

	return { gitUrl: fakeUrl, sourceRepoPath, gitConfigPath };
}

async function commitInSource(repoPath: string, message: string): Promise<void> {
	await runGit(repoPath, ["add", "."]);
	// Identity comes from GIT_AUTHOR_* / GIT_COMMITTER_* env vars set in
	// runGit — no fallthrough to the global [user] block (warren-9f70).
	await runGit(repoPath, ["commit", "-m", message]);
}

async function runGit(cwd: string, args: readonly string[]): Promise<void> {
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
			logger.debug(`scenario-20: run ${runId} terminal in state=${row.state}`);
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

export async function fetchEvents(http: WarrenHttp, runId: string): Promise<EventRow[]> {
	const out: EventRow[] = [];
	for await (const env of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
		out.push(env as EventRow);
	}
	return out;
}

/* ------------------------------------------------------------------ */
/* Proxy + login helpers                                                */
/* ------------------------------------------------------------------ */

export interface ProxyRequestInput {
	readonly warrenUrl: string;
	readonly hostHeader: string;
	readonly path: string;
	readonly cookie?: string;
}

export interface ProxyResponse {
	readonly status: number;
	readonly bodySnippet: string;
}

/**
 * Hit warren's HTTP port with a custom `Host:` header so the proxy
 * preamble matches `run-<id>.<host>` instead of running the normal
 * route pipeline. `fetch()` won't let us override `Host` in some
 * environments (Bun honors it; Node ignores it), so we go through the
 * lower-level fetch and pass the header explicitly. The harness boots
 * warren on Bun, which respects the header.
 */
export async function proxyRequest(input: ProxyRequestInput): Promise<ProxyResponse> {
	const headers: Record<string, string> = { host: input.hostHeader };
	if (input.cookie !== undefined) headers.cookie = input.cookie;
	const res = await fetch(`${input.warrenUrl}${input.path}`, {
		method: "GET",
		headers,
		redirect: "manual",
	});
	const text = await res.text();
	return {
		status: res.status,
		bodySnippet: text.length > 512 ? `${text.slice(0, 512)}…` : text,
	};
}

export interface LoginInput {
	readonly warrenUrl: string;
	readonly token: string;
	readonly runId: string;
	readonly previewHost: string;
}

/**
 * Walk the `/runs/:id/preview/login?token=…&redirect=…` handshake and
 * return the value of the `warren_preview` cookie the handler issues.
 * The handler responds 302 with `Set-Cookie`; we don't follow the
 * redirect (the cookie scope makes it impossible to actually reach
 * `run-<id>.<host>` from a test process anyway).
 */
export async function loginAndIssueCookie(input: LoginInput): Promise<string> {
	const redirect = `https://run-${input.runId}.${input.previewHost}/`;
	const url = `${input.warrenUrl}/runs/${encodeURIComponent(input.runId)}/preview/login?token=${encodeURIComponent(
		input.token,
	)}&redirect=${encodeURIComponent(redirect)}`;
	const res = await fetch(url, { method: "GET", redirect: "manual" });
	if (res.status !== 302) {
		const body = await res.text();
		throw new AcceptanceError(
			`preview login: expected 302, got ${res.status}: ${body.slice(0, 256)}`,
		);
	}
	const setCookie = res.headers.get("set-cookie");
	if (setCookie === null || setCookie.length === 0) {
		throw new AcceptanceError("preview login: missing Set-Cookie on 302");
	}
	const value = parseSetCookie(setCookie, "warren_preview");
	if (value === null) {
		throw new AcceptanceError(
			`preview login: Set-Cookie did not carry a warren_preview entry: ${setCookie}`,
		);
	}
	return `warren_preview=${value}`;
}

function parseSetCookie(setCookie: string, name: string): string | null {
	// Bun's `headers.get("set-cookie")` returns the cookie line verbatim
	// (we issue exactly one); the cookie value is everything between the
	// `<name>=` prefix and the first `;` attribute separator.
	const eq = setCookie.indexOf("=");
	if (eq === -1) return null;
	if (setCookie.slice(0, eq).trim() !== name) return null;
	const tail = setCookie.slice(eq + 1);
	const semi = tail.indexOf(";");
	return semi === -1 ? tail : tail.slice(0, semi);
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
