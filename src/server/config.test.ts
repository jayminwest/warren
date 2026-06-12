import { describe, expect, test } from "bun:test";
import { ValidationError } from "../core/errors.ts";
import {
	DEFAULT_BIND_HOST,
	DEFAULT_BIND_PORT,
	DEFAULT_DATA_DIR,
	loadServerConfigFromEnv,
} from "./config.ts";

describe("loadServerConfigFromEnv", () => {
	test("defaults to TCP on 0.0.0.0:8080 with /data + warren.db", () => {
		const config = loadServerConfigFromEnv({ env: { WARREN_API_TOKEN: "x" } });
		expect(config.transport.kind).toBe("tcp");
		if (config.transport.kind === "tcp") {
			expect(config.transport.hostname).toBe(DEFAULT_BIND_HOST);
			expect(config.transport.port).toBe(DEFAULT_BIND_PORT);
		}
		expect(config.dataDir).toBe(DEFAULT_DATA_DIR);
		expect(config.dbUrl).toBe("sqlite:///data/warren.db");
		expect(config.dbUrlConflict).toBeNull();
		expect(config.token).toBe("x");
	});

	test("WARREN_BIND_SOCKET wins over host/port", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_BIND_SOCKET: "/tmp/warren.sock",
				WARREN_BIND_PORT: "9000",
			},
		});
		expect(config.transport.kind).toBe("unix");
		if (config.transport.kind === "unix") {
			expect(config.transport.path).toBe("/tmp/warren.sock");
		}
	});

	test("custom data dir threads through to db url", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_DATA_DIR: "/var/lib/warren" },
		});
		expect(config.dataDir).toBe("/var/lib/warren");
		expect(config.dbUrl).toBe("sqlite:///var/lib/warren/warren.db");
	});

	test("WARREN_DB_PATH synthesizes a sqlite:// url (back-compat)", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_DB_PATH: "/srv/warren.sqlite" },
		});
		expect(config.dbUrl).toBe("sqlite:///srv/warren.sqlite");
		expect(config.dbUrlConflict).toBeNull();
	});

	test("WARREN_DB_URL wins over WARREN_DB_PATH (sqlite)", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_DB_URL: "sqlite:///srv/warren.sqlite",
				WARREN_DB_PATH: "/srv/warren.sqlite",
			},
		});
		expect(config.dbUrl).toBe("sqlite:///srv/warren.sqlite");
		expect(config.dbUrlConflict).toBeNull();
	});

	test("WARREN_DB_URL=postgres:// passes through unchanged", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_DB_URL: "postgres://u:p@host:5432/db",
			},
		});
		expect(config.dbUrl).toBe("postgres://u:p@host:5432/db");
	});

	test("conflicting WARREN_DB_URL + WARREN_DB_PATH surfaces dbUrlConflict", () => {
		const config = loadServerConfigFromEnv({
			env: {
				WARREN_API_TOKEN: "x",
				WARREN_DB_URL: "postgres://u:p@host/db",
				WARREN_DB_PATH: "/srv/legacy.sqlite",
			},
		});
		expect(config.dbUrl).toBe("postgres://u:p@host/db");
		expect(config.dbUrlConflict).toBe("/srv/legacy.sqlite");
	});

	test("WARREN_DISABLE_UI accepts 1/true/yes/on (case- and whitespace-insensitive)", () => {
		for (const raw of ["1", "true", "On", "YES", " true "]) {
			const config = loadServerConfigFromEnv({
				env: { WARREN_API_TOKEN: "x", WARREN_DISABLE_UI: raw },
			});
			expect(config.uiDistDir).toBeNull();
		}
	});

	test("WARREN_DISABLE_UI leaves UI enabled for empty / 0 / off", () => {
		for (const raw of ["", "0", "off"]) {
			const config = loadServerConfigFromEnv({
				env: { WARREN_API_TOKEN: "x", WARREN_DISABLE_UI: raw, WARREN_UI_DIST_DIR: "/app/ui" },
			});
			expect(config.uiDistDir).toBe("/app/ui");
		}
	});

	test("WARREN_UI_DIST_DIR overrides the default", () => {
		const config = loadServerConfigFromEnv({
			env: { WARREN_API_TOKEN: "x", WARREN_UI_DIST_DIR: "/app/ui" },
		});
		expect(config.uiDistDir).toBe("/app/ui");
	});

	test("noAuth=true returns token=null without checking env", () => {
		const config = loadServerConfigFromEnv({ env: {}, noAuth: true });
		expect(config.token).toBeNull();
	});

	test("missing WARREN_API_TOKEN throws when noAuth=false", () => {
		expect(() => loadServerConfigFromEnv({ env: {} })).toThrow(ValidationError);
	});

	test("invalid port throws", () => {
		expect(() =>
			loadServerConfigFromEnv({ env: { WARREN_API_TOKEN: "x", WARREN_BIND_PORT: "70000" } }),
		).toThrow(ValidationError);
	});
});
