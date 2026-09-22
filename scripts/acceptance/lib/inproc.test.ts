/**
 * Unit tests for the warren-f074 capture-and-attach path: when a booted
 * child fails to reach healthz, the timeout error must carry the child's
 * buffered output and exit status instead of discarding it.
 */
import { describe, expect, test } from "bun:test";

import { AcceptanceError } from "./assert.ts";
import { spawnCaptured, waitForHealthzWithDiagnostics } from "./inproc.ts";

// Port 1 on loopback refuses connections instantly, so the healthz loop
// runs its full backoff against a guaranteed-unreachable URL.
const UNREACHABLE_URL = "http://127.0.0.1:1";

async function expectTimeout(
	child: Awaited<ReturnType<typeof spawnCaptured>>,
	timeoutMs = 500,
): Promise<AcceptanceError> {
	let err: unknown;
	try {
		await waitForHealthzWithDiagnostics(UNREACHABLE_URL, timeoutMs, child);
	} catch (caught) {
		err = caught;
	}
	expect(err).toBeInstanceOf(AcceptanceError);
	return err as AcceptanceError;
}

describe("waitForHealthzWithDiagnostics", () => {
	test("attaches buffered stderr and the exit code when healthz times out", async () => {
		const child = spawnCaptured([
			"bun",
			"-e",
			"console.error('boot exploded on purpose'); process.exit(3)",
		]);
		await child.exited;
		await child.drained;
		const err = await expectTimeout(child);
		expect(err.message).toContain("healthz did not reach a terminal state");
		expect(err.message).toContain("boot exploded on purpose");
		expect(err.message).toContain("child exited with code 3");
		expect(err.message).toContain("child stderr tail");
	});

	test("attaches buffered stdout alongside stderr", async () => {
		const child = spawnCaptured([
			"bun",
			"-e",
			"console.log('stdout line'); console.error('stderr line'); process.exit(1)",
		]);
		await child.exited;
		await child.drained;
		const err = await expectTimeout(child);
		expect(err.message).toContain("stdout line");
		expect(err.message).toContain("stderr line");
		expect(err.message).toContain("child stdout tail");
	});

	test("keeps the live-streaming env vars working (no capture, no crash)", async () => {
		process.env.WARREN_ACCEPTANCE_WARREN_STDOUT = "1";
		process.env.WARREN_ACCEPTANCE_WARREN_STDERR = "1";
		try {
			const child = spawnCaptured(["bun", "-e", "console.error('live only'); process.exit(0)"]);
			await child.exited;
			await child.drained;
			const err = await expectTimeout(child);
			expect(err.message).toContain("no captured output");
			expect(err.message).not.toContain("live only");
		} finally {
			delete process.env.WARREN_ACCEPTANCE_WARREN_STDOUT;
			delete process.env.WARREN_ACCEPTANCE_WARREN_STDERR;
		}
	});

	test("reports a signal kill when the child never exits on its own", async () => {
		const child = spawnCaptured([
			"bun",
			"-e",
			"process.stdin.on('data', () => {}); setInterval(() => {}, 1000)",
		]);
		const err = await expectTimeout(child, 300);
		expect(err.message).toContain("no captured output");
		// Kill only after the assertion captured the still-running state.
		child.proc.kill("SIGKILL");
		await child.exited;
	});
});
