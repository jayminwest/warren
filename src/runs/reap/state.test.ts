import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { reapRun } from "./index.ts";
import {
	type Ctx,
	fakeBurrowClient,
	fakeExec,
	fakeFs,
	makeBurrow,
	reapDeps,
	setup,
} from "./test-helpers.ts";

describe("reapRun failure-reason inference (warren-3c40 / warren-5165)", () => {
	let ctx: Ctx;

	beforeEach(async () => {
		ctx = await setup();
	});

	afterEach(async () => {
		await ctx.db.close();
	});

	test("classifies a queued-on-entry failure as never_started (warren-3c40)", async () => {
		// New run is created in `queued`; no bridge event ever fired, so it
		// stays `queued` — that's the "burrow accepted dispatch but never
		// started the run" shape.
		const repos = ctx.repos;
		const project = (await repos.projects.listAll())[0];
		expect(project).toBeDefined();
		const stuck = await repos.runs.create({
			agentName: "refactor-bot",
			projectId: (project as { id: string }).id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
			sandboxId: "bur_aaaaaaaaaaaa",
			sandboxRunId: "run_neverstarted",
		});

		const result = await reapRun({
			runId: stuck.id,
			outcome: "failed",
			repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("never_started");
		const row = await repos.runs.require(stuck.id);
		expect(row.state).toBe("failed");
		expect(row.failureReason).toBe("never_started");

		const events = await repos.events.listByRun(stuck.id);
		const completed = events.find((e) => e.kind === "reap.completed");
		expect(completed?.payloadJson).toMatchObject({ failureReason: "never_started" });
	});

	test("classifies running-on-entry with model output as crashed (warren-3c40)", async () => {
		// ctx.runId was already markRunning'd in setup(). Seed an assistant
		// text event so the discriminator sees a real model turn — that's
		// the "agent ran and crashed mid-conversation" shape, distinct from
		// the warren-5165 no-output shape.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "I'll start by reading the file." },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("crashed");
	});

	test("classifies running-on-entry with no model output as no_model_response (warren-5165)", async () => {
		// Bridge claimed the run on a non-model-turn event (e.g. the
		// claude-code init system event), then the agent exited before
		// producing any assistant turn — the "Not logged in / credential"
		// shape from run_hkkm35bcckc4. Seed a state_change/system event
		// to simulate the init, but no text/thinking/tool_use stdout
		// events.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "state_change",
			stream: "system",
			payload: { type: "system", subtype: "init", apiKeySource: "/login managed key" },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("no_model_response");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("no_model_response");
	});

	test("classifies a sandbox-primitive stderr error as sandbox_failed (warren-daef)", async () => {
		// bwrap spawned but could not create the sandbox (user namespaces
		// disabled on the host), so it wrote its own error to stderr and
		// exited before the agent ran a single turn. Without the sandbox arm
		// this shape collapses into no_model_response, which reads as a
		// credential fault.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stderr",
			payload: { text: "bwrap: setting up uid map: Permission denied" },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("sandbox_failed");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("sandbox_failed");
	});

	test("keeps no_model_response when stderr mentions bwrap without the error prefix (warren-daef)", async () => {
		// The matcher is anchored to the sandbox binary's own `bwrap: `
		// error prefix — an agent merely printing the word in prose must
		// not reclassify its own credential failure.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stderr",
			payload: { text: "Not logged in · Please run /login (bwrap sandbox active)" },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("no_model_response");
	});

	test("classifies a spawn-exec system error as spawn_failed (warren-4e2a)", async () => {
		// The runtime could not exec the agent process at all — the docker
		// CLI is missing under DockerProvider, so the spawn seam threw and
		// the drive loop collapsed the throw into an `error` event on the
		// system stream. Without the spawn arm this shape collapses into
		// no_model_response, which reads as "the model said nothing".
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "error",
			stream: "system",
			payload: { message: 'Executable not found in $PATH: "docker"' },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("spawn_failed");
		const row = await ctx.repos.runs.require(ctx.runId);
		expect(row.failureReason).toBe("spawn_failed");
	});

	test("classifies the uid-drop preflight refusal as spawn_failed (warren-950d)", async () => {
		// K8s entrypoint preflight refusal, zero model turns (was no_model_response).
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "error",
			stream: "system",
			payload: {
				message:
					"agent-entrypoint: uid-drop preflight failed (setpriv exited 127) — " +
					"the entrypoint could not gain CAP_SETUID/CAP_SETGID",
			},
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("spawn_failed");
		// The spawn-class skip applies too: no seeds commit, no branch push.
		expect(result.seedsCommitted).toBe(false);
		expect(result.branchPushed).toBe(false);
	});

	test("a uid-drop mention on a non-system stream never reclassifies (warren-950d)", async () => {
		// An agent PRINTING the message in stdout prose must not reclassify.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "agent-entrypoint: uid-drop preflight failed (setpriv exited 127)" },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		// stdout text counts as a model turn ⇒ crashed, not spawn_failed.
		expect(result.failureReason).toBe("crashed");
	});

	test("matches the node-style spawn ENOENT shape as spawn_failed (warren-4e2a)", async () => {
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "error",
			stream: "system",
			payload: { message: "spawn docker ENOENT" },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("spawn_failed");
	});

	test("a model turn outranks a spawn-exec error line (warren-4e2a)", async () => {
		// The spawn matcher only applies when the agent never produced a
		// model turn — an agent that ran and crashed stays `crashed` even
		// if some later system error line happens to match the pattern.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "Working on it." },
		});
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 2,
			ts: new Date().toISOString(),
			kind: "error",
			stream: "system",
			payload: { message: 'Executable not found in $PATH: "docker"' },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
	});

	test("spawn-exec failure skips the seeds commit + branch push (warren-4e2a)", async () => {
		// The runtime could not exec the agent process at all (docker CLI
		// missing under DockerProvider): the drive loop collapsed the spawn
		// throw into a system-stream error event and no model turn ever
		// flowed. The run reaps failed, but the seeds-state commit and the
		// bookkeeping-branch push must NOT run — nothing useful happened,
		// and the push pollutes the repo.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "error",
			stream: "system",
			payload: { message: 'Executable not found in $PATH: "docker"' },
		});
		const e = fakeExec();

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: e.exec }),
			fs: fakeFs().fs,
			exec: e.exec,
		});

		expect(result.state).toBe("failed");
		expect(result.failureReason).toBe("spawn_failed");
		// No git commands run — no seeds commit, no branch push.
		expect(e.calls).toHaveLength(0);
		expect(result.seedsCommitted).toBe(false);
		expect(result.branchPushed).toBe(false);
		// The skip is operator-visible and precedes reap.completed.
		const events = await ctx.repos.events.listByRun(ctx.runId);
		const skipEv = events.find((ev) => ev.kind === "reap.spawn_failed_skip");
		expect(skipEv).toBeDefined();
		const order = events.map((ev) => ev.kind);
		expect(order.indexOf("reap.spawn_failed_skip")).toBeLessThan(order.indexOf("reap.completed"));
		// The workspace still tears down — nothing on it is worth preserving.
		expect(result.workspaceDestroyed).toBe(true);
	});

	test("a model turn defeats the spawn-exec pipeline skip (warren-4e2a)", async () => {
		// An agent that produced work reaps through the normal pipeline
		// even when a matching system error line exists — the skip is
		// gated on the no-model-turn shape, same as the classifier.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "Working on it." },
		});
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 2,
			ts: new Date().toISOString(),
			kind: "error",
			stream: "system",
			payload: { message: 'Executable not found in $PATH: "docker"' },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
		const events = await ctx.repos.events.listByRun(ctx.runId);
		expect(events.find((ev) => ev.kind === "reap.spawn_failed_skip")).toBeUndefined();
	});

	test("an agent-side stderr line mentioning ENOENT does not reclassify (warren-4e2a)", async () => {
		// The matcher only accepts the runtime-owned system stream — an
		// agent printing the phrase on its own stderr must not flip a
		// credential-shaped failure into spawn_failed.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stderr",
			payload: { text: "spawn rg ENOENT while running the agent's tool" },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("no_model_response");
	});

	test("thinking and tool_use events also count as model-turn output (warren-5165)", async () => {
		// burrow's jsonl-claude parser maps assistant content blocks into
		// kind=text, kind=thinking, or kind=tool_use. Any one of them is
		// proof the run reached at least one assistant turn → crashed,
		// not no_model_response.
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "tool_use",
			stream: "stdout",
			payload: { type: "tool_use", name: "Read", input: { path: "/x" } },
		});

		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});

		expect(result.failureReason).toBe("crashed");
	});

	test("succeeded runs carry no failureReason", async () => {
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "succeeded",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(result.failureReason).toBeNull();
		expect((await ctx.repos.runs.require(ctx.runId)).failureReason).toBeNull();
	});

	test("explicit failureReason override wins over inference (warren-3c40)", async () => {
		const result = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			failureReason: "timed_out",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(result.failureReason).toBe("timed_out");
		expect((await ctx.repos.runs.require(ctx.runId)).failureReason).toBe("timed_out");
	});

	test("idempotent reap surfaces the previously-stored failureReason", async () => {
		// Seed a model-turn event so the first reap classifies as crashed
		// (warren-5165 discriminator: bare running-on-entry with no model
		// output would now classify as no_model_response).
		await ctx.repos.events.append({
			runId: ctx.runId,
			sandboxEventSeq: 1,
			ts: new Date().toISOString(),
			kind: "text",
			stream: "stdout",
			payload: { text: "ok" },
		});
		// First reap: classify as crashed and persist.
		await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		// Second reap on the now-terminal row should report the same reason
		// (idempotency for restart-recovery sweeps).
		const second = await reapRun({
			runId: ctx.runId,
			outcome: "failed",
			repos: ctx.repos,
			...reapDeps(fakeBurrowClient(makeBurrow()), { fs: fakeFs().fs, exec: fakeExec().exec }),
			fs: fakeFs().fs,
			exec: fakeExec().exec,
		});
		expect(second.alreadyTerminal).toBe(true);
		expect(second.failureReason).toBe("crashed");
	});
});
