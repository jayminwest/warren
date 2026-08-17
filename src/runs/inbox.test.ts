import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openDatabase, type WarrenDb } from "../db/client.ts";
import { createRepos, type Repos } from "../db/repos/index.ts";
import type { EventRow } from "../db/schema.ts";
import { RunEventBroker } from "./events.ts";
import { pollRunInbox } from "./inbox.ts";

/** Records published kinds instead of fanning out to subscribers. */
class SpyBroker extends RunEventBroker {
	readonly kinds: string[] = [];
	override publish(_runId: string, event: EventRow): void {
		this.kinds.push(event.kind);
	}
}

/**
 * Domain coverage for `pollRunInbox` (warren-3d0b, warren-3305): the
 * poll-consume claim, the non-destructive peek, and the `steer.delivered`
 * audit event that makes sent-vs-delivered observable. Claim ordering +
 * atomicity live in `src/db/repos/run-inbox.test.ts`; the HTTP surface
 * (auth, `?peek=1`) lives in `src/server/handlers/runs.inbox.test.ts`.
 */
describe("pollRunInbox", () => {
	let db: WarrenDb;
	let repos: Repos;

	beforeEach(async () => {
		db = await openDatabase({ path: ":memory:" });
		repos = createRepos(db);
		const project = await repos.projects.create({
			gitUrl: "https://github.com/x/y.git",
			localPath: "/data/projects/x/y",
			defaultBranch: "main",
		});
		const run = await repos.runs.create({
			agentName: "pi",
			projectId: project.id,
			prompt: "p",
			renderedAgentJson: {},
			trigger: "manual",
		});
		runId = run.id;
	});
	let runId: string;

	afterEach(async () => {
		await db.close();
	});

	test("claim flips unread rows to delivered and emits steer.delivered per message", async () => {
		const first = await repos.runInbox.enqueue({ runId, body: "one", priority: "normal" });
		const second = await repos.runInbox.enqueue({ runId, body: "two", priority: "high" });
		const broker = new SpyBroker();

		const result = await pollRunInbox({ runId, repos, broker });

		expect(result.messages.map((m) => m.body)).toEqual(["two", "one"]);
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual([
			"delivered",
			"delivered",
		]);
		const events = await repos.events.listByRun(runId);
		expect(events.map((e) => e.kind)).toEqual(["steer.delivered", "steer.delivered"]);
		// Delivery order (priority-desc) is the event order; seqs are contiguous.
		expect(events.map((e) => (e.payloadJson as { messageId: string }).messageId)).toEqual([
			second?.id ?? "<null>",
			first?.id ?? "<null>",
		]);
		expect(events.map((e) => e.sandboxEventSeq)).toEqual([1, 2]);
		expect(broker.kinds).toEqual(["steer.delivered", "steer.delivered"]);
	});

	test("steer.delivered seqs continue from the run's existing event log", async () => {
		await repos.events.append({
			runId,
			sandboxEventSeq: 7,
			ts: new Date().toISOString(),
			kind: "steer.sent",
			stream: "system",
			payload: {},
		});
		const msg = await repos.runInbox.enqueue({ runId, body: "one", priority: "normal" });
		await pollRunInbox({ runId, repos });
		const events = await repos.events.listByRun(runId);
		const delivered = events.find((e) => e.kind === "steer.delivered");
		expect(delivered?.sandboxEventSeq).toBe(8);
		expect((delivered?.payloadJson as { messageId: string }).messageId).toBe(msg?.id ?? "<null>");
	});

	test("an empty claim emits no steer.delivered", async () => {
		const result = await pollRunInbox({ runId, repos });
		expect(result.messages).toEqual([]);
		expect(await repos.events.countByRun(runId)).toBe(0);
	});

	test("peek lists unread messages without claiming and emits no event", async () => {
		await repos.runInbox.enqueue({ runId, body: "one", priority: "normal" });
		const peeked = await pollRunInbox({ runId, repos, claim: false });
		expect(peeked.messages.map((m) => m.body)).toEqual(["one"]);
		expect(peeked.messages[0]?.state).toBe("unread");
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual(["unread"]);
		expect(await repos.events.countByRun(runId)).toBe(0);
		// The pod's later claim still takes the message exactly once.
		const claimed = await pollRunInbox({ runId, repos });
		expect(claimed.messages.map((m) => m.body)).toEqual(["one"]);
		expect((await repos.runInbox.listByRun(runId)).map((r) => r.state)).toEqual(["delivered"]);
	});
});
