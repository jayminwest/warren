import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mergePlotEventsFile, mergePlotJsonFile, reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	makePool,
	setup,
} from "./test-helpers.ts";

describe("mergePlotEventsFile (pure)", () => {
	test("appends incoming lines absent from the existing body", () => {
		const existing =
			'{"type":"plot_created","actor":"user:op","at":"2026-05-17T10:00:00.000Z","data":{"name":"x"}}\n';
		const incoming =
			'{"type":"plot_created","actor":"user:op","at":"2026-05-17T10:00:00.000Z","data":{"name":"x"}}\n' +
			'{"type":"decision_made","actor":"agent:bot:r1","at":"2026-05-17T10:05:00.000Z","data":{"summary":"x"}}\n';
		const result = mergePlotEventsFile(existing, incoming);
		expect(result.appended).toBe(1);
		expect(result.newEvents).toHaveLength(1);
		expect(result.newEvents[0]?.type).toBe("decision_made");
		expect(result.merged.split("\n").filter(Boolean)).toHaveLength(2);
	});

	test("re-running against an unchanged workspace appends nothing (idempotent)", () => {
		const body =
			'{"type":"decision_made","actor":"agent:bot:r1","at":"2026-05-17T10:05:00.000Z","data":{"summary":"x"}}\n';
		const result = mergePlotEventsFile(body, body);
		expect(result.appended).toBe(0);
		expect(result.changed).toBe(false);
	});

	test("malformed JSON lines still dedup by exact-line content but are not parsed", () => {
		const incoming = "not json at all\nalso-not-json\n";
		const result = mergePlotEventsFile("", incoming);
		expect(result.appended).toBe(2);
		expect(result.newEvents).toHaveLength(0);
	});
});

describe("mergePlotJsonFile (pure)", () => {
	test("takes incoming when project copy is absent", () => {
		const result = mergePlotJsonFile(null, '{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z"}');
		expect(result.changed).toBe(true);
		expect(result.conflict).toBeNull();
	});

	test("LWW on updated_at — newer incoming wins", () => {
		const result = mergePlotJsonFile(
			'{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z"}',
			'{"id":"pl-1","updated_at":"2026-05-17T11:00:00Z"}',
		);
		expect(result.changed).toBe(true);
		expect(result.merged).toContain('"updated_at":"2026-05-17T11:00:00Z"');
	});

	test("older incoming is dropped", () => {
		const result = mergePlotJsonFile(
			'{"id":"pl-1","updated_at":"2026-05-17T11:00:00Z"}',
			'{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z"}',
		);
		expect(result.changed).toBe(false);
		expect(result.conflict).toBeNull();
	});

	test("equal updated_at with different contents emits a content conflict", () => {
		const result = mergePlotJsonFile(
			'{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z","name":"a"}',
			'{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z","name":"b"}',
		);
		expect(result.changed).toBe(false);
		expect(result.conflict).toContain("updated_at");
	});

	test("identical bodies are a no-op", () => {
		const body = '{"id":"pl-1","updated_at":"2026-05-17T10:00:00Z"}';
		const result = mergePlotJsonFile(body, body);
		expect(result.changed).toBe(false);
		expect(result.conflict).toBeNull();
	});
});

describe("reapRun plot_merge sub-step (warren-7e0f / pl-2047 step 6)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("merges burrow .plot events into project .plot and mirrors agent events tagged with plot_id", async () => {
		const burrowEvents =
			'{"type":"plot_created","actor":"user:op","at":"2026-05-17T10:00:00.000Z","data":{"name":"x"}}\n' +
			'{"type":"run_dispatched","actor":"user:op","at":"2026-05-17T10:00:01.000Z","data":{"run_id":"r1"}}\n' +
			'{"type":"decision_made","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:05:00.000Z","data":{"summary":"use Bun"}}\n' +
			'{"type":"question_posed","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:06:00.000Z","data":{"text":"which db?","blocking":true}}\n' +
			'{"type":"artifact_produced","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:07:00.000Z","data":{"type":"file","ref":"src/x.ts"}}\n' +
			'{"type":"note","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:08:00.000Z","data":{"text":"fyi"}}\n';
		const projectEvents =
			'{"type":"plot_created","actor":"user:op","at":"2026-05-17T10:00:00.000Z","data":{"name":"x"}}\n' +
			'{"type":"run_dispatched","actor":"user:op","at":"2026-05-17T10:00:01.000Z","data":{"run_id":"r1"}}\n';
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.events.jsonl": burrowEvents,
			"/data/projects/x/y/.plot/plot-abc12345.events.jsonl": projectEvents,
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: fakeExec().exec,
		});

		expect(result.plotEventsAppended).toBe(4);
		expect(result.plotEventsMirrored).toBe(3);
		expect(result.errors).toEqual([]);
		const merged = f.files.get("/data/projects/x/y/.plot/plot-abc12345.events.jsonl") ?? "";
		// All four new events from the workspace land in the project file.
		expect(merged).toContain('"summary":"use Bun"');
		expect(merged).toContain('"text":"which db?"');
		expect(merged).toContain('"ref":"src/x.ts"');
		expect(merged).toContain('"text":"fyi"');
		// Existing project lines preserved in order.
		expect(merged.indexOf('"name":"x"')).toBeLessThan(merged.indexOf('"summary":"use Bun"'));

		const events = await ctx.repos.events.listByRun(ctx.runId);
		const mirrored = events.filter((ev) => ev.kind.startsWith("plot."));
		const kinds = mirrored.map((ev) => ev.kind).sort();
		expect(kinds).toEqual(["plot.artifact_produced", "plot.decision_made", "plot.question_posed"]);
		const decision = mirrored.find((ev) => ev.kind === "plot.decision_made");
		expect(decision?.payloadJson).toMatchObject({
			plotId: "plot-abc12345",
			actor: "agent:refactor-bot:r1",
			at: "2026-05-17T10:05:00.000Z",
		});
		// note and run_dispatched are NOT mirrored even though they appended.
		expect(events.find((ev) => ev.kind === "plot.note")).toBeUndefined();
		expect(events.find((ev) => ev.kind === "plot.run_dispatched")).toBeUndefined();
	});

	test("plot_merge is idempotent — second reap against an already-merged workspace appends nothing", async () => {
		const burrowEvents =
			'{"type":"decision_made","actor":"agent:refactor-bot:r1","at":"2026-05-17T10:05:00.000Z","data":{"summary":"use Bun"}}\n';
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.events.jsonl": burrowEvents,
		});

		const first = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			broker: ctx.broker,
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(first.plotEventsAppended).toBe(1);
		expect(first.plotEventsMirrored).toBe(1);

		// Spawn a sibling run pointing at the same project + workspace and reap
		// it; the project's .plot/ already has the event so the merge dedups.
		const fresh = await ctx.repos.runs.create({
			agentName: "refactor-bot",
			projectId: ((await ctx.repos.projects.listAll())[0] as { id: string }).id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			burrowId: "bur_aaaaaaaaaaaa",
			burrowRunId: "run_idempotent",
		});
		await ctx.repos.runs.markRunning(fresh.id);

		const second = await reapRun({
			runId: fresh.id,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(second.plotEventsAppended).toBe(0);
		expect(second.plotEventsMirrored).toBe(0);
	});

	test("plot_merge writes through pl-id.json by last-write-wins on updated_at", async () => {
		const projectJson = JSON.stringify({
			schema_version: 1,
			id: "plot-abc12345",
			name: "x",
			status: "active",
			created_at: "2026-05-17T10:00:00.000Z",
			updated_at: "2026-05-17T10:00:00.000Z",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [],
		});
		const workspaceJson = JSON.stringify({
			schema_version: 1,
			id: "plot-abc12345",
			name: "x",
			status: "active",
			created_at: "2026-05-17T10:00:00.000Z",
			updated_at: "2026-05-17T11:00:00.000Z",
			intent: { goal: "", non_goals: [], constraints: [], success_criteria: [] },
			attachments: [{ id: "att-001", type: "file", ref: "x.ts", role: "tracks" }],
		});
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.json": workspaceJson,
			"/data/projects/x/y/.plot/plot-abc12345.json": projectJson,
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});

		expect(result.plotsUpdated).toBe(1);
		const merged = f.files.get("/data/projects/x/y/.plot/plot-abc12345.json") ?? "";
		expect(merged).toContain('"att-001"');
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "plot.updated")?.payloadJson).toMatchObject({
			plotId: "plot-abc12345",
		});
	});

	test("plot_merge emits plot.conflict when updated_at matches but contents differ", async () => {
		const ts = "2026-05-17T10:00:00.000Z";
		const projectJson = JSON.stringify({ id: "plot-abc12345", updated_at: ts, name: "a" });
		const workspaceJson = JSON.stringify({ id: "plot-abc12345", updated_at: ts, name: "b" });
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.json": workspaceJson,
			"/data/projects/x/y/.plot/plot-abc12345.json": projectJson,
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});

		expect(result.plotsUpdated).toBe(0);
		// Project copy stays put on a content conflict.
		expect(f.files.get("/data/projects/x/y/.plot/plot-abc12345.json")).toBe(projectJson);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const conflict = events.find((ev) => ev.kind === "plot.conflict");
		expect(conflict?.payloadJson).toMatchObject({ plotId: "plot-abc12345" });
	});

	test("plot_merge is a no-op when the workspace has no .plot/ directory", async () => {
		const f = fakeFs();
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});
		expect(result.plotEventsAppended).toBe(0);
		expect(result.plotsUpdated).toBe(0);
		expect(result.plotEventsMirrored).toBe(0);
		expect(result.errors.map((e) => e.step)).not.toContain("plot_merge");
	});

	test("plot_merge does not mirror user-actor decision/question/artifact events", async () => {
		// A human-authored decision should land in the merged events file but
		// must NOT appear in warren's event stream — the mirror is keyed on
		// agent-emitted entries per the seed wording.
		const burrowEvents =
			'{"type":"decision_made","actor":"user:operator","at":"2026-05-17T10:05:00.000Z","data":{"summary":"use Bun"}}\n';
		const f = fakeFs({
			"/data/burrow/ws/.plot/plot-abc12345.events.jsonl": burrowEvents,
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: f.fs,
			exec: fakeExec().exec,
		});

		expect(result.plotEventsAppended).toBe(1);
		expect(result.plotEventsMirrored).toBe(0);
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "plot.decision_made")).toBeUndefined();
	});

	test("assigns burrow_event_seq above MAX(seq) so reap events sort after stream events", async () => {
		await ctx.repos.events.append({
			runId: ctx.runId,
			burrowEventSeq: 7,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: {},
		});
		await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			burrowClientPool: await makePool(fakeBurrowClient(makeBurrow()), ctx.repos),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		const seqs = (await ctx.repos.events.listByRun(ctx.runId)).map((e) => e.burrowEventSeq);
		expect(seqs[0]).toBe(7);
		for (let i = 1; i < seqs.length; i++) {
			const a = seqs[i - 1] ?? 0;
			const b = seqs[i] ?? 0;
			expect(b).toBeGreaterThan(a);
		}
	});
});
