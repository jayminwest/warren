import { describe, expect, test } from "bun:test";
import type { PlotHandle } from "@os-eco/plot-cli";
import { PlotAgentACLViolationError } from "./errors.ts";
import { AgentPlotHandle, UserPlotHandle } from "./handle.ts";
import type { PlotProjectionSink } from "./projection.ts";
import { HUMANS_ONLY_EVENT_TYPES, type HumansOnlyEventType } from "./types.ts";

// Records every method the wrapper forwards to so each test can assert
// whether (and how) the inner PlotHandle was invoked. Casting through
// unknown is the canonical bun:test pattern for stubbing third-party
// classes (see src/burrow-client/client.test.ts).
interface RecorderCall {
	method: string;
	args: unknown[];
}
function recorderHandle(): { inner: PlotHandle; calls: RecorderCall[] } {
	const calls: RecorderCall[] = [];
	const trap =
		(method: string) =>
		(...args: unknown[]) => {
			calls.push({ method, args });
			return Promise.resolve({ type: method, args } as unknown);
		};
	const inner = {
		id: "plot-test0001",
		read: trap("read"),
		events: trap("events"),
		view: trap("view"),
		attach: trap("attach"),
		editIntent: trap("editIntent"),
		detach: trap("detach"),
		setStatus: trap("setStatus"),
		append: trap("append"),
	} as unknown as PlotHandle;
	return { inner, calls };
}

describe("AgentPlotHandle write-ACL narrowing", () => {
	test("does not define the user-only mutators on the prototype", () => {
		// Compile-time narrowing per SPEC §6: editIntent / setStatus / detach
		// live only on UserPlotHandle, so an agent-actor call site can never
		// even spell them through the facade type. The prototype check below
		// is the runtime mirror of that — if a future refactor accidentally
		// re-adds one of these as an inherited method, this test trips.
		const proto = AgentPlotHandle.prototype as unknown as Record<string, unknown>;
		expect(proto.editIntent).toBeUndefined();
		expect(proto.setStatus).toBeUndefined();
		expect(proto.detach).toBeUndefined();

		const { inner } = recorderHandle();
		const handle = new AgentPlotHandle(inner);
		const ref = handle as unknown as Record<string, unknown>;
		expect(ref.editIntent).toBeUndefined();
		expect(ref.setStatus).toBeUndefined();
		expect(ref.detach).toBeUndefined();
	});

	test.each(
		HUMANS_ONLY_EVENT_TYPES.map((t) => [t] as const),
	)("append throws PlotAgentACLViolationError for %s and never reaches the inner store", (eventType) => {
		const { inner, calls } = recorderHandle();
		const handle = new AgentPlotHandle(inner);

		// Cast widens past the AgentAllowedEventType narrowing so the
		// runtime guard is exercised. The TS-level refusal is verified by
		// `bun run typecheck` against the codebase — see the
		// `does not accept humans-only types at compile time` test below.
		// The facade throws synchronously (before constructing the
		// underlying promise) so `expect(...).toThrow` is the right shape,
		// not `.rejects` — see handle.ts:96.
		const call = () =>
			handle.append({ type: eventType, data: {} } as unknown as {
				type: "note";
				data: Record<string, unknown>;
			});

		expect(call).toThrow(PlotAgentACLViolationError);
		try {
			call();
		} catch (err) {
			expect(err).toMatchObject({
				code: "plot_agent_acl_violation",
				eventType,
			});
		}
		expect(calls).toEqual([]);
	});

	test("append forwards allowed event types to the inner handle", async () => {
		const { inner, calls } = recorderHandle();
		const handle = new AgentPlotHandle(inner);
		await handle.append({ type: "decision_made", data: { what: "x" } });
		await handle.append({ type: "question_posed", data: { ask: "y" } });
		await handle.append({ type: "artifact_produced", data: { path: "z" } });
		await handle.append({ type: "note", data: { body: "n" } });
		await handle.append({ type: "run_dispatched", data: { run_id: "r" } });
		await handle.append({ type: "plot_created", data: {} });
		await handle.append({ type: "attachment_added", data: { id: "att-001" } });
		expect(calls.map((c) => c.method)).toEqual([
			"append",
			"append",
			"append",
			"append",
			"append",
			"append",
			"append",
		]);
	});

	test("read / events / view / attach forward to the inner handle", async () => {
		const { inner, calls } = recorderHandle();
		const handle = new AgentPlotHandle(inner);
		await handle.read();
		await handle.events();
		await handle.view("implementer");
		await handle.attach({ type: "file", ref: "README.md", role: "reference" });
		expect(calls.map((c) => c.method)).toEqual(["read", "events", "view", "attach"]);
		expect(handle.id).toBe("plot-test0001");
	});

	test("HUMANS_ONLY_EVENT_TYPES matches SPEC §6 exactly", () => {
		// If Plot SPEC §6 loosens or renames one of these, the test fails so
		// the facade gets a deliberate update rather than a silent drift.
		const expected: readonly HumansOnlyEventType[] = [
			"intent_edited",
			"status_changed",
			"attachment_removed",
			"question_answered",
		];
		expect([...HUMANS_ONLY_EVENT_TYPES].sort()).toEqual([...expected].sort());
	});

	test("does not accept humans-only types at compile time", () => {
		// This test does not run a runtime assertion — its only purpose is to
		// document the four expressions that MUST be a type error. If any of
		// them ever start type-checking, `bun run typecheck` will pass while
		// this comment lies; flip the suspect line to a real call and watch
		// the runtime test above to confirm.
		// @ts-expect-error — intent_edited is humans-only per SPEC §6
		void ((h: AgentPlotHandle) => h.append({ type: "intent_edited", data: {} }));
		// @ts-expect-error — status_changed is humans-only per SPEC §6
		void ((h: AgentPlotHandle) => h.append({ type: "status_changed", data: {} }));
		// @ts-expect-error — attachment_removed is humans-only per SPEC §6
		void ((h: AgentPlotHandle) => h.append({ type: "attachment_removed", data: {} }));
		// @ts-expect-error — question_answered is humans-only per SPEC §6
		void ((h: AgentPlotHandle) => h.append({ type: "question_answered", data: {} }));
		// @ts-expect-error — editIntent does not exist on AgentPlotHandle
		void ((h: AgentPlotHandle) => h.editIntent({ goal: "x" }));
		// @ts-expect-error — setStatus does not exist on AgentPlotHandle
		void ((h: AgentPlotHandle) => h.setStatus("ready"));
		// @ts-expect-error — detach does not exist on AgentPlotHandle
		void ((h: AgentPlotHandle) => h.detach("att-001"));
	});
});

describe("UserPlotHandle", () => {
	test("exposes the full user-actor mutating surface", () => {
		const proto = UserPlotHandle.prototype as unknown as Record<string, unknown>;
		expect(typeof proto.editIntent).toBe("function");
		expect(typeof proto.setStatus).toBe("function");
		expect(typeof proto.detach).toBe("function");
		expect(typeof proto.append).toBe("function");
	});

	test("forwards every mutator (including humans-only appends) to the inner handle", async () => {
		const { inner, calls } = recorderHandle();
		const handle = new UserPlotHandle(inner);
		await handle.editIntent({ goal: "g" });
		await handle.setStatus("ready");
		await handle.detach("att-001");
		// Users may append every event type per SPEC §6 ACL: the four
		// humans-only types are reachable on UserPlotHandle.append by design.
		await handle.append({ type: "question_answered", data: { qid: "q1" } });
		await handle.append({ type: "note", data: { body: "n" } });
		expect(calls.map((c) => c.method)).toEqual([
			"editIntent",
			"setStatus",
			"detach",
			"append",
			"append",
		]);
	});
});

describe("BasePlotHandle projection hook (warren-7b60)", () => {
	function recordingSink(): { sink: PlotProjectionSink; upserts: unknown[] } {
		const upserts: unknown[] = [];
		return {
			upserts,
			sink: {
				upsert(plot) {
					upserts.push(plot);
				},
			},
		};
	}

	test("read() refreshes the projection with the freshly-read plot", async () => {
		const { inner } = recorderHandle();
		const { sink, upserts } = recordingSink();
		const handle = new UserPlotHandle(inner, sink);
		const plot = await handle.read();
		expect(upserts).toEqual([plot]);
	});

	test("editIntent / setStatus refresh from the mutator return value", async () => {
		const { inner } = recorderHandle();
		const { sink, upserts } = recordingSink();
		const handle = new UserPlotHandle(inner, sink);
		const edited = await handle.editIntent({ goal: "g" });
		const status = await handle.setStatus("ready");
		expect(upserts).toEqual([edited, status]);
	});

	test("detach / append re-read the plot before refreshing the projection", async () => {
		const { inner, calls } = recorderHandle();
		const { sink, upserts } = recordingSink();
		const handle = new UserPlotHandle(inner, sink);
		await handle.detach("att-001");
		await handle.append({ type: "note", data: {} });
		// Each mutation triggers a follow-up read whose result feeds the sink.
		expect(calls.map((c) => c.method)).toEqual(["detach", "read", "append", "read"]);
		expect(upserts).toHaveLength(2);
	});

	test("no sink wired → no extra reads on detach/append", async () => {
		const { inner, calls } = recorderHandle();
		const handle = new UserPlotHandle(inner);
		await handle.detach("att-001");
		await handle.append({ type: "note", data: {} });
		expect(calls.map((c) => c.method)).toEqual(["detach", "append"]);
	});

	test("AgentPlotHandle append refreshes the projection after a permitted write", async () => {
		const { inner, calls } = recorderHandle();
		const { sink, upserts } = recordingSink();
		const handle = new AgentPlotHandle(inner, sink);
		await handle.append({ type: "note", data: {} });
		expect(calls.map((c) => c.method)).toEqual(["append", "read"]);
		expect(upserts).toHaveLength(1);
	});
});
