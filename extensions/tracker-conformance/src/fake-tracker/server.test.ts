/**
 * FakeTracker reference-server semantics (warren-53ea): the store
 * behaviors the protocol pins down, the state-file observation seam,
 * and the CLI argument parser.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseFakeTrackerArgs } from "../fake-tracker.ts";
import { createFakeTrackerHandler } from "./server.ts";
import { FakeTrackerStore, type FakeTrackerStateFile } from "./store.ts";

describe("FakeTrackerStore", () => {
	test("close is idempotent and misses unknown ids", () => {
		const store = new FakeTrackerStore({ issues: [{ id: "a", status: "open" }] });
		expect(store.closeIssue("a")).toBe("closed");
		expect(store.closeIssue("a")).toBe("closed");
		expect(store.closeIssue("missing")).toBe("not_found");
		expect(store.getIssue("a")?.status).toBe("closed");
	});

	test("metadata merge is shallow and an explicit null clears the key", () => {
		const store = new FakeTrackerStore({
			issues: [{ id: "a", status: "open", metadata: { keep: 1, drop: 2 } }],
		});
		expect(store.mergeMetadata("a", { add: 3, drop: null })).toBe("merged");
		expect(store.getIssue("a")?.metadata).toEqual({ keep: 1, add: 3 });
		expect(store.mergeMetadata("missing", {})).toBe("not_found");
	});

	test("scheduled list excludes closed issues and issues without scheduledFor", () => {
		const store = new FakeTrackerStore({
			issues: [
				{ id: "a", status: "open", scheduledFor: "2026-09-01T00:00:00.000Z" },
				{ id: "b", status: "closed", scheduledFor: "2026-09-01T00:00:00.000Z" },
				{ id: "c", status: "open" },
			],
		});
		expect(store.listScheduledIssues().map((i) => i.id)).toEqual(["a"]);
	});

	test("state file mirrors mutations plus the recorded-call journal", async () => {
		const dir = await mkdtemp(join(tmpdir(), "fake-tracker-store-"));
		const stateFile = join(dir, "state.json");
		const store = new FakeTrackerStore({ issues: [{ id: "a", status: "open" }] }, stateFile);
		store.recordCall("POST", "/issues/a/close");
		store.closeIssue("a");
		await store.flush();
		const snapshot = JSON.parse(await readFile(stateFile, "utf8")) as FakeTrackerStateFile;
		expect(snapshot.issues[0]?.status).toBe("closed");
		expect(snapshot.calls).toHaveLength(1);
		expect(snapshot.calls[0]?.path).toBe("/issues/a/close");
	});
});

describe("createFakeTrackerHandler", () => {
	test("every non-2xx carries the error envelope", async () => {
		const handler = createFakeTrackerHandler({ store: new FakeTrackerStore() });
		const response = await handler(new Request("http://x/issues/nope"));
		expect(response.status).toBe(404);
		expect(response.headers.get("content-type")).toContain("application/json");
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("issue_not_found");
	});

	test("a capability-off surface 404s with capability_not_supported", async () => {
		const handler = createFakeTrackerHandler({
			store: new FakeTrackerStore(),
			capabilities: { supportsPlans: false },
		});
		const response = await handler(new Request("http://x/plans"));
		expect(response.status).toBe(404);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("capability_not_supported");
	});

	test("rejects an uncredentialed request when a bearer is configured", async () => {
		const handler = createFakeTrackerHandler({
			store: new FakeTrackerStore(),
			bearerToken: "sekrit",
		});
		const denied = await handler(new Request("http://x/capabilities"));
		expect(denied.status).toBe(401);
		const allowed = await handler(
			new Request("http://x/capabilities", { headers: { authorization: "Bearer sekrit" } }),
		);
		expect(allowed.status).toBe(200);
	});
});

describe("parseFakeTrackerArgs", () => {
	test("defaults: port 8080, all optional capabilities on, not git-native", () => {
		const args = parseFakeTrackerArgs([]);
		expect(args.port).toBe(8080);
		expect(args.capabilities).toEqual({
			supportsPlans: true,
			supportsMetadata: true,
			supportsScheduledIssues: true,
			isGitNative: false,
		});
	});

	test("parses the full flag set", () => {
		const args = parseFakeTrackerArgs([
			"--port",
			"0",
			"--fixture",
			"f.json",
			"--state-file",
			"s.json",
			"--bearer",
			"tok",
			"--protocol-version",
			"warren-tracker/v0",
			"--no-plans",
			"--no-metadata",
			"--no-scheduled-issues",
			"--git-native",
		]);
		expect(args.port).toBe(0);
		expect(args.fixturePath).toBe("f.json");
		expect(args.stateFilePath).toBe("s.json");
		expect(args.bearerToken).toBe("tok");
		expect(args.protocolVersion).toBe("warren-tracker/v0");
		expect(args.capabilities).toEqual({
			supportsPlans: false,
			supportsMetadata: false,
			supportsScheduledIssues: false,
			isGitNative: true,
		});
	});

	test("rejects an unknown flag and a value-less flag", () => {
		expect(() => parseFakeTrackerArgs(["--wat"])).toThrow("unknown flag");
		expect(() => parseFakeTrackerArgs(["--port"])).toThrow("requires a value");
	});
});
