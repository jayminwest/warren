/**
 * `LocalProvider.cancel()` — burrow's `POST /runs/:id/cancel`
 * (`http.runs.cancel`) wrapped as the seam's `cancel(handle, reason?)`
 * (pl-829f step 11). Drives the real body against the burrow-client fetch-stub
 * fake so target-run resolution, the steer-identical "omit reason when
 * undefined" default, idempotency on an already-terminal run, and error
 * propagation are exercised with no real socket.
 */

import { afterEach, describe, expect, test } from "bun:test";
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
import { RuntimeRunNotFoundError } from "../errors.ts";
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

/** The recorded `POST /runs/:id/cancel` request (there is exactly one). */
function cancelCall(calls: RecordedCall[]): RecordedCall {
	const call = calls.find((c) => c.method === "POST" && /\/cancel$/.test(c.path));
	if (call === undefined) throw new Error("no cancel call recorded");
	return call;
}

describe("LocalProvider.cancel — param mapping to runs.cancel", () => {
	test("targets the run (handle.providerRunId), not the burrow", async () => {
		const { provider, calls } = await localProvider({ cancelRun: { state: "cancelled" } });
		await provider.cancel(HANDLE);
		const call = cancelCall(calls);
		expect(call.path).toBe("/runs/run_zzzzzzzzzzzz/cancel");
		// scoped per-run: the burrowId (sandboxId) must not appear in the path.
		expect(call.path).not.toContain("bur_aaaaaaaaaaaa");
	});

	test("forwards reason when supplied", async () => {
		const { provider, calls } = await localProvider({ cancelRun: { state: "cancelled" } });
		await provider.cancel(HANDLE, "operator requested stop");
		expect(cancelCall(calls).body).toEqual({ reason: "operator requested stop" });
	});

	test("omits reason when undefined — identical to cancelRun's default", async () => {
		const { provider, calls } = await localProvider({ cancelRun: { state: "cancelled" } });
		await provider.cancel(HANDLE);
		// http.runs.cancel sends no jsonBody when reason is omitted, so the
		// recorded body is undefined (no request payload) — the provider invents
		// no default, byte-for-byte with src/runs/cancel.ts.
		expect(cancelCall(calls).body).toBeUndefined();
	});

	test("resolves to void (the post-cancel Run row is discarded)", async () => {
		const { provider } = await localProvider({ cancelRun: { state: "cancelled" } });
		const result = await provider.cancel(HANDLE, "stop");
		expect(result).toBeUndefined();
	});
});

describe("LocalProvider.cancel — idempotency", () => {
	test("cancelling an already-terminal run burrow knows about resolves clean", async () => {
		// burrow's cancel is idempotent: a terminal run returns 200 with the
		// current row (no throw). The provider surfaces that as a plain void.
		const { provider, calls } = await localProvider({
			cancelStatus: 200,
			cancelRun: { state: "succeeded", exitCode: 0 },
		});
		await expect(provider.cancel(HANDLE)).resolves.toBeUndefined();
		expect(cancelCall(calls).path).toBe("/runs/run_zzzzzzzzzzzz/cancel");
	});
});

describe("LocalProvider.cancel — error propagation", () => {
	test("burrow NotFoundError is neutralized to RuntimeRunNotFoundError (warren-1f56)", async () => {
		const { provider } = await localProvider({
			cancelStatus: 404,
			cancelBody: { error: { code: "not_found", message: "run gone" } },
		});
		await expect(provider.cancel(HANDLE)).rejects.toBeInstanceOf(RuntimeRunNotFoundError);
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
		await expect(provider.cancel(HANDLE)).rejects.toBeInstanceOf(BurrowUnreachableError);
	});
});
