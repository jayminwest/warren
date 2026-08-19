import { describe, expect, test } from "bun:test";
import { RuntimeRunNotFoundError } from "../errors.ts";
import { LocalRunStore } from "../local/run-store.ts";
import { DOCKER_PROVIDER_CAPABILITIES, DockerProvider } from "./provider.ts";

const handle = { runId: "ghost", sandboxId: "local-ghost", providerRunId: "ghost" };

describe("DockerProvider", () => {
	test("advertises the frozen docker v1 capability set", () => {
		const provider = new DockerProvider();
		expect(provider.capabilities).toBe(DOCKER_PROVIDER_CAPABILITIES);
		expect(provider.capabilities.networkPolicy).toBe("coarse");
		expect(provider.capabilities.previewPorts).toBe(false);
		expect(provider.capabilities.midRunSteering).toBe(true);
	});

	test("reports kind docker (warren-e1f1)", () => {
		expect(new DockerProvider().kind).toBe("docker");
	});

	test("status never throws on an unknown run — it reports lost (§6.7)", async () => {
		const provider = new DockerProvider({ store: new LocalRunStore() });
		const status = await provider.status(handle);
		expect(status.exists).toBe(false);
		expect(status.terminalReason).toBe("lost");
	});

	test("streamEvents rethrows the neutral not-found error for a ghost run", async () => {
		const provider = new DockerProvider({ store: new LocalRunStore() });
		const iter = provider.streamEvents(handle)[Symbol.asyncIterator]();
		await expect(iter.next()).rejects.toBeInstanceOf(RuntimeRunNotFoundError);
	});

	test("sendMessage throws the neutral not-found error for a ghost sandbox", async () => {
		const provider = new DockerProvider({ store: new LocalRunStore() });
		await expect(provider.sendMessage(handle, { body: "steer" })).rejects.toBeInstanceOf(
			RuntimeRunNotFoundError,
		);
	});

	test("terminate on a ghost run is a no-op teardown", async () => {
		const provider = new DockerProvider({ store: new LocalRunStore() });
		const result = await provider.terminate(handle);
		expect(result.deletedRuns).toBe(0);
		expect(result.archived).toBe(false);
	});
});
