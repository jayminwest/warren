import { describe, expect, test } from "bun:test";
import { resolveEnv, type WorkspaceEnvConfig } from "./env.ts";
import { SecretResolutionError } from "./errors.ts";
import { type OpReadFn, OpResolver } from "./op.ts";

function fakeOp(map: Record<string, string>): OpResolver {
	const fn: OpReadFn = async ({ ref }) => {
		if (ref in map) {
			const value = map[ref];
			if (value !== undefined) return { exitCode: 0, stdout: value, stderr: "" };
		}
		return { exitCode: 1, stdout: "", stderr: `not found: ${ref}` };
	};
	return new OpResolver({ read: fn });
}

describe("resolveEnv", () => {
	test("returns empty values when config is null and nothing is required", async () => {
		const out = await resolveEnv({ config: null });
		expect(out.values).toEqual({});
		expect(out.requiredResolved).toEqual([]);
	});

	test("layers defaults < host < store < secrets < overrides (highest wins)", async () => {
		const config: WorkspaceEnvConfig = {
			env: {
				required: ["A"],
				optional: ["B"],
				defaults: { A: "from-default", B: "from-default" },
			},
			secrets: { A: "from-secrets" },
		};
		const out = await resolveEnv({
			config,
			hostEnv: { A: "from-host", B: "from-host" },
			secretsStore: { A: "from-store" },
			overrides: { B: "from-override" },
		});
		// A: secrets wins over store > host > default
		expect(out.values.A).toBe("from-secrets");
		// B: override wins over host > default
		expect(out.values.B).toBe("from-override");
	});

	test("only pulls host env for keys declared required/optional (no host bleed)", async () => {
		const config: WorkspaceEnvConfig = { env: { required: ["WANTED"] } };
		const out = await resolveEnv({
			config,
			hostEnv: { WANTED: "yes", IGNORED: "no" },
		});
		expect(out.values.WANTED).toBe("yes");
		expect("IGNORED" in out.values).toBe(false);
	});

	test("resolves op:// refs via the injected OpResolver", async () => {
		const config: WorkspaceEnvConfig = {
			secrets: { DB_URL: "op://Eng/db/url", LITERAL: "plain" },
		};
		const out = await resolveEnv({
			config,
			op: fakeOp({ "op://Eng/db/url": "postgres://prod" }),
		});
		expect(out.values.DB_URL).toBe("postgres://prod");
		expect(out.values.LITERAL).toBe("plain");
	});

	test("throws SecretResolutionError listing every failed op:// ref", async () => {
		const config: WorkspaceEnvConfig = {
			secrets: { A: "op://x/y/z", B: "op://m/n/o" },
		};
		try {
			await resolveEnv({ config, op: fakeOp({}) });
			throw new Error("should have thrown");
		} catch (err) {
			expect(err).toBeInstanceOf(SecretResolutionError);
			const msg = (err as Error).message;
			expect(msg).toContain("A");
			expect(msg).toContain("B");
		}
	});

	test("throws SecretResolutionError when required keys can't be resolved", async () => {
		const config: WorkspaceEnvConfig = { env: { required: ["MUST_HAVE"] } };
		await expect(resolveEnv({ config })).rejects.toBeInstanceOf(SecretResolutionError);
	});

	test("an empty-string override deletes a default (escape hatch)", async () => {
		const config: WorkspaceEnvConfig = {
			env: { defaults: { K: "default-value" } },
		};
		const out = await resolveEnv({
			config,
			overrides: { K: "" },
		});
		expect("K" in out.values).toBe(false);
	});

	test("reports optionalMissing for declared-but-unresolved optional keys", async () => {
		const config: WorkspaceEnvConfig = { env: { optional: ["MAYBE"] } };
		const out = await resolveEnv({ config });
		expect(out.optionalMissing).toEqual(["MAYBE"]);
		expect(out.optionalResolved).toEqual([]);
	});
});
