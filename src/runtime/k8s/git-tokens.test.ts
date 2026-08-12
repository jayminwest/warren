import { describe, expect, test } from "bun:test";
import type { RunSpec } from "../contract.ts";
import { cloneTokenEnvOverlay, resolveK8sPushToken } from "./git-tokens.ts";

function baseSpec(overrides: Partial<RunSpec> = {}): RunSpec {
	return {
		runId: "run_01tdf3a0wg5e",
		originUrl: "https://github.com/acme/widgets.git",
		branch: "warren/run_01tdf3a0wg5e",
		baseBranch: "main",
		runtimeId: "claude-code",
		prompt: "do the thing",
		mode: "batch",
		network: "restricted",
		seedFiles: [],
		env: { WARREN_API_TOKEN: "tok" },
		...overrides,
	};
}

describe("cloneTokenEnvOverlay (warren-c9ac, window 1)", () => {
	test("returns {} when no mint seam is wired", async () => {
		expect(await cloneTokenEnvOverlay(baseSpec(), undefined)).toEqual({});
	});

	test("mints into WARREN_GIT_TOKEN for the run's origin URL", async () => {
		const seen: string[] = [];
		const overlay = await cloneTokenEnvOverlay(baseSpec(), async (gitUrl) => {
			seen.push(gitUrl);
			return "ghs_fresh";
		});
		expect(seen).toEqual(["https://github.com/acme/widgets.git"]);
		expect(overlay).toEqual({ WARREN_GIT_TOKEN: "ghs_fresh" });
	});

	test("never overrides a domain-pinned WARREN_GIT_TOKEN (the mint is not even called)", async () => {
		let called = false;
		const overlay = await cloneTokenEnvOverlay(
			baseSpec({ env: { WARREN_GIT_TOKEN: "ghp_pinned" } }),
			async () => {
				called = true;
				return "ghs_fresh";
			},
		);
		expect(overlay).toEqual({});
		expect(called).toBe(false);
	});

	test("anonymous mints (undefined / blank) yield no overlay", async () => {
		expect(await cloneTokenEnvOverlay(baseSpec(), async () => undefined)).toEqual({});
		expect(await cloneTokenEnvOverlay(baseSpec(), async () => "   ")).toEqual({});
	});

	test("a mint failure propagates (App mode fails loud, never clones on a dead token)", async () => {
		await expect(
			cloneTokenEnvOverlay(baseSpec(), async () => {
				throw new Error("mint boom");
			}),
		).rejects.toThrow("mint boom");
	});
});

describe("resolveK8sPushToken (warren-c9ac, window 2)", () => {
	test("the per-spawn minted intent token always wins", () => {
		expect(
			resolveK8sPushToken({
				intentToken: "ghs_minted",
				env: { WARREN_GIT_TOKEN: "ghp_static" },
				allowStaticEnv: true,
			}),
		).toBe("ghs_minted");
	});

	test("static env fallback applies only when allowed (PAT/static mode)", () => {
		expect(
			resolveK8sPushToken({
				intentToken: undefined,
				env: { WARREN_GIT_TOKEN: "ghp_static" },
				allowStaticEnv: true,
			}),
		).toBe("ghp_static");
		expect(
			resolveK8sPushToken({
				intentToken: undefined,
				env: { GITHUB_TOKEN: "ghp_fallback" },
				allowStaticEnv: true,
			}),
		).toBe("ghp_fallback");
	});

	test("App mode (allowStaticEnv: false) never depends on the static env", () => {
		expect(
			resolveK8sPushToken({
				intentToken: undefined,
				env: { WARREN_GIT_TOKEN: "ghp_static", GITHUB_TOKEN: "ghp_fallback" },
				allowStaticEnv: false,
			}),
		).toBeUndefined();
	});

	test("blank tokens are no tokens", () => {
		expect(
			resolveK8sPushToken({
				intentToken: "  ",
				env: { WARREN_GIT_TOKEN: "" },
				allowStaticEnv: true,
			}),
		).toBeUndefined();
	});
});
