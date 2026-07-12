/**
 * `LocalProvider.terminate()` — burrow's `DELETE /burrows/:id` with
 * `archive: true` (`http.burrows.destroy`) wrapped as the seam's
 * `terminate(handle)` (pl-829f step 11). Drives the real body against the
 * burrow-client fetch-stub fake so target/archive-flag param construction, the
 * `DestroyBurrowResult` → `TeardownResult` mapping, and error propagation are
 * exercised with no real socket.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { NotFoundError } from "@os-eco/burrow-cli";
import { BurrowClient, BurrowUnreachableError } from "../../burrow-client/index.ts";
import type { WarrenDb } from "../../db/client.ts";
import type { Repos } from "../../db/repos/index.ts";
import {
	type BurrowFetchPlan,
	makeBurrowClient,
	makePool,
	type RecordedCall,
	setupRepos,
	stub,
} from "../../runs/spawn/test-helpers.ts";
import type { RunHandle } from "../contract.ts";
import { LocalProvider } from "./provider.ts";

let openDb: WarrenDb | null = null;

afterEach(() => {
	openDb?.close();
	openDb = null;
});

async function repos(): Promise<Repos> {
	const { db, repos } = await setupRepos();
	openDb = db;
	return repos;
}

const HANDLE: RunHandle = {
	runId: "run_domain0001",
	sandboxId: "bur_aaaaaaaaaaaa",
	providerRunId: "run_zzzzzzzzzzzz",
};

async function localProvider(
	plan: BurrowFetchPlan = {},
): Promise<{ provider: LocalProvider; calls: RecordedCall[] }> {
	const r = await repos();
	const { client, calls } = makeBurrowClient(plan);
	const pool = await makePool(r, client);
	const provider = new LocalProvider({ burrowClient: () => pool });
	return { provider, calls };
}

/** The recorded `DELETE /burrows/:id` request (there is exactly one). */
function destroyCall(calls: RecordedCall[]): RecordedCall {
	const call = calls.find((c) => c.method === "DELETE" && /^\/burrows\/[^/]+$/.test(c.path));
	if (call === undefined) throw new Error("no destroy call recorded");
	return call;
}

/** A fully-populated burrow `DestroyBurrowResult` body for the stub. */
function destroyBody(archived: unknown): unknown {
	return {
		burrowId: "bur_aaaaaaaaaaaa",
		archived,
		deletedEvents: 12,
		deletedMessages: 3,
		deletedRuns: 1,
	};
}

describe("LocalProvider.terminate — param mapping to burrows.destroy", () => {
	test("targets the burrow (handle.sandboxId) with archive=true", async () => {
		const { provider, calls } = await localProvider({ destroyBody: destroyBody(null) });
		await provider.terminate(HANDLE);
		const call = destroyCall(calls);
		expect(call.path).toBe("/burrows/bur_aaaaaaaaaaaa");
		// archive rides the query string (?archive=true), the reap path — distinct
		// from create()'s partial-failure cleanup which passes archive=false.
		expect(call.search).toContain("archive=true");
		expect(call.search).not.toContain("archive=false");
	});
});

describe("LocalProvider.terminate — DestroyBurrowResult → TeardownResult mapping", () => {
	test("archived record collapses to archived:true, counts forwarded 1:1", async () => {
		const { provider } = await localProvider({
			// burrow returns the archive record when archive:true prunes rows.
			destroyBody: destroyBody({
				burrowId: "bur_aaaaaaaaaaaa",
				archivePath: "/data/burrow/archive/bur_aaaaaaaaaaaa",
				eventCount: 12,
				messageCount: 3,
				runCount: 1,
			}),
		});
		const result = await provider.terminate(HANDLE);
		expect(result).toEqual({
			archived: true,
			deletedEvents: 12,
			deletedMessages: 3,
			deletedRuns: 1,
		});
	});

	test("null archive record collapses to archived:false", async () => {
		const { provider } = await localProvider({ destroyBody: destroyBody(null) });
		const result = await provider.terminate(HANDLE);
		expect(result.archived).toBe(false);
		expect(result.deletedEvents).toBe(12);
		expect(result.deletedMessages).toBe(3);
		expect(result.deletedRuns).toBe(1);
	});

	test("zero-count teardown maps cleanly", async () => {
		const { provider } = await localProvider({
			destroyBody: {
				burrowId: "bur_aaaaaaaaaaaa",
				archived: null,
				deletedEvents: 0,
				deletedMessages: 0,
				deletedRuns: 0,
			},
		});
		const result = await provider.terminate(HANDLE);
		expect(result).toEqual({
			archived: false,
			deletedEvents: 0,
			deletedMessages: 0,
			deletedRuns: 0,
		});
	});
});

describe("LocalProvider.terminate — error propagation", () => {
	test("burrow NotFoundError propagates unchanged (domain owns best-effort)", async () => {
		const { provider } = await localProvider({
			destroyStatus: 404,
			destroyBody: { error: { code: "not_found", message: "burrow gone" } },
		});
		await expect(provider.terminate(HANDLE)).rejects.toBeInstanceOf(NotFoundError);
	});

	test("a dead socket surfaces as BurrowUnreachableError", async () => {
		const r = await repos();
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: stub(async () => {
				throw new TypeError("Unable to connect");
			}),
		});
		const pool = await makePool(r, client);
		const provider = new LocalProvider({ burrowClient: () => pool });
		await expect(provider.terminate(HANDLE)).rejects.toBeInstanceOf(BurrowUnreachableError);
	});
});
