import { describe, expect, test } from "bun:test";
import type { SpawnFn } from "../projects/clone.ts";
import { captureSpawnCalls } from "./checks.test-helpers.ts";
import { checkBwrap } from "./checks.ts";

describe("checkBwrap", () => {
	test("ok when bwrap --version exits 0", async () => {
		const { spawn, calls } = captureSpawnCalls({
			bwrap: { stdout: "bubblewrap 0.8.0\n", exitCode: 0 },
		});
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("bubblewrap 0.8.0");
		expect(calls[0]?.cmd).toEqual(["bwrap", "--version"]);
	});

	test("fails with the bubblewrap install hint when exit non-zero", async () => {
		const { spawn } = captureSpawnCalls({
			bwrap: { stderr: "command not found", exitCode: 127 },
		});
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("127");
		expect(result.hint).toContain("bubblewrap");
	});

	test("fails with hint when spawn throws (binary missing)", async () => {
		const spawn: SpawnFn = async () => {
			throw new Error("ENOENT bwrap");
		};
		const result = await checkBwrap({ spawn });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("ENOENT");
		expect(result.hint).toContain("bubblewrap");
	});

	test("respects bwrapBinary override", async () => {
		const { spawn, calls } = captureSpawnCalls({
			"/usr/local/bin/bwrap": { stdout: "bubblewrap 0.8.0", exitCode: 0 },
		});
		await checkBwrap({ spawn, bwrapBinary: "/usr/local/bin/bwrap" });
		expect(calls[0]?.cmd).toEqual(["/usr/local/bin/bwrap", "--version"]);
	});
});
