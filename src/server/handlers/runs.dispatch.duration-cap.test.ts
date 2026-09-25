/**
 * `POST /runs` `maxDurationMinutes` (warren-a112): boundary validation, the
 * fold onto the frozen agent, the clone inheritance, and the operator-only
 * `maxDurationMinutes` on the run detail GET.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import { depsFor, makeSandboxClient, silentLogger, tcpUrl } from "./runs.test-helpers.ts";

describe("POST /runs maxDurationMinutes (warren-a112)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;
	let base = "";
	let projectId = "";

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		await repos.agents.upsert({
			name: "refactor-bot",
			renderedJson: {
				name: "refactor-bot",
				version: 1,
				sections: { system: "you are refactor-bot" },
				resolvedFrom: [],
				frontmatter: { maxDurationMinutes: 120 },
			},
		});
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: await mkdtemp(join(tmpdir(), "warren-duration-proj-")),
			defaultBranch: "main",
		});
		projectId = project.id;
		const workspacePath = await mkdtemp(join(tmpdir(), "warren-duration-ws-"));
		const sandboxClient = makeSandboxClient(
			{ sandboxId: "bur_xxxxxxxxxxxx", sandboxRunId: "run_zzzzzzzzzzzz", workspacePath },
			[],
		);
		handle = startServer(await depsFor(repos, sandboxClient), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		base = tcpUrl(handle);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	async function dispatch(extra: Record<string, unknown>): Promise<Response> {
		return fetch(`${base}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ agent: "refactor-bot", project: projectId, prompt: "go", ...extra }),
		});
	}

	async function detailCap(runId: string): Promise<unknown> {
		const res = await fetch(`${base}/runs/${runId}`);
		const body = (await res.json()) as { run: { maxDurationMinutes?: unknown } };
		return body.run.maxDurationMinutes;
	}

	test("rejects zero, fractions, and strings with 400", async () => {
		for (const bad of [0, -3, 1.5, "30"]) {
			const res = await dispatch({ maxDurationMinutes: bad });
			expect(res.status).toBe(400);
		}
		expect(await repos.runs.listAll()).toHaveLength(0);
	});

	test("an explicit body cap wins over the agent's own and shows on the detail GET", async () => {
		const res = await dispatch({ maxDurationMinutes: 15 });
		expect(res.status).toBe(201);
		const { run } = (await res.json()) as { run: { id: string } };
		expect(await detailCap(run.id)).toBe(15);
	});

	test("without a body cap the agent's frontmatter cap applies", async () => {
		const res = await dispatch({});
		const { run } = (await res.json()) as { run: { id: string } };
		expect(await detailCap(run.id)).toBe(120);
	});

	test("a cloneFromRunId re-run inherits the parent's effective cap", async () => {
		const parentRes = await dispatch({ maxDurationMinutes: 7 });
		const parent = (await parentRes.json()) as { run: { id: string } };
		const res = await fetch(`${base}/runs`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ cloneFromRunId: parent.run.id }),
		});
		expect(res.status).toBe(201);
		const { run } = (await res.json()) as { run: { id: string } };
		expect(await detailCap(run.id)).toBe(7);
	});
});
