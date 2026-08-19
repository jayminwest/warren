import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import { SeedsTracker } from "../../tracker/seeds-tracker.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle, ServerDeps } from "../types.ts";
import { depsFor, silentLogger, tcpUrl } from "./projects.test-helpers.ts";

describe("GET /projects/:id/seeds/:seedId — single-seed status read (warren-4015)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let seedyProjectId = "";
	let bareProjectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const seedy = await repos.projects.create({
			gitUrl: "https://github.com/x/seedy.git",
			localPath: "/tmp/seedy-warren-4015",
			defaultBranch: "main",
			hasSeeds: true,
		});
		seedyProjectId = seedy.id;
		const bare = await repos.projects.create({
			gitUrl: "https://github.com/x/bare.git",
			localPath: "/tmp/bare-warren-4015",
			defaultBranch: "main",
			hasSeeds: false,
		});
		bareProjectId = bare.id;
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	function depsWithSdSpawn(
		provider: FakeProvider,
		sdSpawn: (
			cmd: readonly string[],
		) => Promise<{ stdout: string; stderr: string; exitCode: number }>,
	): Promise<ServerDeps> {
		return (async () => {
			const base = await depsFor(repos, provider);
			return {
				...base,
				issueTracker: new SeedsTracker({ sdBinary: "sd", spawn: sdSpawn }),
			};
		})();
	}

	test("returns {id, status, blockedBy} for an open seed", async () => {
		const sandboxClient = new FakeProvider();
		const deps = await depsWithSdSpawn(sandboxClient, async () => ({
			stdout: JSON.stringify({
				success: true,
				issue: { id: "warren-abcd", status: "open", blockedBy: [] },
			}),
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/warren-abcd`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; status: string; blockedBy: string[] };
		expect(body.id).toBe("warren-abcd");
		expect(body.status).toBe("open");
		expect(body.blockedBy).toEqual([]);
	});

	test("returns status='closed' so the UI can drop the seed from BatchDispatch", async () => {
		const sandboxClient = new FakeProvider();
		const deps = await depsWithSdSpawn(sandboxClient, async () => ({
			stdout: JSON.stringify({
				success: true,
				issue: { id: "warren-zzzz", status: "closed" },
			}),
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/warren-zzzz`);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { id: string; status: string; blockedBy: string[] };
		expect(body.status).toBe("closed");
		expect(body.blockedBy).toEqual([]);
	});

	test("404 for unknown project id", async () => {
		const sandboxClient = new FakeProvider();
		const deps = await depsWithSdSpawn(sandboxClient, async () => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/prj_missing/seeds/warren-1`);
		expect(res.status).toBe(404);
	});

	test("400 ProjectLacksSeedsError when project has no .seeds/", async () => {
		const sandboxClient = new FakeProvider();
		const deps = await depsWithSdSpawn(sandboxClient, async () => ({
			stdout: "",
			stderr: "",
			exitCode: 0,
		}));
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${bareProjectId}/seeds/warren-1`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_seeds");
	});

	test("400 ValidationError when no issue tracker is configured on warren", async () => {
		// `depsFor` does NOT set issueTracker, so this exercises the
		// "warren has no tracker configured" path.
		const deps = await depsFor(repos, new FakeProvider());
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/projects/${seedyProjectId}/seeds/warren-1`);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("validation_error");
	});
});
