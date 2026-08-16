import { describe, expect, test } from "bun:test";
import { LocalRunStore, toNormalizedEvent } from "./run-store.ts";

function makeRecord(store: LocalRunStore, runId = "run_1") {
	return store.create({
		runId,
		sandboxId: `local-${runId}`,
		workspacePath: "/tmp/ws",
		homePath: "/tmp/home",
		branch: `warren/${runId}`,
	});
}

describe("LocalRunStore", () => {
	test("assigns a monotonic per-run seq and stamps an ISO ts", () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const first = store.appendEvent(record, { kind: "text", stream: "stdout", payload: {} });
		const second = store.appendEvent(record, { kind: "stderr", stream: "stderr", payload: {} });
		expect(first.seq).toBe(1);
		expect(second.seq).toBe(2);
		expect(Date.parse(first.ts)).not.toBeNaN();
	});

	test("indexes records by both providerRunId and sandboxId", () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		expect(store.getByRunId("run_1")).toBe(record);
		expect(store.getBySandboxId("local-run_1")).toBe(record);
		expect(store.getByRunId("nope")).toBeUndefined();
	});

	test("terminalize sets the coarse outcome and isTerminal reads it", () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		expect(store.isTerminal(record)).toBe(false);
		store.markRunning(record);
		expect(record.phase).toBe("running");
		store.terminalize(record, { phase: "succeeded", exitCode: 0, terminalReason: "completed" });
		expect(store.isTerminal(record)).toBe(true);
		expect(record.exitCode).toBe(0);
		expect(record.terminalReason).toBe("completed");
	});

	test("claims the inbox priority-desc then FIFO and attributes delivery", () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		store.sendMessage(record, { body: "low-1", priority: "low" });
		store.sendMessage(record, { body: "normal-1" });
		store.sendMessage(record, { body: "urgent-1", priority: "urgent" });
		store.sendMessage(record, { body: "normal-2" });
		const claimed = store.claimPending(record);
		expect(claimed.map((r) => r.body)).toEqual(["urgent-1", "normal-1", "normal-2", "low-1"]);
		expect(claimed.every((r) => r.state === "delivered")).toBe(true);
		expect(claimed[0]?.deliveredAtRunId).toBe(record.providerRunId);
		expect(store.listPending(record)).toHaveLength(0);
	});

	test("defaults priority to normal and fromActor to user", () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const row = store.sendMessage(record, { body: "hi" });
		expect(row.priority).toBe("normal");
		expect(row.fromActor).toBe("user");
		expect(row.state).toBe("unread");
		expect(row.deliveredAt).toBeNull();
	});

	test("wakes waiters on append, terminalize, and remove", async () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		let wakes = 0;
		const track = (): void => {
			wakes += 1;
		};
		record.waiters.add(track);
		store.appendEvent(record, { kind: "text", stream: "stdout", payload: {} });
		record.waiters.add(track);
		store.terminalize(record, { phase: "failed", exitCode: 1, terminalReason: "error" });
		record.waiters.add(track);
		store.remove(record);
		expect(wakes).toBe(3);
		expect(store.getByRunId("run_1")).toBeUndefined();
	});

	test("toNormalizedEvent stamps the warren origin and keeps the payload verbatim", () => {
		const store = new LocalRunStore();
		const record = makeRecord(store);
		const payload = { nested: { total_cost_usd: 0.01 } };
		const stored = store.appendEvent(record, { kind: "telemetry", stream: "system", payload });
		const normalized = toNormalizedEvent(stored);
		expect(normalized.origin).toBe("warren");
		expect(normalized.payload).toBe(payload);
		expect(normalized.seq).toBe(1);
	});
});
