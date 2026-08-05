import { describe, expect, test } from "bun:test";
import { EXTENSION_NAME, EXTENSION_VERSION, resolveConfig } from "./index.ts";

describe("resolveConfig", () => {
	test("accepts the full environment contract with defaults", () => {
		const resolved = resolveConfig({
			WARREN_BASE_URL: "https://warren.example.com",
			WARREN_API_TOKEN: "tok",
		});
		expect(resolved).toEqual({
			ok: true,
			config: {
				warrenBaseUrl: "https://warren.example.com",
				warrenApiToken: "tok",
				dbPath: "./data/audit-log.db",
				pollIntervalMs: 5000,
				eventsPageSize: 500,
				listenPort: 8080,
				retentionMaxRows: 0,
				retentionMaxAgeMs: 0,
			},
		});
	});

	test("honours the extension-owned knobs", () => {
		const resolved = resolveConfig({
			WARREN_BASE_URL: "https://warren.example.com",
			WARREN_API_TOKEN: "tok",
			AUDIT_LOG_DB_PATH: "/var/lib/audit-log/audit.db",
			AUDIT_LOG_POLL_INTERVAL_MS: "1000",
			AUDIT_LOG_EVENTS_PAGE_SIZE: "100",
			AUDIT_LOG_LISTEN_PORT: "9090",
			AUDIT_LOG_RETENTION_MAX_ROWS: "50000",
			AUDIT_LOG_RETENTION_MAX_AGE_MS: "86400000",
		});
		expect(resolved).toEqual({
			ok: true,
			config: {
				warrenBaseUrl: "https://warren.example.com",
				warrenApiToken: "tok",
				dbPath: "/var/lib/audit-log/audit.db",
				pollIntervalMs: 1000,
				eventsPageSize: 100,
				listenPort: 9090,
				retentionMaxRows: 50000,
				retentionMaxAgeMs: 86400000,
			},
		});
	});

	test("names every missing variable at once", () => {
		expect(resolveConfig({})).toEqual({
			ok: false,
			missing: ["WARREN_BASE_URL", "WARREN_API_TOKEN"],
		});
	});

	test("treats empty strings as missing", () => {
		const resolved = resolveConfig({ WARREN_BASE_URL: "", WARREN_API_TOKEN: "tok" });
		expect(resolved.ok).toBe(false);
	});

	test("rejects a negative retention bound", () => {
		expect(() =>
			resolveConfig({
				WARREN_BASE_URL: "https://warren.example.com",
				WARREN_API_TOKEN: "tok",
				AUDIT_LOG_RETENTION_MAX_ROWS: "-5",
			}),
		).toThrow("AUDIT_LOG_RETENTION_MAX_ROWS must be a non-negative integer");
	});

	test("rejects a non-integer poll interval", () => {
		expect(() =>
			resolveConfig({
				WARREN_BASE_URL: "https://warren.example.com",
				WARREN_API_TOKEN: "tok",
				AUDIT_LOG_POLL_INTERVAL_MS: "fast",
			}),
		).toThrow("AUDIT_LOG_POLL_INTERVAL_MS must be a positive integer");
	});
});

describe("the package", () => {
	test("ships a name and a pre-release version", () => {
		expect(EXTENSION_NAME).toBe("audit-log");
		expect(EXTENSION_VERSION).toBe("0.0.0");
	});
});
