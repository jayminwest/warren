/**
 * The conformance suite, exercised against the FakeTracker reference
 * (warren-53ea). The publishable claim: the suite PASSES against the
 * reference server in every supported capability configuration, and
 * FAILS a server that breaks negotiation or the base contract.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { runConformanceSuite } from "./conformance.ts";
import { startFakeTracker, type RunningFakeTracker } from "./fake-tracker/server.ts";
import { FakeTrackerStore, type FakeTrackerFixture } from "./fake-tracker/store.ts";

const FULL_FIXTURE: FakeTrackerFixture = {
	issues: [
		{
			id: "ext-1",
			status: "open",
			title: "first",
			description: "probe issue",
			scheduledFor: "2026-09-01T00:00:00.000Z",
		},
		{ id: "ext-2", status: "in_progress", title: "second", blockedBy: ["ext-1"] },
		{ id: "ext-3", status: "closed", title: "already closed" },
	],
	plans: [
		{
			id: "pl-ext-1",
			status: "active",
			children: ["ext-1", "ext-2"],
			steps: [{ title: "first" }, { title: "second", blocks: [] }],
		},
	],
};

const BASE_ONLY_FIXTURE: FakeTrackerFixture = {
	issues: [{ id: "ext-1", status: "open", title: "probe" }],
};

let running: RunningFakeTracker | undefined;

async function bootFake(
	fixture: FakeTrackerFixture,
	overrides: {
		capabilities?: {
			supportsPlans?: boolean;
			supportsMetadata?: boolean;
			supportsScheduledIssues?: boolean;
			isGitNative?: boolean;
		};
		protocolVersion?: string;
		bearerToken?: string;
	} = {},
): Promise<RunningFakeTracker> {
	running = await startFakeTracker({
		store: new FakeTrackerStore(fixture),
		...(overrides.capabilities !== undefined ? { capabilities: overrides.capabilities } : {}),
		...(overrides.protocolVersion !== undefined
			? { protocolVersion: overrides.protocolVersion }
			: {}),
		...(overrides.bearerToken !== undefined ? { bearerToken: overrides.bearerToken } : {}),
	});
	return running;
}

afterEach(async () => {
	await running?.stop();
	running = undefined;
});

describe("runConformanceSuite against FakeTracker", () => {
	test("passes with every capability enabled (full fixture)", async () => {
		const fake = await bootFake(FULL_FIXTURE);
		const result = await runConformanceSuite({ baseUrl: fake.url });
		expect(result.failures).toEqual([]);
		expect(result.passed).toBe(true);
		expect(result.versionNegotiated).toBe(true);
		expect(result.casesRun).toBeGreaterThanOrEqual(10);
	});

	test("passes with every optional capability off (base contract only)", async () => {
		const fake = await bootFake(BASE_ONLY_FIXTURE, {
			capabilities: {
				supportsPlans: false,
				supportsMetadata: false,
				supportsScheduledIssues: false,
				isGitNative: false,
			},
		});
		const result = await runConformanceSuite({ baseUrl: fake.url });
		expect(result.failures).toEqual([]);
		expect(result.passed).toBe(true);
	});

	test("rejects a wrong protocol version at negotiation and judges nothing else", async () => {
		const fake = await bootFake(FULL_FIXTURE, { protocolVersion: "warren-tracker/v0" });
		const result = await runConformanceSuite({ baseUrl: fake.url });
		expect(result.passed).toBe(false);
		expect(result.versionNegotiated).toBe(false);
		expect(result.failures.some((f) => f.case === "capabilities/negotiation")).toBe(true);
		// Negotiation failure aborts: only the negotiation case group ran.
		expect(result.casesRun).toBe(1);
	});

	test("honors the bearer-token arm: a credentialed suite passes, an uncredentialed one fails", async () => {
		const fake = await bootFake(FULL_FIXTURE, { bearerToken: "sekrit" });
		const denied = await runConformanceSuite({ baseUrl: fake.url });
		expect(denied.passed).toBe(false);
		const allowed = await runConformanceSuite({ baseUrl: fake.url, bearerToken: "sekrit" });
		expect(allowed.failures).toEqual([]);
		expect(allowed.passed).toBe(true);
	});

	test("fails a server whose close is not idempotent", async () => {
		// A deliberately broken server: second close of the same id 500s.
		let closes = 0;
		const broken = await startFakeTracker({ store: new FakeTrackerStore(BASE_ONLY_FIXTURE) });
		running = broken;
		const fetchImpl: typeof fetch = Object.assign(
			async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
				const url =
					typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
				if (url.includes("/close")) {
					closes++;
					if (closes > 1) {
						return new Response(JSON.stringify({ error: { code: "boom", message: "no" } }), {
							status: 500,
							headers: { "content-type": "application/json" },
						});
					}
				}
				return fetch(input, init);
			},
			{ preconnect: () => {} },
		);
		const result = await runConformanceSuite({ baseUrl: broken.url, fetchImpl });
		expect(result.passed).toBe(false);
		expect(result.failures.some((f) => f.case === "issues/close-idempotent")).toBe(true);
	});
});
