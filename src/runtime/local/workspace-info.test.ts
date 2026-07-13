/**
 * `LocalProvider.workspaceInfo` (warren-e9e1) — the burrow-backed workspace/branch
 * resolver reap now calls instead of an inline `burrows.get`. Must faithfully
 * reproduce reap's old inline shape: the host worktree path + the
 * (non-empty-or-null) branch, and a THROW on a burrow error so the domain records
 * `workspace_lookup`.
 */

import { describe, expect, test } from "bun:test";
import type { Burrow } from "@os-eco/burrow-cli";
import { BurrowClient } from "../../burrow-client/index.ts";
import { fakeBurrowClient, makeBurrow } from "../../runs/reap/test-helpers.ts";
import type { RunHandle } from "../contract.ts";
import { LocalProvider } from "./provider.ts";

const HANDLE: RunHandle = {
	runId: "run_aaaaaaaaaaaa",
	sandboxId: "bur_aaaaaaaaaaaa",
	providerRunId: "run_zzzzzzzzzzzz",
};

function provider(client: BurrowClient): LocalProvider {
	return new LocalProvider({ burrowClient: () => client });
}

describe("LocalProvider.workspaceInfo", () => {
	test("returns the live burrow worktree path + branch", async () => {
		const client = fakeBurrowClient(makeBurrow());
		const info = await provider(client).workspaceInfo(HANDLE);
		expect(info).toEqual({ workspacePath: "/data/burrow/ws", branch: "agent/refactor-bot/run-1" });
	});

	test("coerces an empty burrow branch to null (reap's historical HEAD fallback)", async () => {
		const client = fakeBurrowClient(makeBurrow({ branch: "" } as Partial<Burrow>));
		const info = await provider(client).workspaceInfo(HANDLE);
		expect(info.workspacePath).toBe("/data/burrow/ws");
		expect(info.branch).toBeNull();
	});

	test("throws when the burrow lookup fails (domain records workspace_lookup)", async () => {
		const client = new BurrowClient({
			config: { transport: { kind: "unix", path: "/tmp/x.sock" } },
			fetch: (async () =>
				new Response("{}", {
					status: 200,
					headers: { "content-type": "application/json" },
				})) as unknown as typeof fetch,
		});
		(client.http.burrows as unknown as { get: () => Promise<Burrow> }).get = async () => {
			throw new Error("burrow gone");
		};
		await expect(provider(client).workspaceInfo(HANDLE)).rejects.toThrow("burrow gone");
	});
});
