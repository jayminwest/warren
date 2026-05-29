/**
 * `plots.detach.test.ts` — `DELETE /plots/:id/attachments/:ref`
 * (warren-589c / pl-9d6a step 11).
 *
 * Split out of the monolithic `plots.test.ts` (warren-332b / pl-369d);
 * shared seam stubs / dep builders live in `./plots.test-support.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { PlotAttachmentNotFoundError } from "../../plots/errors.ts";
import type {
	AttachPlotRequest,
	DetachPlotRequest,
	PlotAttacher,
	PlotEnvelope,
} from "../../plots/index.ts";
import { NO_AUTH } from "../auth.ts";
import { startServer } from "../server.ts";
import type { ServeHandle } from "../types.ts";
import {
	createRepos,
	depsFor,
	detachResult,
	fakeAggregator,
	fakeAttacher,
	fakeResolver,
	type Repos,
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.test-support.ts";

describe("DELETE /plots/:id/attachments/:ref", () => {
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

	test("happy path: detaches and returns the envelope + removed_id", async () => {
		const project = await seedProject(repos, { id: "proj-de", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-de": project });
		const { attacher, calls } = fakeAttacher({
			detach: detachResult({ id: "pt-de", removed_id: "att-007" }),
		});
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

		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-de/attachments/${encodeURIComponent("proj-abcd")}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { envelope: PlotEnvelope; removed_id: string };
		expect(body.envelope.id).toBe("pt-de");
		expect(body.envelope.project_id).toBe(project.id);
		expect(body.removed_id).toBe("att-007");

		expect(resolverCalls).toEqual(["pt-de"]);
		expect(calls).toHaveLength(1);
		const call = calls[0]?.detach;
		if (call === undefined) throw new Error("expected one detach call");
		expect(call.plotId).toBe("pt-de");
		expect(call.ref).toBe("proj-abcd");
		expect(call.handle).toBe("operator");
		expect(call.plotDir).toBe(`${project.localPath}/.plot`);

		expect(state.invalidates).toEqual([project.id]);
	});

	test("decodes URL-encoded refs (slashes, hashes)", async () => {
		const project = await seedProject(repos, { id: "proj-enc", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const ref = "owner/repo#42";
		const res = await fetch(
			`${tcpUrl(handle)}/plots/pt-de/attachments/${encodeURIComponent(ref)}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		const call = calls[0]?.detach;
		if (call === undefined) throw new Error("expected one detach call");
		expect(call.ref).toBe(ref);
	});

	test("threads body-supplied dispatcher_handle through", async () => {
		const project = await seedProject(repos, { id: "proj-hd", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-de/attachments/proj-abcd`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dispatcher_handle: "alice" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0]?.detach;
		if (call === undefined) throw new Error("expected one detach call");
		expect(call.handle).toBe("alice");
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-h2", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-de/attachments/proj-abcd`, {
			method: "DELETE",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ dispatcher_handle: "!!nope!!" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0]?.detach;
		if (call === undefined) throw new Error("expected one detach call");
		expect(call.handle).toBe("operator");
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/attachments/proj-abcd`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-x/attachments/proj-abcd`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flip", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flip": project });
		const { attacher, calls } = fakeAttacher({ detach: detachResult({}) });
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: attacher });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flip/attachments/proj-abcd`, {
			method: "DELETE",
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("surfaces PlotAttachmentNotFoundError from the attacher as 404", async () => {
		const project = await seedProject(repos, { id: "proj-nf", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const missing: PlotAttacher = {
			async attach() {
				throw new Error("unused");
			},
			async detach() {
				throw new PlotAttachmentNotFoundError("plot pt-de has no attachment with ref 'nope'");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: missing });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-de/attachments/nope`, {
			method: "DELETE",
		});
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("plot_attachment_not_found");
		expect(body.error.message).toContain("nope");
	});

	test("propagates generic attacher errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-de": project });
		const boom: PlotAttacher = {
			async attach() {
				throw new Error("unused");
			},
			async detach() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({ repos, plotResolver: resolver, plotAttacher: boom });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-de/attachments/proj-abcd`, {
			method: "DELETE",
		});
		expect(res.status).toBe(500);
	});

	test("agent-actor unreachability: attacher request types have no actor-kind field", () => {
		// Compile-time pin (mx-bd4d67): the wire requests to the
		// attacher carry only a string `handle` — there's no way for a
		// caller (or warren's own handler) to thread an agent actor
		// through this seam. The underlying UserPlotClient hard-codes
		// `kind: "user"`.
		const a: AttachPlotRequest = {
			plotDir: "/x/.plot",
			plotId: "pt-x",
			handle: "alice",
			kind: "seeds_issue",
			ref: "proj-abcd",
		};
		const d: DetachPlotRequest = {
			plotDir: "/x/.plot",
			plotId: "pt-x",
			handle: "alice",
			ref: "proj-abcd",
		};
		// @ts-expect-error — `actor` is not a field on AttachPlotRequest
		const _badA: AttachPlotRequest = { ...a, actor: { kind: "agent" } };
		// @ts-expect-error — `actor` is not a field on DetachPlotRequest
		const _badD: DetachPlotRequest = { ...d, actor: { kind: "agent" } };
		void _badA;
		void _badD;
		expect(Object.keys(a).sort()).toEqual(["handle", "kind", "plotDir", "plotId", "ref"]);
		expect(Object.keys(d).sort()).toEqual(["handle", "plotDir", "plotId", "ref"]);
	});
});
