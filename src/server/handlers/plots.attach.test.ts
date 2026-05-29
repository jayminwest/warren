/**
 * `plots.attach.test.ts` — `POST /plots/:id/attachments` (warren-589c /
 * pl-9d6a step 11).
 *
 * Split out of the monolithic `plots.test.ts` (warren-332b / pl-369d);
 * shared seam stubs / dep builders live in `./plots.test-support.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Attachment } from "@os-eco/plot-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import type { PlotAttacher, PlotEnvelope } from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	attachResult,
	createRepos,
	depsFor,
	fakeAggregator,
	fakeAttacher,
	fakeResolver,
	type Repos,
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.test-support.ts";

describe("POST /plots/:id/attachments", () => {
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

	test("happy path: attaches and returns the envelope + new attachment", async () => {
		const project = await seedProject(repos, { id: "proj-at", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotAttacher: attacher,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "seeds_issue",
				ref: "proj-abcd",
				role: "tracks",
				dispatcher_handle: "alice",
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			envelope: PlotEnvelope;
			attachment: Attachment;
		};
		expect(body.envelope.id).toBe("pt-at");
		expect(body.envelope.project_id).toBe(project.id);
		expect(body.attachment.id).toBe("att-001");
		expect(body.attachment.ref).toBe("proj-abcd");

		expect(resolverCalls).toEqual(["pt-at"]);
		expect(calls).toHaveLength(1);
		const call = calls[0]?.attach;
		if (call === undefined) throw new Error("expected one attach call");
		expect(call.plotId).toBe("pt-at");
		expect(call.handle).toBe("alice");
		expect(call.kind).toBe("seeds_issue");
		expect(call.ref).toBe("proj-abcd");
		expect(call.role).toBe("tracks");
		expect(call.plotDir).toBe(`${project.localPath}/.plot`);

		expect(state.invalidates).toEqual([project.id]);
	});

	test("omits role when not supplied (attacher defaults it lib-side)", async () => {
		const project = await seedProject(repos, { id: "proj-at2", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotAttacher: attacher,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "mulch_record", ref: "mx-abc123" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0]?.attach;
		if (call === undefined) throw new Error("expected one attach call");
		expect(call.role).toBeUndefined();
		expect(call.handle).toBe("operator");
	});

	test("rejects unknown kind with 400", async () => {
		const project = await seedProject(repos, { id: "proj-bk", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "canopy_prompt", ref: "anything" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("canopy_prompt");
		expect(calls).toEqual([]);
	});

	test("rejects mis-shaped seeds_issue ref with 400 (handler-edge pattern guard)", async () => {
		const project = await seedProject(repos, { id: "proj-shape", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "seeds_issue", ref: "not-a-seed-id" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects empty ref with 400", async () => {
		const project = await seedProject(repos, { id: "proj-em", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("rejects empty role with 400 when role is present", async () => {
		const project = await seedProject(repos, { id: "proj-er", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1", role: "" }),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-x/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flip", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flip": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flip/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-h", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const { attacher, calls } = fakeAttacher({ attach: attachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				kind: "gh_pr",
				ref: "owner/repo#1",
				dispatcher_handle: "!!nope!!",
			}),
		});
		expect(res.status).toBe(200);
		const call = calls[0]?.attach;
		if (call === undefined) throw new Error("expected one attach call");
		expect(call.handle).toBe("operator");
	});

	test("propagates generic attacher errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-at": project });
		const boom: PlotAttacher = {
			async attach() {
				throw new Error("disk on fire");
			},
			async detach() {
				throw new Error("unused");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-at/attachments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ kind: "gh_pr", ref: "owner/repo#1" }),
		});
		expect(res.status).toBe(500);
	});
});
