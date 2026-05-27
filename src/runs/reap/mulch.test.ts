import { describe, expect, test } from "bun:test";
import { mergeMulchFile } from "./index.ts";

/* ----------------------------------------------------------------------- */
/* Pure mergeMulchFile cases                                                */
/* ----------------------------------------------------------------------- */

describe("mergeMulchFile (pure)", () => {
	test("appends incoming records into an empty existing file", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (kind: string, payload: unknown) => {
			events.push({ kind, payload });
			return {} as never;
		};
		const incoming =
			'{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"a"}\n' +
			'{"id":"mx-2","recorded_at":"2026-05-08T20:01:00Z","content":"b"}\n';
		const result = await mergeMulchFile("build", "", incoming, emit);
		expect(result.appended).toBe(2);
		expect(result.updated).toBe(0);
		expect(result.skipped).toBe(0);
		expect(result.merged.split("\n").filter(Boolean)).toHaveLength(2);
		expect(events.filter((e) => e.kind === "mulch.record.added")).toHaveLength(2);
	});

	test("replaces existing record when incoming recorded_at is newer", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"old"}\n';
		const incoming = '{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n';
		const result = await mergeMulchFile("build", existing, incoming, emit);
		expect(result.updated).toBe(1);
		expect(result.skipped).toBe(0);
		expect(result.appended).toBe(0);
		expect(result.merged).toContain('"content":"new"');
		expect(result.merged).not.toContain('"content":"old"');
		expect(events.find((e) => e.kind === "mulch.record.updated")).toBeDefined();
	});

	test("drops incoming when ts <= existing ts and emits skipped", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"id":"mx-1","recorded_at":"2026-05-08T21:00:00Z","content":"new"}\n';
		const incoming = '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"old"}\n';
		const result = await mergeMulchFile("build", existing, incoming, emit);
		expect(result.skipped).toBe(1);
		expect(result.updated).toBe(0);
		expect(result.merged).toContain('"content":"new"');
		expect(events.find((e) => e.kind === "mulch.record.skipped")).toBeDefined();
	});

	test("appends anonymous (no-id) records without conflict", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const existing = '{"recorded_at":"2026-05-08T20:00:00Z","content":"already"}\n';
		const incoming =
			'{"recorded_at":"2026-05-08T20:01:00Z","content":"another"}\n' +
			'{"recorded_at":"2026-05-08T20:02:00Z","content":"and again"}\n';
		const result = await mergeMulchFile("build", existing, incoming, emit);
		expect(result.appended).toBe(2);
		expect(result.skipped).toBe(0);
		expect(result.updated).toBe(0);
		expect(result.merged.split("\n").filter(Boolean)).toHaveLength(3);
	});

	test("emits reap_failed for malformed incoming JSON without aborting", async () => {
		const events: { kind: string; payload: unknown }[] = [];
		const emit = async (k: string, p: unknown) => {
			events.push({ kind: k, payload: p });
			return {} as never;
		};
		const incoming =
			"this is not json\n" + '{"id":"mx-1","recorded_at":"2026-05-08T20:00:00Z","content":"ok"}\n';
		const result = await mergeMulchFile("build", "", incoming, emit);
		expect(result.appended).toBe(1);
		expect(events.find((e) => e.kind === "reap_failed")).toBeDefined();
	});
});
