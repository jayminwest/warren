import { describe, expect, test } from "bun:test";
import { SecretResolutionError } from "./errors.ts";
import { type OpReadFn, OpResolver } from "./op.ts";

describe("OpResolver", () => {
	test("isOpRef matches op:// prefix", () => {
		expect(OpResolver.isOpRef("op://Vault/Item/field")).toBe(true);
		expect(OpResolver.isOpRef("literal-value")).toBe(false);
	});

	test("resolves a successful read and trims trailing newline", async () => {
		const calls: string[] = [];
		const fake: OpReadFn = async ({ ref }) => {
			calls.push(ref);
			return { exitCode: 0, stdout: "secret-value\n", stderr: "" };
		};
		const r = new OpResolver({ read: fake });
		const out = await r.resolve("DATABASE_URL", "op://Eng/db/url");
		expect(out).toBe("secret-value");
		expect(calls).toEqual(["op://Eng/db/url"]);
	});

	test("caches by ref so repeated lookups don't respawn op", async () => {
		let count = 0;
		const fake: OpReadFn = async () => {
			count += 1;
			return { exitCode: 0, stdout: "v", stderr: "" };
		};
		const r = new OpResolver({ read: fake });
		await r.resolve("A", "op://x/y/z");
		await r.resolve("B", "op://x/y/z");
		expect(count).toBe(1);
	});

	test("throws SecretResolutionError when the value isn't an op:// ref", async () => {
		const r = new OpResolver({ read: async () => ({ exitCode: 0, stdout: "", stderr: "" }) });
		await expect(r.resolve("X", "literal")).rejects.toBeInstanceOf(SecretResolutionError);
	});

	test("throws SecretResolutionError on non-zero exit, surfacing stderr in the hint", async () => {
		const fake: OpReadFn = async () => ({ exitCode: 1, stdout: "", stderr: "not found" });
		const r = new OpResolver({ read: fake });
		try {
			await r.resolve("X", "op://x/y/z");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SecretResolutionError);
			expect((err as SecretResolutionError).recoveryHint).toContain("not found");
		}
	});

	test("translates ENOENT (missing op binary) to a hint pointing at install docs", async () => {
		const fake: OpReadFn = async () => {
			const err: NodeJS.ErrnoException = new Error("op: command not found");
			err.code = "ENOENT";
			throw err;
		};
		const r = new OpResolver({ read: fake });
		try {
			await r.resolve("X", "op://x/y/z");
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SecretResolutionError);
			expect((err as SecretResolutionError).message).toContain("`op` CLI not found");
		}
	});
});
