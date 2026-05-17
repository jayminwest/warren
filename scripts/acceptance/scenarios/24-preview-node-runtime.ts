/**
 * Scenario 24 — per-run preview sidecar running a real Node dev server
 * (post-warren-a82b verification, warren-0c8e).
 *
 * Scenario 20 covers preview launch end-to-end, but its fixture command
 * is `python3 -m http.server` (mx-87d34c) — no Node runtime in the loop,
 * so the bun-node-fallback shim warren-a82b ripped out was never
 * exercised by the acceptance suite. This scenario closes that gap:
 * the preview command is `node ./.warren/preview-server.js`, the script
 * hard-fails if `process.versions.bun` is defined (i.e. it's running
 * under the legacy bun-shim instead of real Node), and the readiness
 * probe assertion only passes if the http listener actually came up
 * under a real Node interpreter.
 *
 * Failure modes this catches:
 *
 *   1. Dockerfile regression — if `/usr/local/bin/node` were ever
 *      re-symlinked at the bun-shim (as it was pre-warren-a82b), the
 *      script's `process.versions.bun` check exits 1 before `listen()`
 *      and the readiness probe times out → scenario fails.
 *   2. Preview pipeline doesn't break on Node `#!/usr/bin/env node`
 *      shell-stubs — proves the proxy preamble, sidecar spawn, port
 *      allocator, and readiness probe all work when the command is a
 *      Node process (not python, not bun).
 *
 * Skip conditions match scenario 20:
 *
 *   - **macOS** — burrow's Linux-only bwrap inbound-port-forwarding
 *     (mx-1d31f0 / `inbound-forward.ts`).
 *   - **Postgres dialect** — port allocator + eviction worker are
 *     sqlite-only today (mx-b82a55, pl-f17e follow-up).
 *   - **No `node` on host PATH** — in-proc mode forwards the host's
 *     PATH into the sandbox (PASSTHROUGH_ENV_KEYS in inproc.ts), so a
 *     dev box without Node can't execute the fixture. Skipped with a
 *     clear reason rather than failing — the deployed container always
 *     has Node 22 from NodeSource (Dockerfile:64-65).
 */

import { randomBytes } from "node:crypto";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
	AcceptanceError,
	assertTrue,
	type Scenario,
	type ScenarioCtx,
	type ScenarioLogger,
	skipScenario,
} from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly burrowId: string | null;
	readonly previewState: "starting" | "live" | "failed" | "torn-down" | null;
	readonly previewPort: number | null;
	readonly previewFailureMessage: string | null;
}

interface CreateRunResponse {
	readonly run: RunRow;
}

const POLL_INTERVAL_MS = 250;
/** Same generous budget as scenario 20: reap → branch_push → pr_open →
 *  preview_launch can take up to ~60s of readiness probing. */
const LIVE_PREVIEW_TIMEOUT_MS = 90_000;
const TERMINAL_TIMEOUT_MS = 30_000;
const TERMINAL_STATES = new Set(["succeeded", "failed", "cancelled"]);

const PREVIEW_HOST = "preview.warren.acceptance";
const PREVIEW_SANDBOX_PORT = 3000;
const PREVIEW_OK_MARKER = "warren-preview-node-ok";

/**
 * Tiny Node HTTP server used as the preview command. The
 * `process.versions.bun` guard is the warren-a82b regression check —
 * Bun populates this string, real Node leaves it undefined. If a future
 * Dockerfile change re-symlinks /usr/local/bin/node at the bun-shim,
 * this exits 1 before `listen()` and the readiness probe deadlines out
 * instead of silently returning a Bun-served 200.
 */
const PREVIEW_SERVER_JS = `'use strict';
if (typeof process !== 'undefined' && process.versions && process.versions.bun) {
\tprocess.stderr.write('preview-server: process.versions.bun=' + process.versions.bun +
\t\t' — running under Bun shim, not real Node (warren-a82b regression)\\n');
\tprocess.exit(1);
}
const http = require('node:http');
const port = parseInt(process.env.PORT || '${PREVIEW_SANDBOX_PORT}', 10);
const host = process.env.HOST || '0.0.0.0';
http
\t.createServer((_req, res) => {
\t\tres.writeHead(200, { 'Content-Type': 'text/plain' });
\t\tres.end('${PREVIEW_OK_MARKER}\\n');
\t})
\t.listen(port, host, () => {
\t\tprocess.stdout.write('preview-server: node ' + process.versions.node +
\t\t\t' listening on ' + host + ':' + port + '\\n');
\t});
`;

export const scenario: Scenario = {
	id: "24",
	title:
		"Preview environments — real Node dev server (post-warren-a82b; sqlite, Linux only; macOS skip per mx-1d31f0)",
	// Same posture as scenario 20: boots its own warren+burrow with the
	// preview env-knobs the variant cares about. Container mode would
	// also work in principle, but compose-boot fixtures aren't bind-mounted
	// today (lib/compose.ts header) so we're in-proc-only for now.
	modes: ["in-proc"],
	async run(ctx) {
		if (process.platform === "darwin") {
			skipScenario(
				"preview scenarios require burrow's Linux-only bwrap inbound-port-forwarding " +
					"(mx-1d31f0 / burrow inbound-forward.ts): Seatbelt doesn't isolate the network " +
					"namespace and the host port the allocator hands out has no listener.",
			);
		}
		const dialect = (process.env.WARREN_TEST_DIALECT ?? "sqlite").trim().toLowerCase();
		if (dialect === "postgres" || dialect === "postgresql") {
			skipScenario(
				"preview port allocator + eviction worker are sqlite-only today (mx-b82a55); " +
					"the pg path lights up under the R-13 dialect-aware repo follow-up (pl-f17e). " +
					"This scenario re-passes once that's wired.",
			);
		}
		if (!(await nodeOnPath())) {
			skipScenario(
				"`node` not on host PATH — in-proc mode forwards the host PATH into the sandbox, " +
					"so the fixture preview command (`node ./.warren/preview-server.js`) has nothing " +
					"to exec. The deployed container always has Node 22 (Dockerfile:64-65 NodeSource).",
			);
		}

		await runNodePreview(ctx);
	},
};

async function runNodePreview(ctx: ScenarioCtx): Promise<void> {
	ctx.logger.info("scenario-24: dispatch + real-Node preview round-trip");
	const variantRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-24-"));
	const sample = await buildNodePreviewFixture({ ctx, scenarioRoot: variantRoot });

	let handle: BootHandle | undefined;
	try {
		handle = await bootInProc({
			tmpRoot: join(variantRoot, "warren"),
			token: ctx.token,
			canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
			gitConfigPath: sample.gitConfigPath,
			extraEnv: {
				WARREN_STUB_SLEEP_MS: "0",
				WARREN_PREVIEW_HOST: PREVIEW_HOST,
				WARREN_PREVIEW_IDLE_TTL: "30m",
				WARREN_PREVIEW_MAX_LIFETIME: "8h",
				WARREN_PREVIEW_EVICTION_TICK_MS: "10000",
			},
		});
		ctx.logger.info(`scenario-24: warren ready at ${handle.warrenUrl}`);

		const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });
		await http.expectStatus("POST", "/agents/refresh", 200);
		const project = await ensureProject(http, sample.gitUrl);

		const created = await http.expectJson<CreateRunResponse>("POST", "/runs", 201, {
			body: {
				agent: ctx.fixtures.stubAgentName,
				project: project.id,
				prompt: "scenario-24: real Node dev server",
			},
		});
		const runId = created.run.id;
		ctx.logger.debug(`scenario-24: dispatched ${runId}`);

		await waitForRunTerminal(http, runId, ctx.logger);
		const live = await waitForPreviewState(http, runId, "live", LIVE_PREVIEW_TIMEOUT_MS);
		assertTrue(
			typeof live.previewPort === "number" && live.previewPort > 0,
			`preview_port populated on live preview (got ${JSON.stringify(live.previewPort)})`,
		);

		const previewHostHeader = `run-${runId}.${PREVIEW_HOST}`;
		const cookie = await loginAndIssueCookie({
			warrenUrl: handle.warrenUrl,
			token: handle.token,
			runId,
			previewHost: PREVIEW_HOST,
		});

		const withCookie = await proxyRequest({
			warrenUrl: handle.warrenUrl,
			hostHeader: previewHostHeader,
			path: "/",
			cookie,
		});
		if (withCookie.status !== 200) {
			throw new AcceptanceError(
				`proxy with cookie: expected 200, got ${withCookie.status} body=${withCookie.bodySnippet}`,
			);
		}
		// The marker proves the proxied 200 came from our Node script, not
		// a sibling listener on the same port; the bun-shim regression
		// (warren-a82b) would never reach `listen()` so the readiness
		// probe would deadline before this assertion runs.
		assertTrue(
			withCookie.bodySnippet.includes(PREVIEW_OK_MARKER),
			`expected proxied 200 to include ${JSON.stringify(PREVIEW_OK_MARKER)}, got ${JSON.stringify(
				withCookie.bodySnippet,
			)}`,
		);

		try {
			await http.request("POST", `/runs/${encodeURIComponent(runId)}/preview/teardown`, {
				body: { actor: "scenario-24-cleanup" },
			});
		} catch {
			// Best-effort.
		}
	} finally {
		if (handle !== undefined) {
			await handle.stop().catch(() => undefined);
		}
	}
}

/* ------------------------------------------------------------------ */
/* Fixture builder — Node-dev-server preview project                   */
/* ------------------------------------------------------------------ */

interface BuildFixtureInput {
	readonly ctx: ScenarioCtx;
	readonly scenarioRoot: string;
}

interface BuiltFixture {
	readonly gitUrl: string;
	readonly sourceRepoPath: string;
	readonly gitConfigPath: string;
}

async function buildNodePreviewFixture(input: BuildFixtureInput): Promise<BuiltFixture> {
	const sourceRepoPath = join(input.scenarioRoot, "sample-source");
	await cp(input.ctx.fixtures.sampleProjectPath, sourceRepoPath, { recursive: true });

	const defaultsJson = JSON.stringify(
		{
			defaultRole: input.ctx.fixtures.stubAgentName,
			preview: {
				type: "server",
				command: "node ./.warren/preview-server.js",
				port: PREVIEW_SANDBOX_PORT,
				readiness_path: "/",
			},
		},
		null,
		2,
	);
	await Bun.write(join(sourceRepoPath, ".warren", "defaults.json"), defaultsJson);
	await Bun.write(join(sourceRepoPath, ".warren", "preview-server.js"), PREVIEW_SERVER_JS);

	const suffix = `n-${randomBytes(3).toString("hex")}`;
	const fakeUrl = `https://github.com/warren-acceptance/preview-node-sample-${suffix}.git`;

	await commitInSource(sourceRepoPath, `scenario-24: enable Node-dev-server preview (${suffix})`);

	const outerGitConfig = await readFile(join(input.ctx.tmp, "git-config"), "utf8");
	const extension = [
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = ${fakeUrl}`,
		`[url "${sourceRepoPath}"]`,
		`\tinsteadOf = git@github.com:warren-acceptance/preview-node-sample-${suffix}.git`,
		"",
	].join("\n");
	const gitConfigPath = join(input.scenarioRoot, "git-config");
	await writeFile(gitConfigPath, `${outerGitConfig}\n${extension}`);

	return { gitUrl: fakeUrl, sourceRepoPath, gitConfigPath };
}

async function commitInSource(repoPath: string, message: string): Promise<void> {
	await runGit(repoPath, ["add", "."]);
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
/* HTTP + lifecycle helpers                                            */
/* ------------------------------------------------------------------ */

async function ensureProject(http: WarrenHttp, gitUrl: string): Promise<ProjectRow> {
	const list = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
	const existing = list.projects.find((p) => p.gitUrl === gitUrl);
	if (existing !== undefined) return existing;
	return http.expectJson<ProjectRow>("POST", "/projects", 201, { body: { gitUrl } });
}

async function waitForRunTerminal(
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
			logger.debug(`scenario-24: run ${runId} terminal in state=${row.state}`);
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

async function waitForPreviewState(
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

interface ProxyRequestInput {
	readonly warrenUrl: string;
	readonly hostHeader: string;
	readonly path: string;
	readonly cookie?: string;
}

interface ProxyResponse {
	readonly status: number;
	readonly bodySnippet: string;
}

async function proxyRequest(input: ProxyRequestInput): Promise<ProxyResponse> {
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

interface LoginInput {
	readonly warrenUrl: string;
	readonly token: string;
	readonly runId: string;
	readonly previewHost: string;
}

async function loginAndIssueCookie(input: LoginInput): Promise<string> {
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
	const eq = setCookie.indexOf("=");
	if (eq === -1) return null;
	if (setCookie.slice(0, eq).trim() !== name) return null;
	const tail = setCookie.slice(eq + 1);
	const semi = tail.indexOf(";");
	return semi === -1 ? tail : tail.slice(0, semi);
}

/**
 * `which node`-style probe: return true if `node` is resolvable on the
 * host PATH. We don't shell out — Bun.spawn with an unresolvable cmd
 * throws synchronously, so we attempt a no-op `node -e ''` and treat
 * any exit-0 as success.
 */
async function nodeOnPath(): Promise<boolean> {
	try {
		const proc = Bun.spawn({
			cmd: ["node", "-e", ""],
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		const exitCode = await proc.exited;
		return exitCode === 0;
	} catch {
		return false;
	}
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
