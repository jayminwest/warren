/**
 * `POST /projects` under the public-instance org allowlist (warren-ce9b /
 * pl-b82d step 17).
 *
 * Over the wire against a real server, because the acceptance criterion is
 * not just "the assertion throws" but "nothing was cloned": the projects
 * root is a fresh temp dir here, and a refused registration must leave both
 * it and the projects table completely empty.
 *
 * The accepted cases deliberately pre-register the row so `addProject`
 * short-circuits on its own duplicate check — that proves the url got past
 * the allowlist without this test shelling out to a real `git clone`
 * against github.com. (`POST /projects` clones with `defaultSpawn`, not
 * `deps.spawn`, so there is no injectable seam to stub.)
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import type { PublicAllowlist } from "../../projects/public-allowlist.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./projects.test-helpers.ts";

const ALLOWED: PublicAllowlist = { owners: new Set(["os-eco"]), repos: new Set<string>() };

interface ErrorBody {
	readonly error: { readonly code: string; readonly message: string };
}

function inertSandboxClient(): FakeProvider {
	return new FakeProvider();
}

describe("POST /projects org allowlist", () => {
	let db: WarrenDb;
	let repos: Repos;
	let projectsRoot: string;
	let handle: ServeHandle | null = null;

	/** Start a server whose projects root is the temp dir. `undefined` ⇒ token mode. */
	async function serve(allowlist: PublicAllowlist | undefined): Promise<void> {
		const base = await depsFor(repos, inertSandboxClient());
		const deps: ServerDeps = {
			...base,
			projectsConfig: { root: projectsRoot, gitBinary: "git" },
			...(allowlist !== undefined ? { publicAllowlist: allowlist } : {}),
		};
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
	}

	async function post(gitUrl: string): Promise<Response> {
		return await fetch(`${tcpUrl(handle as ServeHandle)}/projects`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ gitUrl }),
		});
	}

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		projectsRoot = await mkdtemp(join(tmpdir(), "warren-allowlist-"));
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
		await rm(projectsRoot, { recursive: true, force: true });
	});

	test("a non-allowlisted org is 400 and clones nothing", async () => {
		await serve(ALLOWED);

		const res = await post("https://github.com/somebody/private.git");
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorBody;
		expect(body.error.code).toBe("validation_error");
		expect(body.error.message).toContain("somebody");
		expect(body.error.message).toContain("allowlist");

		// The whole point of asserting before `addProject`: no clone, no row.
		expect(await readdir(projectsRoot)).toEqual([]);
		expect(await repos.projects.listAll()).toEqual([]);
	});

	test("every accepted URL shape is refused for a non-allowlisted org", async () => {
		await serve(ALLOWED);

		for (const gitUrl of [
			"git@github.com:somebody/private.git",
			"ssh://git@github.com/somebody/private",
			"https://github.com/SOMEBODY/private",
		]) {
			const res = await post(gitUrl);
			expect(res.status).toBe(400);
			expect(((await res.json()) as ErrorBody).error.message).toContain("allowlist");
		}
		expect(await readdir(projectsRoot)).toEqual([]);
	});

	test("an allowlisted org gets past the gate (case-insensitively)", async () => {
		await serve(ALLOWED);
		const gitUrl = "https://github.com/OS-ECO/warren.git";
		await repos.projects.create({
			gitUrl,
			localPath: join(projectsRoot, "x"),
			defaultBranch: "main",
		});

		// `addProject`'s duplicate check is the FIRST thing past the gate, so
		// its message is proof the allowlist admitted an `OS-ECO` url.
		const res = await post(gitUrl);
		expect(res.status).toBe(400);
		const body = (await res.json()) as ErrorBody;
		expect(body.error.message).toContain("project already exists");
		expect(body.error.message).not.toContain("allowlist");
	});

	// warren-1841: the case an owner allowlist cannot express — a private
	// sibling under the same owner as an allowlisted repo.
	test("a repo entry admits its repo and refuses a sibling, over the wire", async () => {
		await serve({
			owners: new Set<string>(),
			repos: new Set(["some-owner/public-repo"]),
		});

		const refused = await post("https://github.com/some-owner/private-repo.git");
		expect(refused.status).toBe(400);
		expect(((await refused.json()) as ErrorBody).error.message).toContain("allowlist");
		expect(await readdir(projectsRoot)).toEqual([]);
		expect(await repos.projects.listAll()).toEqual([]);

		const gitUrl = "https://github.com/some-owner/public-repo.git";
		await repos.projects.create({
			gitUrl,
			localPath: join(projectsRoot, "w"),
			defaultBranch: "main",
		});
		const admitted = await post(gitUrl);
		expect(((await admitted.json()) as ErrorBody).error.message).toContain(
			"project already exists",
		);
	});

	test("token mode is unaffected — any org gets past the gate", async () => {
		await serve(undefined);
		const gitUrl = "https://github.com/somebody/private.git";
		await repos.projects.create({
			gitUrl,
			localPath: join(projectsRoot, "y"),
			defaultBranch: "main",
		});

		const res = await post(gitUrl);
		expect(res.status).toBe(400);
		expect(((await res.json()) as ErrorBody).error.message).toContain("project already exists");
	});
});
