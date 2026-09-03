import { describe, expect, test } from "bun:test";
import { formatConnections, parseArgs } from "./restore.ts";

describe("pg-migrate restore", () => {
	describe("parseArgs", () => {
		test("takes the dump file positionally plus --target and --force", () => {
			expect(parseArgs(["/tmp/dump.dump", "--target", "postgres://t", "--force"])).toEqual({
				file: "/tmp/dump.dump",
				target: "postgres://t",
				force: true,
				help: false,
			});
		});

		test("accepts --target in = form and --help", () => {
			expect(parseArgs(["--target=postgres://t"])).toEqual({
				file: undefined,
				target: "postgres://t",
				force: false,
				help: false,
			});
			expect(parseArgs(["--help"]).help).toBe(true);
		});

		test("rejects unknown flags and a second positional", () => {
			expect(() => parseArgs(["--bogus"])).toThrow(/unknown argument/);
			expect(() => parseArgs(["a.dump", "b.dump"])).toThrow(/exactly one dump file/);
		});
	});

	describe("formatConnections", () => {
		test("renders one line per live connection with pid, user, app, and state", () => {
			const out = formatConnections([
				{
					pid: 42,
					usename: "warren",
					applicationName: "warren serve",
					clientAddr: "10.0.0.1",
					state: "idle",
					backendStart: "2026-09-02 19:00:00",
				},
			]);
			expect(out).toContain("pid 42");
			expect(out).toContain('user=warren app="warren serve"');
			expect(out).toContain("state=idle");
		});

		test("renders an empty string for no connections", () => {
			expect(formatConnections([])).toBe("");
		});
	});
});
