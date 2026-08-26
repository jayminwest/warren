import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import { DEFAULT_PROJECTS_DIR, loadProjectsConfigFromEnv } from "./config.ts";

describe("loadProjectsConfigFromEnv", () => {
	test("uses defaults when no env vars are set", () => {
		expect(loadProjectsConfigFromEnv({})).toEqual({
			root: DEFAULT_PROJECTS_DIR,
			gitBinary: "git",
		});
	});

	// warren-5c42: the quickstart mounts one volume and names it with
	// WARREN_DATA_DIR. A hardcoded /data/projects put clones outside that
	// volume, so the agent container's workspace bind mount did not exist.
	test("derives the projects root from WARREN_DATA_DIR when WARREN_PROJECTS_DIR is unset", () => {
		expect(loadProjectsConfigFromEnv({ WARREN_DATA_DIR: "/srv/warren" }).root).toBe(
			"/srv/warren/projects",
		);
	});

	test("falls back to /data/projects when WARREN_DATA_DIR is unset or blank", () => {
		expect(loadProjectsConfigFromEnv({}).root).toBe("/data/projects");
		expect(loadProjectsConfigFromEnv({ WARREN_DATA_DIR: "   " }).root).toBe("/data/projects");
	});

	test("WARREN_PROJECTS_DIR wins over the WARREN_DATA_DIR derivation", () => {
		expect(
			loadProjectsConfigFromEnv({
				WARREN_DATA_DIR: "/srv/warren",
				WARREN_PROJECTS_DIR: "/mnt/clones",
			}).root,
		).toBe("/mnt/clones");
	});

	test("rejects an empty WARREN_PROJECTS_DIR (caller likely meant 'unset')", () => {
		expect(() =>
			loadProjectsConfigFromEnv({
				WARREN_PROJECTS_DIR: "",
			}),
		).toThrow(ValidationError);
	});

	test("names the derived fallback in the empty-string recovery hint", () => {
		try {
			loadProjectsConfigFromEnv({ WARREN_PROJECTS_DIR: "", WARREN_DATA_DIR: "/srv/warren" });
			throw new Error("expected a ValidationError");
		} catch (err) {
			expect(err).toBeInstanceOf(ValidationError);
			expect((err as ValidationError).recoveryHint).toContain("/srv/warren/projects");
		}
	});

	test("honors all overrides", () => {
		expect(
			loadProjectsConfigFromEnv({
				WARREN_PROJECTS_DIR: "/srv/projects",
				WARREN_GIT_BINARY: "/usr/local/bin/git",
				WARREN_GIT_TIMEOUT_MS: "900000",
			}),
		).toEqual({
			root: "/srv/projects",
			gitBinary: "/usr/local/bin/git",
			gitTimeoutMs: 900000,
		});
	});

	// The first payer is openclaw (~2.9GB): a full registration clone cannot
	// finish inside the 120s default, and the server offered no override.
	test("omits gitTimeoutMs when WARREN_GIT_TIMEOUT_MS is unset or blank", () => {
		expect(loadProjectsConfigFromEnv({})).not.toHaveProperty("gitTimeoutMs");
		expect(loadProjectsConfigFromEnv({ WARREN_GIT_TIMEOUT_MS: "  " })).not.toHaveProperty(
			"gitTimeoutMs",
		);
	});

	test("rejects a non-positive or non-integer WARREN_GIT_TIMEOUT_MS", () => {
		for (const bad of ["0", "-5", "abc", "1.5"]) {
			expect(() => loadProjectsConfigFromEnv({ WARREN_GIT_TIMEOUT_MS: bad })).toThrow(
				ValidationError,
			);
		}
	});
});
