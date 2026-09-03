/**
 * Golden snapshot for the `GET /analytics/runs` public projection envelope
 * (warren-bc9c). The spectator body is a stable wire shape the Telemetry
 * pages consume in public mode, so it is pinned the same way the ops-overview
 * projection is (`ops-overview.golden.test.ts`): the live public body must
 * byte-match the fixture. Delivery timings (`delivery`) and the autonomy
 * rollup (`outcomes.autonomy`) are public — cost figures stay redacted.
 *
 * Regenerate with `WARREN_UPDATE_GOLDENS=1 bun test
 * src/server/handlers/runs.analytics.golden.test.ts`, then inspect the diff
 * and commit only what you meant.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { bearerAuth, publicReadAuth } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	depsFor,
	seedRun,
	setRunPrState,
	silentLogger,
	tcpUrl,
	WINDOW,
} from "./runs.analytics.test-helpers.ts";

const GOLDEN_DIR = join(import.meta.dir, "__golden__", "responses");
const UPDATE = process.env.WARREN_UPDATE_GOLDENS === "1";

describe("run-analytics public projection golden (warren-bc9c)", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	test("the anonymous body matches the pinned fixture", async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/o/r",
			localPath: "/tmp/r",
			defaultBranch: "main",
		});
		const runId = await seedRun(repos, {
			projectId: project.id,
			agentName: "claude-code",
			provider: "anthropic",
			model: "sonnet",
			state: "succeeded",
			startedAt: "2026-05-20T10:00:00.000Z",
			endedAt: "2026-05-20T10:05:00.000Z",
		});
		await setRunPrState(repos, runId, "merged");
		await repos.events.append({
			runId,
			sandboxEventSeq: 1,
			ts: "2026-05-20T10:05:10.000Z",
			kind: "reap.branch_pushed",
			payload: { branch: "warren/x" },
		});
		await repos.events.append({
			runId,
			sandboxEventSeq: 2,
			ts: "2026-05-20T10:06:10.000Z",
			kind: "reap.pr_opened",
			payload: { prUrl: "https://github.com/o/r/pull/1" },
		});
		handle = startServer(depsFor(repos), {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: publicReadAuth(bearerAuth("golden-token")),
			logger: silentLogger,
		});
		const url = `${tcpUrl(handle)}/analytics/runs?${WINDOW}`;
		const body = (await (await fetch(url)).json()) as Record<string, unknown>;

		const path = join(GOLDEN_DIR, "run-analytics-public.json");
		if (UPDATE || !existsSync(path)) {
			mkdirSync(GOLDEN_DIR, { recursive: true });
			writeFileSync(path, `${JSON.stringify(body, null, "\t")}\n`);
		}
		expect(body).toEqual(JSON.parse(readFileSync(path, "utf8")));

		await handle.stop();
		handle = null;
		await db.close();
	});
});
