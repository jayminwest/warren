/**
 * Tests for the warren-owned preview sidecar resolver (warren-4bf3): the
 * null-on-unknown-sandbox contract plus the burrow-era facade call shape the
 * preview domain modules consume unchanged.
 */

import { describe, expect, test } from "bun:test";
import type { SandboxProfile } from "../../../sandbox/types.ts";
import { LocalSidecarRegistry } from "./registry.ts";
import { createLocalSidecarsResolver } from "./sidecars.ts";

function makeProfile(): SandboxProfile {
	return {
		workspace: "/tmp/ws",
		home: "/tmp/home",
		readOnlyMounts: [],
		network: "open",
		allowedDomains: [],
		envPassthrough: [],
		setEnv: {},
		toolchainPaths: [],
	};
}

function makeHarness(known: boolean) {
	const created: { sandboxId: string; command: readonly string[] }[] = [];
	const registry = new LocalSidecarRegistry({
		profileFor: () => (known ? makeProfile() : null),
		spawn: async (_profile, command) => {
			created.push({ sandboxId: "local-run_1", command: command.argv });
			const exited = new Promise<number>(() => {});
			return {
				pid: 4321,
				stdout: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
				stderr: new ReadableStream<Uint8Array>({ start: (c) => c.close() }),
				exited,
				cancel: () => {},
			};
		},
	});
	return { registry, created, resolve: createLocalSidecarsResolver(registry) };
}

describe("createLocalSidecarsResolver", () => {
	test("returns null when the sandbox is unknown to the store", async () => {
		const { resolve } = makeHarness(false);
		expect(await resolve("local-ghost")).toBeNull();
	});

	test("maps the burrow-era facade call shape onto the registry", async () => {
		const { resolve, created } = makeHarness(true);
		const facade = await resolve("local-run_1");
		expect(facade).not.toBeNull();
		if (facade === null) return;
		const createdRecord = await facade.create({
			sandboxId: "local-run_1",
			command: ["sh", "-c", "bun run dev"],
			env: { PORT: "3000" },
			inboundPortForward: { hostPort: 40123, sandboxPort: 3000 },
		});
		expect(createdRecord.id).toMatch(/^sc_/);
		expect(createdRecord.state).toBe("live");
		expect(created.length).toBe(1);
		expect(created[0]?.command).toEqual(["sh", "-c", "bun run dev"]);

		const status = await facade.get("local-run_1", createdRecord.id);
		expect(status.state).toBe("live");
		expect(status.exitCode).toBeNull();

		const list = await facade.list("local-run_1");
		expect(list.map((sc) => sc.id)).toContain(createdRecord.id);

		const logs = await facade.logs("local-run_1", createdRecord.id);
		expect(logs).toEqual({ stdout: "", stderr: "" });

		await facade.delete("local-run_1", createdRecord.id);
		expect((await facade.get("local-run_1", createdRecord.id)).state).toBe("torn-down");
	});
});
