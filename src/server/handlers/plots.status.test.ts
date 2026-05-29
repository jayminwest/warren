/**
 * `plots.status.test.ts` — `POST /plots/:id/status` (warren-e868 /
 * pl-9d6a step 10).
 *
 * Split out of the monolithic `plots.test.ts` (warren-332b / pl-369d);
 * shared seam stubs / dep builders live in `./plots.test-support.ts`.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { PlotEvent, PlotStatus } from "@os-eco/plot-cli";
import { openDatabase, type WarrenDb } from "../../db/client.ts";
import { PlotIllegalStatusTransitionError } from "../../plots/errors.ts";
import type {
	ChangePlotStatusRequest,
	ChangePlotStatusResult,
	PlotStatusChanger,
	PlotSummary,
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
	seedProject,
	silentLogger,
	tcpUrl,
} from "./plots.test-support.ts";

/* ----------------------------------------------------------------------- */
/* POST /plots/:id/status (warren-e868 / pl-9d6a step 10)                   */
/* ----------------------------------------------------------------------- */

interface FakeStatusChangerCall {
	readonly input: ChangePlotStatusRequest;
}

function fakeStatusChanger(result: ChangePlotStatusResult): {
	changer: PlotStatusChanger;
	calls: FakeStatusChangerCall[];
} {
	const calls: FakeStatusChangerCall[] = [];
	const changer: PlotStatusChanger = {
		async change(input) {
			calls.push({ input });
			return result;
		},
	};
	return { changer, calls };
}

function statusChangedResult(over: {
	id?: string;
	to: PlotStatus;
	from: PlotStatus;
	at?: string;
	actor?: string;
}): ChangePlotStatusResult {
	const at = over.at ?? "2026-05-18T02:00:00Z";
	const actor = over.actor ?? "user:alice";
	const event: PlotEvent = {
		type: "status_changed",
		actor,
		at,
		data: { from: over.from, to: over.to },
	};
	return {
		id: over.id ?? "pt-st",
		name: "S",
		status: over.to,
		intent_goal_preview: "",
		attachments_count: 0,
		last_event_ts: at,
		last_event_actor: actor,
		event,
	};
}

describe("POST /plots/:id/status", () => {
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

	test("happy path: returns the new summary + emitted status_changed event", async () => {
		const project = await seedProject(repos, { id: "proj-st", hasPlot: true });
		const { resolver, calls: resolverCalls } = fakeResolver({ "pt-st": project });
		const result = statusChangedResult({ to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const { agg, state } = fakeAggregator([]);
		const deps = await depsFor({
			repos,
			plotAggregator: agg,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready", dispatcher_handle: "alice" }),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			summary: PlotSummary;
			event: PlotEvent;
		};
		expect(body.summary.id).toBe("pt-st");
		expect(body.summary.status).toBe("ready");
		expect(body.summary.project_id).toBe(project.id);
		expect(body.event.type).toBe("status_changed");
		expect((body.event.data as { to?: string }).to).toBe("ready");

		expect(resolverCalls).toEqual(["pt-st"]);
		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one changer call");
		expect(call.input.plotId).toBe("pt-st");
		expect(call.input.handle).toBe("alice");
		expect(call.input.next).toBe("ready");
		expect(call.input.plotDir).toBe(`${project.localPath}/.plot`);

		// Aggregator cache invalidated so a follow-up list sees the new
		// status without the 5s TTL.
		expect(state.invalidates).toEqual([project.id]);
	});

	test("transition matrix: legal transitions pass through to the changer", async () => {
		const project = await seedProject(repos, { id: "proj-mx", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-mx": project });
		const result = statusChangedResult({ id: "pt-mx", to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		// Every legal SPEC §6.5 next-status (the matrix pin lives in
		// status-changer.test.ts; this just confirms the wire shape lets
		// them all through).
		for (const next of ["drafting", "ready", "active", "done", "archived"] as const) {
			const res = await fetch(`${tcpUrl(handle)}/plots/pt-mx/status`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ next }),
			});
			expect(res.status).toBe(200);
		}
		expect(calls).toHaveLength(5);
	});

	test("rejects unknown `next` with 400 (typo guard at the handler edge)", async () => {
		const project = await seedProject(repos, { id: "proj-typo", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-st": project });
		const result = statusChangedResult({ to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "wat" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { message: string } };
		expect(body.error.message).toContain("wat");
		expect(calls).toEqual([]);
	});

	test("rejects missing `next` with 400", async () => {
		const project = await seedProject(repos, { id: "proj-miss", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-st": project });
		const result = statusChangedResult({ to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(calls).toEqual([]);
	});

	test("downgrades malformed dispatcher_handle to 'operator'", async () => {
		const project = await seedProject(repos, { id: "proj-h", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-st": project });
		const result = statusChangedResult({ to: "ready", from: "drafting" });
		const { changer, calls } = fakeStatusChanger(result);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready", dispatcher_handle: "!!nope!!" }),
		});
		expect(res.status).toBe(200);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one changer call");
		expect(call.input.handle).toBe("operator");
	});

	test("404s when the resolver returns null", async () => {
		const { resolver } = fakeResolver({});
		const { changer, calls } = fakeStatusChanger(
			statusChangedResult({ to: "ready", from: "drafting" }),
		);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-missing/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("404s when no resolver is wired (non-Plot deployment)", async () => {
		const { changer, calls } = fakeStatusChanger(
			statusChangedResult({ to: "ready", from: "drafting" }),
		);
		const deps = await depsFor({ repos, plotStatusChanger: changer });
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-x/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready" }),
		});
		expect(res.status).toBe(404);
		expect(calls).toEqual([]);
	});

	test("surfaces ProjectLacksPlotError when hasPlot flipped after resolution", async () => {
		const project = await seedProject(repos, { id: "proj-flip", hasPlot: false });
		const { resolver } = fakeResolver({ "pt-flip": project });
		const { changer, calls } = fakeStatusChanger(
			statusChangedResult({ to: "ready", from: "drafting" }),
		);
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: changer,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-flip/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: { code: string } };
		expect(body.error.code).toBe("project_lacks_plot");
		expect(calls).toEqual([]);
	});

	test("surfaces PlotIllegalStatusTransitionError from the changer as 409", async () => {
		const project = await seedProject(repos, { id: "proj-il", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-il": project });
		const illegal: PlotStatusChanger = {
			async change() {
				throw new PlotIllegalStatusTransitionError(
					"plot pt-il cannot transition drafting → done per SPEC §6.5",
				);
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: illegal,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-il/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "done" }),
		});
		expect(res.status).toBe(409);
		const body = (await res.json()) as { error: { code: string; message: string } };
		expect(body.error.code).toBe("plot_illegal_status_transition");
		expect(body.error.message).toContain("pt-il");
	});

	test("propagates generic changer errors as 500 (no fire-and-log)", async () => {
		const project = await seedProject(repos, { id: "proj-boom", hasPlot: true });
		const { resolver } = fakeResolver({ "pt-st": project });
		const boom: PlotStatusChanger = {
			async change() {
				throw new Error("disk on fire");
			},
		};
		const deps = await depsFor({
			repos,
			plotResolver: resolver,
			plotStatusChanger: boom,
		});
		handle = startServer(deps, {
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
			auth: NO_AUTH,
			logger: silentLogger,
		});

		const res = await fetch(`${tcpUrl(handle)}/plots/pt-st/status`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ next: "ready" }),
		});
		expect(res.status).toBe(500);
	});

	test("agent-actor unreachability: PlotStatusChanger.change input has no actor-kind field", () => {
		// Compile-time pin (mx-bd4d67): the wire request to the changer
		// carries only a string `handle` — there's no way for a caller
		// (or warren's own handler) to thread an agent actor through
		// this seam. The underlying UserPlotClient hard-codes
		// `kind: "user"`, so `setStatus` is unreachable from the agent
		// surface at the type level. Asserted here so a future refactor
		// that widens the seam to a typed actor accidentally breaks
		// this test.
		const probe: ChangePlotStatusRequest = {
			plotDir: "/x/.plot",
			plotId: "pt-x",
			handle: "alice",
			next: "ready",
		};
		// @ts-expect-error — `actor` is not a field on ChangePlotStatusRequest
		const _bad: ChangePlotStatusRequest = { ...probe, actor: { kind: "agent" } };
		void _bad;
		expect(Object.keys(probe)).toEqual(["plotDir", "plotId", "handle", "next"]);
	});
});
