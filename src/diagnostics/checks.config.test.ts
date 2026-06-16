import { describe, expect, test } from "bun:test";
import { openDatabase } from "../db/client.ts";
import { type LoadedWarrenConfig, WarrenConfigUnavailableError } from "../warren-config/index.ts";
import {
	checkDatabaseReachable,
	checkWarrenConfig,
	checkWarrenConfigDeprecations,
	checkWarrenDb,
} from "./checks.ts";

describe("checkWarrenConfig", () => {
	const empty: LoadedWarrenConfig = {
		triggers: null,
		defaults: null,
		prTemplate: null,
		errors: [],
		warnings: [],
	};
	const valid: LoadedWarrenConfig = {
		triggers: [],
		defaults: { defaultBranch: "main" },
		prTemplate: null,
		errors: [],
		warnings: [],
	};

	test("ok with informational message when no projects registered", async () => {
		const result = await checkWarrenConfig({ projects: [] });
		expect(result.name).toBe("warren_config");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no projects registered");
	});

	test("ok when every project's .warren/ is absent or valid (covers states 1+2)", async () => {
		const calls: string[] = [];
		const result = await checkWarrenConfig({
			projects: [
				{ id: "prj_absent", localPath: "/clones/a" },
				{ id: "prj_valid", localPath: "/clones/b" },
			],
			load: async (path) => {
				calls.push(path);
				return path === "/clones/a" ? empty : valid;
			},
		});
		expect(calls).toEqual(["/clones/a", "/clones/b"]);
		expect(result.ok).toBe(true);
		expect(result.message).toContain("2 project(s) checked");
	});

	test("fails with file paths when any project's .warren/ is malformed (state 3)", async () => {
		const malformed: LoadedWarrenConfig = {
			triggers: null,
			defaults: { defaultBranch: "main" },
			prTemplate: null,
			errors: [
				{
					file: ".warren/triggers.yaml",
					code: "warren_config_parse_error",
					message: "YAML parse error: bad indent",
				},
			],
			warnings: [],
		};
		const result = await checkWarrenConfig({
			projects: [
				{ id: "prj_ok", localPath: "/clones/a" },
				{ id: "prj_bad", localPath: "/clones/b" },
			],
			load: async (path) => (path === "/clones/a" ? valid : malformed),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("prj_bad .warren/triggers.yaml");
		expect(result.message).toContain("YAML parse error");
		expect(result.hint).toContain("/refresh");
	});

	test("fails when a project clone has vanished (WarrenConfigUnavailableError)", async () => {
		const result = await checkWarrenConfig({
			projects: [{ id: "prj_gone", localPath: "/clones/missing" }],
			load: async () => {
				throw new WarrenConfigUnavailableError("project clone missing on disk: /clones/missing");
			},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("prj_gone");
		expect(result.message).toContain("clone missing");
	});

	test("aggregates errors across many projects", async () => {
		const malformed: LoadedWarrenConfig = {
			triggers: null,
			defaults: null,
			prTemplate: null,
			errors: [
				{
					file: ".warren/defaults.json",
					code: "warren_config_schema_error",
					message: "branch: required",
				},
			],
			warnings: [],
		};
		const result = await checkWarrenConfig({
			projects: [
				{ id: "p1", localPath: "/c/p1" },
				{ id: "p2", localPath: "/c/p2" },
				{ id: "p3", localPath: "/c/p3" },
			],
			load: async (path) => (path === "/c/p2" ? malformed : valid),
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("1 .warren/ failure(s) across 3 project(s)");
		expect(result.message).toContain("p2 .warren/defaults.json");
	});

	test("reads through the cache when supplied (shares parses with HTTP surface)", async () => {
		const seen: { id: string; path: string }[] = [];
		const cache = {
			get: async (id: string, path: string): Promise<LoadedWarrenConfig> => {
				seen.push({ id, path });
				return valid;
			},
			invalidate: () => undefined,
			clear: () => undefined,
			size: () => 0,
		};
		const result = await checkWarrenConfig({
			projects: [{ id: "prj_a", localPath: "/c/a" }],
			cache,
			load: async () => empty,
		});
		expect(seen).toEqual([{ id: "prj_a", path: "/c/a" }]);
		expect(result.ok).toBe(true);
	});

	test("warnings on a loaded envelope do not flip warren_config to ok=false", async () => {
		const withWarning: LoadedWarrenConfig = {
			triggers: null,
			defaults: { defaultBranch: "main" },
			prTemplate: null,
			errors: [],
			warnings: [
				{
					file: ".warren/defaults.json",
					code: "warren_config_deprecated",
					message: "deprecated",
				},
			],
		};
		const result = await checkWarrenConfig({
			projects: [{ id: "prj_a", localPath: "/c/a" }],
			load: async () => withWarning,
		});
		expect(result.ok).toBe(true);
	});
});

describe("checkWarrenConfigDeprecations", () => {
	const clean: LoadedWarrenConfig = {
		triggers: null,
		defaults: null,
		prTemplate: null,
		errors: [],
		warnings: [],
	};
	const deprecated: LoadedWarrenConfig = {
		triggers: null,
		defaults: { defaultBranch: "main" },
		prTemplate: null,
		errors: [],
		warnings: [
			{
				file: ".warren/defaults.json",
				code: "warren_config_deprecated",
				message: "run `warren config migrate`",
			},
		],
	};

	test("ok with informational message when no projects registered", async () => {
		const result = await checkWarrenConfigDeprecations({ projects: [] });
		expect(result.name).toBe("warren_config_deprecations");
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no projects registered");
	});

	test("ok with 'no deprecations' message when every project is clean", async () => {
		const result = await checkWarrenConfigDeprecations({
			projects: [{ id: "p1", localPath: "/c/p1" }],
			load: async () => clean,
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no .warren/ deprecations");
	});

	test("ok=true but message names offending projects + files when warnings present", async () => {
		const result = await checkWarrenConfigDeprecations({
			projects: [
				{ id: "p1", localPath: "/c/p1" },
				{ id: "p2", localPath: "/c/p2" },
			],
			load: async (path) => (path === "/c/p1" ? deprecated : clean),
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("p1 .warren/defaults.json");
		expect(result.message).toContain("warren config migrate");
		expect(result.hint).toContain("warren config migrate");
	});

	test("skips projects whose load threw — those are surfaced by checkWarrenConfig", async () => {
		const result = await checkWarrenConfigDeprecations({
			projects: [
				{ id: "p_gone", localPath: "/c/missing" },
				{ id: "p_deprecated", localPath: "/c/dep" },
			],
			load: async (path) => {
				if (path === "/c/missing") {
					throw new WarrenConfigUnavailableError("clone gone");
				}
				return deprecated;
			},
		});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("p_deprecated .warren/defaults.json");
		expect(result.message).not.toContain("p_gone");
	});
});

describe("checkWarrenDb", () => {
	test("ok with informational message when neither env var is set", () => {
		const result = checkWarrenDb({ env: {} });
		expect(result.ok).toBe(true);
		expect(result.message).toContain("will default to sqlite");
	});

	test("ok and reports sqlite path when WARREN_DB_URL is sqlite://", () => {
		const result = checkWarrenDb({ env: { WARREN_DB_URL: "sqlite:///data/warren.db" } });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("sqlite /data/warren.db");
	});

	test("ok and reports postgres when WARREN_DB_URL is postgres://", () => {
		const result = checkWarrenDb({ env: { WARREN_DB_URL: "postgres://u:p@h/db" } });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("postgres");
	});

	test("synthesizes a sqlite url from legacy WARREN_DB_PATH", () => {
		const result = checkWarrenDb({ env: { WARREN_DB_PATH: "/srv/warren.db" } });
		expect(result.ok).toBe(true);
		expect(result.message).toBe("sqlite /srv/warren.db");
	});

	test("ok when WARREN_DB_URL and WARREN_DB_PATH agree (sqlite synthesis matches URL)", () => {
		const result = checkWarrenDb({
			env: {
				WARREN_DB_URL: "sqlite:///srv/warren.db",
				WARREN_DB_PATH: "/srv/warren.db",
			},
		});
		expect(result.ok).toBe(true);
	});

	test("fails when WARREN_DB_URL (postgres) and WARREN_DB_PATH (sqlite) disagree", () => {
		const result = checkWarrenDb({
			env: {
				WARREN_DB_URL: "postgres://h/db",
				WARREN_DB_PATH: "/srv/legacy.sqlite",
			},
		});
		expect(result.ok).toBe(false);
		expect(result.message).toContain("disagree");
		expect(result.hint).toContain("WARREN_DB_URL wins");
	});

	test("fails when WARREN_DB_URL is malformed", () => {
		const result = checkWarrenDb({ env: { WARREN_DB_URL: "sqlite://" } });
		expect(result.ok).toBe(false);
		expect(result.message).toContain("sqlite URL has no path");
	});
});

describe("checkDatabaseReachable", () => {
	test("degrades to informational ok when no db handle wired", async () => {
		const result = await checkDatabaseReachable({});
		expect(result.ok).toBe(true);
		expect(result.message).toContain("no db handle wired");
	});

	test("pings a live sqlite handle and reports dialect=sqlite", async () => {
		const db = await openDatabase({ url: ":memory:" });
		try {
			const result = await checkDatabaseReachable({ db });
			expect(result.ok).toBe(true);
			expect(result.message).toBe("dialect=sqlite");
		} finally {
			await db.close();
		}
	});

	test("returns ok=false with the underlying error when ping throws", async () => {
		const db = await openDatabase({ url: ":memory:" });
		await db.close();
		const result = await checkDatabaseReachable({ db });
		expect(result.ok).toBe(false);
		expect(result.hint).toContain("sqlite");
	});
});
