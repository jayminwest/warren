/**
 * Scenario 03 — POST /projects + GET /projects + DELETE /projects/:id.
 *
 * Acceptance criterion #3:
 *   "POST /projects clones the configured GitHub URL (via the
 *   GIT_CONFIG_GLOBAL insteadOf rewrite — no real network), GET /projects
 *   lists it, DELETE /projects/:id removes both the row and the on-disk
 *   clone."
 *
 * Plus the warren-1bb6 extension:
 *   "POST /projects/:id/refresh (and the implicit refresh inside POST
 *   /runs) picks up new commits pushed to origin without requiring
 *   DELETE + POST."
 *
 * Verifies the docs/http-api.md atomicity contract: a row exists ⇔ its localPath
 * exists. We poke the filesystem directly to make sure deleteProject
 * isn't lying about the rmrf step.
 */

import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AcceptanceError, assertEqual, assertTrue, type Scenario } from "../lib/assert.ts";
import { WarrenHttp } from "../lib/http.ts";

interface ProjectRow {
	readonly id: string;
	readonly gitUrl: string;
	readonly localPath: string;
	readonly defaultBranch: string;
	readonly addedAt: string;
	readonly lastFetchedAt: string | null;
	readonly lastHeadSha: string | null;
}

interface RefreshResponse {
	readonly project: ProjectRow;
	readonly headSha: string;
	readonly ref: string;
}

interface ErrorEnvelope {
	readonly error: { readonly code: string; readonly message?: string };
}

export const scenario: Scenario = {
	id: "03",
	title: "POST /projects clones via insteadOf, GET lists, DELETE removes row + disk",
	// Container mode does not bind-mount the host sample-project fixture,
	// so POST /projects {gitUrl: <fake>} can't clone. In-proc only.
	modes: ["in-proc"],
	async run(ctx) {
		const http = new WarrenHttp({ baseUrl: ctx.warrenUrl, token: ctx.token });

		// /projects starts empty (DB is fresh per harness boot).
		const before = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
		assertEqual(before.projects.length, 0, "/projects is empty before first POST");

		// Clone the sample fixture. Warren resolves the fake github.com URL
		// through GIT_CONFIG_GLOBAL's insteadOf rewrite to the local fixture
		// path — no network, no production code change.
		const created = await http.expectJson<ProjectRow>("POST", "/projects", 201, {
			body: { gitUrl: ctx.fixtures.sampleProjectGitUrl },
		});
		assertTrue(
			typeof created.id === "string" && created.id.length > 0,
			"POST /projects response missing id",
		);
		assertEqual(created.gitUrl, ctx.fixtures.sampleProjectGitUrl, "ProjectRow.gitUrl");
		assertTrue(
			typeof created.localPath === "string" && created.localPath.length > 0,
			"POST /projects response missing localPath",
		);
		assertTrue(
			typeof created.defaultBranch === "string" && created.defaultBranch.length > 0,
			"POST /projects response missing defaultBranch",
		);
		assertTrue(
			typeof created.addedAt === "string" && /^\d{4}-\d{2}-\d{2}T/.test(created.addedAt),
			`POST /projects addedAt is not an ISO8601 string: ${JSON.stringify(created.addedAt)}`,
		);

		// addProject's contract: row inserted only after clone succeeds, so
		// localPath must exist on disk by the time we get a 201.
		assertTrue(
			existsSync(created.localPath),
			`clone localPath ${created.localPath} does not exist after POST /projects 201`,
		);

		// At registration time the row hasn't been fetched yet — refresh
		// columns are null until the first refresh. (warren-1bb6)
		assertEqual(
			created.lastFetchedAt,
			null,
			"freshly-cloned project lastFetchedAt is null until first refresh",
		);
		assertEqual(
			created.lastHeadSha,
			null,
			"freshly-cloned project lastHeadSha is null until first refresh",
		);

		// GET now lists the project.
		const after = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
		const found = after.projects.find((p) => p.id === created.id);
		if (found === undefined) {
			throw new AcceptanceError(
				`GET /projects after POST does not include id ${created.id}: ${JSON.stringify(after.projects)}`,
			);
		}
		assertEqual(found.gitUrl, ctx.fixtures.sampleProjectGitUrl, "listed project gitUrl");
		assertEqual(
			found.localPath,
			created.localPath,
			"listed project localPath matches POST response",
		);

		// Re-adding the same gitUrl is a 400 validation_error (already exists).
		const dupRes = await http.request("POST", "/projects", {
			body: { gitUrl: ctx.fixtures.sampleProjectGitUrl },
		});
		assertEqual(dupRes.status, 400, "duplicate POST /projects status");
		const dupBody = (await dupRes.json()) as ErrorEnvelope;
		assertEqual(dupBody.error?.code, "validation_error", "duplicate POST /projects error code");

		/* -----------------------------------------------------------------
		 * warren-1bb6: refresh-on-run picks up new commits without DELETE+POST
		 *
		 * Push a commit to the fixture's origin (just `git commit` inside
		 * the source repo — the local-bare semantics of `[url ".".insteadOf]`
		 * mean warren's clone has the source path as its `origin`). Then:
		 *   1. POST /projects/:id/refresh — explicit refresh: row's HEAD
		 *      sha + lastFetchedAt update; the working-tree commit advances.
		 *   2. Add a SECOND commit and verify the implicit refresh inside
		 *      POST /runs would pick it up. (We can't dispatch a full run
		 *      without an agent, but we re-issue /refresh to prove the
		 *      pattern; the spawn flow uses the same refreshProject() call.)
		 * --------------------------------------------------------------- */

		const sourceRepoPath = ctx.fixtures.sampleProjectPath;
		await commitToSourceRepo(sourceRepoPath, "drift-1.txt", "drift commit 1");
		const sourceHeadAfterFirstDrift = await readSourceHead(sourceRepoPath);

		const refresh1 = await http.expectJson<RefreshResponse>(
			"POST",
			`/projects/${encodeURIComponent(created.id)}/refresh`,
			200,
		);
		assertEqual(
			refresh1.headSha,
			sourceHeadAfterFirstDrift,
			"refresh response headSha matches source repo HEAD after drift commit 1",
		);
		assertEqual(
			refresh1.project.lastHeadSha,
			sourceHeadAfterFirstDrift,
			"row.lastHeadSha persisted after refresh",
		);
		assertTrue(refresh1.project.lastFetchedAt !== null, "row.lastFetchedAt is set after refresh");
		assertTrue(
			existsSync(join(created.localPath, "drift-1.txt")),
			`refresh did not pull drift-1.txt into ${created.localPath}`,
		);

		// GET /projects reflects the refresh.
		const afterRefresh1 = await http.expectJson<{ projects: ProjectRow[] }>(
			"GET",
			"/projects",
			200,
		);
		const refreshedRow = afterRefresh1.projects.find((p) => p.id === created.id);
		if (refreshedRow === undefined) {
			throw new AcceptanceError("GET /projects after refresh dropped the row");
		}
		assertEqual(
			refreshedRow.lastHeadSha,
			sourceHeadAfterFirstDrift,
			"GET /projects HEAD sha reflects refresh",
		);

		// Repeat with a second drift commit — proves the row reuses across
		// refreshes (no row recreation, no DELETE+POST cycle).
		await commitToSourceRepo(sourceRepoPath, "drift-2.txt", "drift commit 2");
		const sourceHeadAfterSecondDrift = await readSourceHead(sourceRepoPath);
		assertTrue(
			sourceHeadAfterSecondDrift !== sourceHeadAfterFirstDrift,
			"second drift commit must produce a new HEAD",
		);

		const refresh2 = await http.expectJson<RefreshResponse>(
			"POST",
			`/projects/${encodeURIComponent(created.id)}/refresh`,
			200,
		);
		assertEqual(
			refresh2.headSha,
			sourceHeadAfterSecondDrift,
			"second refresh picks up drift commit 2 — row is reused, not recreated",
		);
		assertTrue(
			existsSync(join(created.localPath, "drift-2.txt")),
			`second refresh did not pull drift-2.txt into ${created.localPath}`,
		);
		assertEqual(refresh2.project.id, created.id, "refresh response project id matches original");

		// DELETE removes row + on-disk clone.
		const deleted = await http.expectJson<ProjectRow>(
			"DELETE",
			`/projects/${encodeURIComponent(created.id)}`,
			200,
		);
		assertEqual(deleted.id, created.id, "DELETE response id");
		assertTrue(
			!existsSync(created.localPath),
			`localPath ${created.localPath} still exists after DELETE /projects/:id`,
		);

		// GET is empty again.
		const finalList = await http.expectJson<{ projects: ProjectRow[] }>("GET", "/projects", 200);
		assertEqual(finalList.projects.length, 0, "/projects is empty after DELETE");

		// Second DELETE is a 404 (row already gone).
		const repeatDel = await http.request("DELETE", `/projects/${encodeURIComponent(created.id)}`);
		assertEqual(repeatDel.status, 404, "second DELETE /projects/:id status");
	},
};

async function commitToSourceRepo(
	sourceRepoPath: string,
	filename: string,
	message: string,
): Promise<void> {
	await writeFile(join(sourceRepoPath, filename), `${message}\n`);
	await runGit(sourceRepoPath, ["add", filename]);
	await runGit(sourceRepoPath, ["commit", "-m", message]);
}

async function readSourceHead(sourceRepoPath: string): Promise<string> {
	const result = await runGit(sourceRepoPath, ["rev-parse", "HEAD"]);
	return result.stdout.trim();
}

async function runGit(
	cwd: string,
	args: readonly string[],
): Promise<{ stdout: string; stderr: string }> {
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
			`git ${args.join(" ")} in ${cwd} exited ${exitCode}\nstderr: ${stderr}`,
		);
	}
	return { stdout, stderr };
}
