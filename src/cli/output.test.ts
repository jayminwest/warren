import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { defaultSpawn, formatError, PROCESS_STDIO, writeJsonLine } from "./output.ts";

describe("writeJsonLine", () => {
	test("writes a single newline-terminated JSON object", () => {
		const chunks: string[] = [];
		writeJsonLine({ write: (c) => chunks.push(c) }, { ok: true, n: 2 });
		expect(chunks).toEqual([`${JSON.stringify({ ok: true, n: 2 })}\n`]);
	});
});

describe("formatError", () => {
	test("formats a WarrenError with code and recovery hint", () => {
		const err = new ValidationError("boom", { recoveryHint: "set FOO=1" });
		expect(formatError(err)).toBe("[validation_error] boom\n  hint: set FOO=1");
	});

	test("formats a plain Error without code or hint", () => {
		expect(formatError(new Error("oops"))).toBe("oops");
	});

	test("stringifies a non-Error", () => {
		expect(formatError(42)).toBe("42");
	});
});

describe("PROCESS_STDIO", () => {
	test("stdout.write delegates to process.stdout.write", () => {
		const chunks: string[] = [];
		const original = process.stdout.write.bind(process.stdout);
		process.stdout.write = (chunk: string) => {
			chunks.push(chunk);
			return true;
		};
		try {
			PROCESS_STDIO.stdout.write("hello stdout\n");
		} finally {
			process.stdout.write = original;
		}
		expect(chunks).toContain("hello stdout\n");
	});

	test("stderr.write delegates to process.stderr.write", () => {
		const chunks: string[] = [];
		const original = process.stderr.write.bind(process.stderr);
		process.stderr.write = (chunk: string) => {
			chunks.push(chunk);
			return true;
		};
		try {
			PROCESS_STDIO.stderr.write("hello stderr\n");
		} finally {
			process.stderr.write = original;
		}
		expect(chunks).toContain("hello stderr\n");
	});
});

describe("defaultSpawn", () => {
	test("runs a command and captures stdout/stderr", async () => {
		const result = await defaultSpawn(["echo", "coverage-test"], { cwd: "/tmp" });
		expect(result.exitCode).toBe(0);
		expect(result.stdout.trim()).toBe("coverage-test");
		expect(result.stderr).toBe("");
	});
});
