/**
 * `plots.merge.test.ts` — `POST /plots/:id/attachments/:ref/merge`
 * (warren-8e39 / pl-0344 step 14).
 *
 * Split out of the monolithic `plots.test.ts` (warren-332b / pl-369d);
 * shared seam stubs / dep builders live in `./plots.test-support.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Attachment } from "@os-eco/plot-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import type {
	MergePlotPrRequest,
	MergePlotPrResult,
	PlotEnvelope,
	PlotPrMerger,
} from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	createRepos,
	depsFor,
	fakeAggregator,
	fakeResolver,
	type Repos,
	sampleIntent,
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.test-support.ts";

/* ----------------------------------------------------------------------- */
/* POST /plots/:id/attachments/:ref/merge (warren-8e39 / pl-0344 step 14)   */
/* ----------------------------------------------------------------------- */

interface FakePrMergerCall {
	readonly input: MergePlotPrRequest;
}

function fakePrMerger(result: MergePlotPrResult): {
	merger: PlotPrMerger;
	calls: FakePrMergerCall[];
} {
	const calls: FakePrMergerCall[] = [];
	const merger: PlotPrMerger = {
		async merge(input) {
			calls.push({ input });
			return result;
		},
	};
	return { merger, calls };
}

function mergeResult(
	merge: MergePlotPrResult["merge"],
	over: Partial<MergePlotPrResult> = {},
): MergePlotPrResult {
	const attachment: Attachment = {
		id: "att-001",
		type: "gh_pr",
		ref: "o/r#7",
		role: "tracks",
		added_at: "2026-05-18T03:00:00Z",
		added_by: "user:alice",
	};
	return {
		id: over.id ?? "pt-pr",
		name: over.name ?? "PR Plot",
		status: over.status ?? "active",
		intent: over.intent ?? sampleIntent,
		attachments: over.attachments ?? [attachment],
		event_log: over.event_log ?? [],
		merge,
		attachment_id: over.attachment_id ?? "att-001",
	};
}

describe("POST /plots/:id/attachments/:ref/merge", () => {
	let db: WarrenDb;
	let repos: Repos;
	let handle: ServeHandle | null = null;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
	});

	afterEach(async () => {
		if (handle) {
			await handle.stop();
			handle = null;
		}
		await db.close();
	});

	test("happy path: forwards token + ref, returns merge result", async () => {
		const project = await seedProject(repos, { id: "proj-pr", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-pr": project });
		const { merger, calls } = fakePrMerger(mergeResult({ kind: "merged", sha: "abc123" }));
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotPrMerger: merger,
			autoOpenToken: "ghp_xyz",
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-pr/attachments/${encodeURIComponent("o/r#7")}/merge`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ merge_method: "squash", dispatcher_handle: "alice" }),
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			envelope: PlotEnvelope;
			merge: MergePlotPrResult["merge"];
			attachment_id: string;
			refresh_scheduled: boolean;
		};
		expect(body.merge.kind).toBe("merged");
		expect(body.attachment_id).toBe("att-001");
		expect(body.refresh_scheduled).toBe(true);
		expect(body.envelope.project_id).toBe(project.id);
		expect(calls).toHaveLength(1);
		const call = calls[0]?.input;
		if (call === undefined) throw new Error("expected merge call");
		expect(call.ref).toBe("o/r#7");
		expect(call.token).toBe("ghp_xyz");
		expect(call.handle).toBe("alice");
		expect(call.mergeMethod).toBe("squash");
		expect(call.plotDir).toBe(`${project.localPath}/.plot`);
		expect(state.invalidates).toEqual([project.id]);
	});

	test("non-merge result does not schedule refresh", async () => {
		const project = await seedProject(repos, { id: "proj-pr-nr", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-pr": project });
		const { merger } = fakePrMerger(
			mergeResult({ kind: "not_mergeable", message: "checks failing" }),
		);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotPrMerger: merger,
			autoOpenToken: "ghp_x",
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-pr/attachments/${encodeURIComponent("o/r#1")}/merge`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: "{}",
			},
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			merge: { kind: string; message?: string };
			refresh_scheduled: boolean;
		};
		expect(body.merge.kind).toBe("not_mergeable");
		expect(body.refresh_scheduled).toBe(false);
	});

	test("missing token surfaces as merge.kind=missing_token from the seam", async () => {
		const project = await seedProject(repos, { id: "proj-pr-nt", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-pr": project });
		const { merger, calls } = fakePrMerger(
			mergeResult({ kind: "missing_token", message: "GITHUB_TOKEN unset" }),
		);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotPrMerger: merger,
			// no autoOpenToken → deps.autoOpenPr undefined → token = ""
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-pr/attachments/${encodeURIComponent("o/r#1")}/merge`,
			{ method: "POST" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { merge: { kind: string } };
		expect(body.merge.kind).toBe("missing_token");
		expect(calls[0]?.input.token).toBe("");
	});

	test("rejects unknown merge_method with 400", async () => {
		const project = await seedProject(repos, { id: "proj-pr-bm", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-pr": project });
		const { merger, calls } = fakePrMerger(mergeResult({ kind: "merged", sha: "abc" }));
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotPrMerger: merger,
			autoOpenToken: "t",
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-pr/attachments/${encodeURIComponent("o/r#1")}/merge`,
			{
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ merge_method: "smash" }),
			},
		);
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("returns 404 when plot is not resolved", async () => {
		const { resolver } = fakeResolver({});
		const { merger, calls } = fakePrMerger(mergeResult({ kind: "merged", sha: "abc" }));
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotPrMerger: merger,
			autoOpenToken: "t",
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});
		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-x/attachments/${encodeURIComponent("o/r#1")}/merge`,
			{ method: "POST" },
		);
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});
});
