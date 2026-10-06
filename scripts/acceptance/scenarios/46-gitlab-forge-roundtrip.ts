/**
 * Scenario 46 — GitLabForge end-to-end roundtrip (GH#1028): scenario 40
 * run against the GitLab arm instead of FakeForge.
 *
 * A project in a NESTED GitLab group completes dispatch → reap → push →
 * merge request with warren booted under `WARREN_FORGE=gitlab` and
 * `WARREN_GITLAB_URL` pointed at a local HTTP server. The server is the
 * same stateful stub the forge's unit and conformance tests use
 * (`src/forge/gitlab/stub-server.ts`), so the booted warren speaks the
 * real GitLab REST shapes over a real socket. As in scenario 40, any edit
 * outside `src/forge/` that this scenario needs to pass is a finding.
 *
 * The clone URL lands on the shared sample fixture through the harness's
 * standard insteadOf rewrite: the stub serves the API, not git.
 *
 * The assertions:
 *
 *   1. POST /projects on a nested-group URL registers, laid out under the
 *      folded owner (`warren--acceptance-sub/sample`: the group's own dash
 *      doubles before the join), not the last two path segments.
 *   2. POST /runs dispatches and the run reaches `succeeded`.
 *   3. Reap pushes the run branch and opens a merge request: run.prUrl is
 *      the instance's `/-/merge_requests/1` URL, and `reap.pr_opened`
 *      carries it.
 *   4. The stub recorded the merge request with the run's source branch
 *      and the project's target branch, and every API call carried the
 *      token as `PRIVATE-TOKEN` against the URL-encoded project path.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stubGitLabServer } from "../../../src/forge/gitlab/stub-server.ts";
import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";
import { type BootHandle, bootInProc } from "../lib/inproc.ts";
import { waitForRunTerminal } from "./lib/poll-helpers.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
}

interface RunRow {
	readonly id: string;
	readonly state: string;
	readonly prUrl: string | null;
}

interface EventRow {
	readonly kind: string;
	readonly payload: Record<string, unknown> | null;
}

const PROJECT_PATH = "warren-acceptance/sub/sample";
const TOKEN = "glpat-acceptance-46";
const RUN_DEADLINE_MS = 60_000;

export const scenario: Scenario = {
	id: "46",
	title:
		"GitLabForge roundtrip — WARREN_FORGE=gitlab completes dispatch → reap → push → merge request for a nested-group project",
	modes: ["in-proc"],
	async run(ctx) {
		const scenarioRoot = await mkdtemp(join(tmpdir(), "warren-acceptance-46-"));
		const gitConfigPath = join(scenarioRoot, "git-config");
		const stub = stubGitLabServer();
		const server = Bun.serve({
			port: 0,
			hostname: "127.0.0.1",
			fetch: async (req) =>
				stub.fetch(req.url, {
					method: req.method,
					headers: Object.fromEntries(req.headers),
					...(req.method === "GET" || req.method === "DELETE" ? {} : { body: await req.text() }),
				}),
		});
		const instanceUrl = `http://127.0.0.1:${server.port}`;
		const projectUrl = `${instanceUrl}/${PROJECT_PATH}.git`;

		const harnessConfig = existsSync(ctx.fixtures.gitConfigPath)
			? await readFile(ctx.fixtures.gitConfigPath, "utf8")
			: "";
		await writeFile(
			gitConfigPath,
			`${harnessConfig.trimEnd()}\n[url "${ctx.fixtures.sampleProjectPath}"]\n\tinsteadOf = ${projectUrl}\n`,
		);

		let handle: BootHandle | undefined;
		try {
			handle = await bootInProc({
				tmpRoot: join(scenarioRoot, "warren"),
				token: ctx.token,
				canopyRepoUrl: ctx.fixtures.canopyRepoUrl,
				gitConfigPath,
				extraEnv: {
					WARREN_FORGE: "gitlab",
					WARREN_GITLAB_URL: instanceUrl,
					WARREN_GIT_TOKEN: TOKEN,
				},
			});
			ctx.logger.info(
				`scenario-46: warren ready at ${handle.warrenUrl}, GitLab stub at ${instanceUrl}`,
			);
			const http = new WarrenHttp({ baseUrl: handle.warrenUrl, token: handle.token });

			// === 1. Register the nested-group project ===
			const project = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
				body: { gitUrl: projectUrl },
			});
			assertEqual(project.gitUrl, projectUrl, "project row keeps the GitLab clone URL verbatim");
			assertTrue(
				project.localPath.replace(/\\/g, "/").endsWith("/warren--acceptance-sub/sample"),
				`nested groups fold into one owner segment (localPath ${project.localPath})`,
			);

			// === 2. Dispatch → terminal ===
			const created = await http.expectJson<{ run: RunRow }>("POST", "/runs", 201, {
				body: {
					agent: "claude-code",
					project: project.id,
					// Same stub mechanism as scenario 40: close and commit the
					// fixture's known seed so reap has commits to push.
					prompt: "scenario-46 gitlab-forge roundtrip — closeseed ah-stub-1",
				},
			});
			const runId = created.run.id;
			const terminal = await waitForRunTerminal(http, runId, RUN_DEADLINE_MS);
			assertEqual(terminal.state, "succeeded", `run reaches 'succeeded' (got '${terminal.state}')`);

			// === 3. Reap pushed the branch and opened the merge request ===
			const expectedPrUrl = `${instanceUrl}/${PROJECT_PATH}/-/merge_requests/1`;
			assertEqual(terminal.prUrl, expectedPrUrl, "run.prUrl is the GitLab merge request URL");
			const runBranch = `warren/${runId}`;
			const branchSha = execFileSync(
				"git",
				["-C", ctx.fixtures.sampleProjectPath, "rev-parse", `refs/heads/${runBranch}`],
				{ encoding: "utf8" },
			).trim();
			assertTrue(/^[0-9a-f]{40}$/.test(branchSha), `run branch ${runBranch} was pushed`);

			const events: EventRow[] = [];
			for await (const row of http.streamNdjson(`/runs/${encodeURIComponent(runId)}/events`)) {
				events.push(row as EventRow);
			}
			const prOpened = events.find((e) => e.kind === "reap.pr_opened");
			if (prOpened === undefined) {
				throw new AcceptanceError(
					`run ${runId}: event stream missing 'reap.pr_opened'; saw kinds=[${events.map((e) => e.kind).join(", ")}]`,
				);
			}
			assertEqual(prOpened.payload?.prUrl, expectedPrUrl, "reap.pr_opened carries the MR URL");

			// === 4. The stub recorded the merge request and the auth ===
			const mr = stub.state.mergeRequests[0];
			if (mr === undefined) {
				throw new AcceptanceError("the GitLab stub recorded no merge request");
			}
			assertEqual(mr.iid, 1, "GitLab assigned iid 1");
			assertEqual(mr.source_branch, runBranch, "merge request source is the run branch");
			assertEqual(mr.target_branch, "main", "merge request targets the project base branch");
			const apiCalls = stub.state.calls;
			assertTrue(apiCalls.length > 0, "warren reached the GitLab API");
			for (const call of apiCalls) {
				assertEqual(call.privateToken, TOKEN, `${call.method} ${call.url} carries PRIVATE-TOKEN`);
				assertTrue(
					call.url.startsWith(`${instanceUrl}/api/v4/projects/warren-acceptance%2Fsub%2Fsample/`),
					`${call.url} addresses the project by its encoded full path`,
				);
			}

			ctx.logger.info("scenario-46: GitLabForge roundtrip verified");
		} finally {
			await handle?.stop();
			server.stop(true);
		}
	},
};
