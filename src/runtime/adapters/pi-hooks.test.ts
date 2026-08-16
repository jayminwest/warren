/**
 * Ported from burrow's `src/runtime/pi.test.ts` (warren-7933) — the
 * workspace-hook, session-recovery, and steering-predicate half. The argv /
 * stdin-encoding tests live in `./pi.test.ts` (file-size budget).
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { piAdapter } from "./pi.ts";
import { PI_SESSION_DIR } from "./pi-argv.ts";
import { readNewestPiSessionId } from "./pi-session.ts";
import type { AdapterRuntimeEvent, SteeringMessage } from "./types.ts";

function fakeMessage(extra: Partial<SteeringMessage> = {}): SteeringMessage {
	return {
		body: "stop and write tests first",
		priority: "high",
		...extra,
	};
}

describe("piAdapter.encodeInboxMessage", () => {
	test("emits one prompt RPC envelope per message tagged with priority", () => {
		const out = piAdapter.encodeInboxMessage?.([
			fakeMessage({ body: "first", priority: "urgent" }),
			fakeMessage({ body: "second", priority: "low" }),
		]);
		expect(out?.stdin.endsWith("\n")).toBe(true);
		const lines = out?.stdin.split("\n").slice(0, -1) ?? [];
		expect(lines).toHaveLength(2);
		const parsed = lines.map((l) => JSON.parse(l) as { type: string; message: string });
		expect(parsed[0]?.type).toBe("prompt");
		expect(parsed[0]?.message).toContain("priority: urgent");
		expect(parsed[1]?.message).toContain("priority: low");
	});
});

describe("piAdapter.prepareWorkspace", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warren-pi-prep-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("creates the .pi/sessions/ directory under the workspace", async () => {
		await piAdapter.prepareWorkspace?.({ runId: "run_pi", workspacePath: dir });
		const fs = await import("node:fs");
		expect(fs.statSync(join(dir, PI_SESSION_DIR)).isDirectory()).toBe(true);
	});

	test("is idempotent when the directory already exists", async () => {
		await piAdapter.prepareWorkspace?.({ runId: "run_pi", workspacePath: dir });
		await piAdapter.prepareWorkspace?.({ runId: "run_pi", workspacePath: dir });
		expect(readdirSync(join(dir, PI_SESSION_DIR))).toEqual([]);
	});
});

describe("piAdapter.extractMetadata", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warren-pi-extract-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("reads session_id from the newest session jsonl header", async () => {
		const sessionDir = join(dir, PI_SESSION_DIR);
		await mkdir(sessionDir, { recursive: true });
		// Two sessions — the second one (later mtime) wins.
		await writeFile(
			join(sessionDir, "2026-05-13T15-56-59-311Z_old-session-id.jsonl"),
			`${JSON.stringify({ type: "session", version: 3, id: "old-session-id" })}\n`,
		);
		// Force an older mtime on the first file.
		const oldTime = new Date(Date.now() - 60_000);
		await utimes(
			join(sessionDir, "2026-05-13T15-56-59-311Z_old-session-id.jsonl"),
			oldTime,
			oldTime,
		);
		await writeFile(
			join(sessionDir, "2026-05-13T15-58-00-000Z_new-session-id.jsonl"),
			`${JSON.stringify({
				type: "session",
				version: 3,
				id: "019e220e-3e2e-73cd-ac0b-ed36c073dfed",
			})}\n${JSON.stringify({ type: "model_change" })}\n`,
		);
		const patch = await piAdapter.extractMetadata?.({ runId: "run_pi", workspacePath: dir });
		expect(patch).toEqual({ session_id: "019e220e-3e2e-73cd-ac0b-ed36c073dfed" });
	});

	test("returns undefined when the session directory is missing", async () => {
		const patch = await piAdapter.extractMetadata?.({ runId: "run_pi", workspacePath: dir });
		expect(patch).toBeUndefined();
	});

	test("returns undefined when no jsonl files are present", async () => {
		await mkdir(join(dir, PI_SESSION_DIR), { recursive: true });
		const patch = await piAdapter.extractMetadata?.({ runId: "run_pi", workspacePath: dir });
		expect(patch).toBeUndefined();
	});

	test("returns undefined when the header line is malformed", async () => {
		const sessionDir = join(dir, PI_SESSION_DIR);
		await mkdir(sessionDir, { recursive: true });
		writeFileSync(join(sessionDir, "broken.jsonl"), "not json\n");
		const patch = await piAdapter.extractMetadata?.({ runId: "run_pi", workspacePath: dir });
		expect(patch).toBeUndefined();
	});

	test("returns undefined when the header is not a session envelope", async () => {
		const sessionDir = join(dir, PI_SESSION_DIR);
		await mkdir(sessionDir, { recursive: true });
		// First line is e.g. a model_change — not a session header.
		writeFileSync(
			join(sessionDir, "wrong-shape.jsonl"),
			`${JSON.stringify({ type: "model_change", modelId: "x" })}\n`,
		);
		const patch = await piAdapter.extractMetadata?.({ runId: "run_pi", workspacePath: dir });
		expect(patch).toBeUndefined();
	});
});

describe("readNewestPiSessionId", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "warren-pi-newest-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	test("returns undefined for a missing directory", () => {
		expect(readNewestPiSessionId(join(dir, "does-not-exist"))).toBeUndefined();
	});

	test("ignores non-jsonl files in the same directory", () => {
		writeFileSync(join(dir, "notes.txt"), "ignore");
		writeFileSync(
			join(dir, "session.jsonl"),
			`${JSON.stringify({ type: "session", id: "abc" })}\n`,
		);
		expect(readNewestPiSessionId(dir)).toBe("abc");
	});
});

describe("piAdapter.parseEvents", () => {
	test("delegates to parsePiEvents — RPC ack becomes state_change/system", () => {
		const events =
			piAdapter.parseEvents?.(
				JSON.stringify({ type: "response", command: "prompt", success: true }),
			) ?? [];
		expect(events).toHaveLength(1);
		expect(events[0]?.kind).toBe("state_change");
		expect(events[0]?.stream).toBe("system");
	});
});

describe("piAdapter.encodeSteeringMessage (burrow-250d)", () => {
	// Mid-run steering encoder: one pi RPC prompt envelope per message,
	// tagged with the standard [STEERING] prefix and a trailing newline
	// so the line is framed for pi's NDJSON read loop. The dispatcher's
	// mid-run poll loop (burrow SPEC §13.5) writes this verbatim to the
	// still-open child stdin.
	test("emits exactly one prompt RPC envelope terminated by \\n", () => {
		const out = piAdapter.encodeSteeringMessage?.(
			fakeMessage({ body: "stop and write tests", priority: "high" }),
		);
		expect(out?.stdin.endsWith("\n")).toBe(true);
		const lines = out?.stdin.trimEnd().split("\n") ?? [];
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0] ?? "") as { type: string; message: string };
		expect(parsed.type).toBe("prompt");
		expect(parsed.message).toContain("[STEERING]");
		expect(parsed.message).toContain("priority: high");
		expect(parsed.message).toContain("stop and write tests");
	});

	test("priority prefix matches the at-spawn encoder (parity with encodeInboxMessage)", () => {
		const msg = fakeMessage({ body: "urgent thing", priority: "urgent" });
		const midRun = piAdapter.encodeSteeringMessage?.(msg)?.stdin;
		const atSpawn = piAdapter.encodeInboxMessage?.([msg])?.stdin;
		// Same wire shape regardless of whether the message landed in
		// pendingMessages (atSpawn) or arrived mid-run (midRun) — both
		// terminate the JSON envelope with \n so pi's line-delimited RPC
		// loop processes it (burrow-faf5).
		expect(midRun).toBe(atSpawn);
	});
});

describe("piAdapter.autoRespondToEvent (extension_ui_request decline)", () => {
	test("declines extension_ui_request with cancelled response carrying request id", () => {
		const events =
			piAdapter.parseEvents?.(
				JSON.stringify({
					type: "extension_ui_request",
					id: "ui-req-42",
					extensionId: "ext.foo",
					prompt: "approve?",
				}),
			) ?? [];
		const ev = events[0];
		if (!ev) throw new Error("expected one event");
		const out = piAdapter.autoRespondToEvent?.(ev);
		expect(out).toBeDefined();
		expect(JSON.parse(out?.stdin.trimEnd() ?? "")).toEqual({
			type: "extension_ui_response",
			id: "ui-req-42",
			cancelled: true,
		});
		expect(out?.stdin.endsWith("\n")).toBe(true);
	});

	test("returns undefined for non-extension_ui_request events", () => {
		const ev: AdapterRuntimeEvent = { kind: "text", stream: "stdout", payload: { text: "hi" } };
		expect(piAdapter.autoRespondToEvent?.(ev)).toBeUndefined();
	});
});

describe("piAdapter.shouldCloseStdinOnEvent (burrow-5db3)", () => {
	// pi v0.74.0 exits the instant stdin closes (mx-d9b3ad), so the
	// dispatcher must withhold stdin EOF until pi's terminal lifecycle
	// envelope arrives. The predicate below is what the dispatcher polls
	// per persisted event.
	test("returns true for agent_end state_change envelopes", () => {
		const ev = piAdapter.parseEvents?.(JSON.stringify({ type: "agent_end" }))[0];
		if (!ev) throw new Error("expected one event from agent_end envelope");
		expect(piAdapter.shouldCloseStdinOnEvent?.(ev)).toBe(true);
	});

	test("returns false for non-terminal lifecycle envelopes", () => {
		const samples = [
			JSON.stringify({ type: "response", command: "prompt", success: true }),
			JSON.stringify({ type: "agent_start" }),
			JSON.stringify({ type: "turn_start" }),
			JSON.stringify({ type: "turn_end" }),
			JSON.stringify({ type: "tool_execution_start" }),
			JSON.stringify({ type: "tool_execution_end" }),
		];
		for (const line of samples) {
			const ev = piAdapter.parseEvents?.(line)[0];
			if (!ev) throw new Error(`expected one event from ${line}`);
			expect(piAdapter.shouldCloseStdinOnEvent?.(ev)).toBe(false);
		}
	});

	test("returns false for assistant content events (text / thinking / tool_use)", () => {
		// agent_end mapping is intentionally narrow — closing stdin on an
		// intermediate message_end would truncate pi mid-turn.
		const ev: AdapterRuntimeEvent = { kind: "text", stream: "stdout", payload: { text: "ack" } };
		expect(piAdapter.shouldCloseStdinOnEvent?.(ev)).toBe(false);
	});
});
