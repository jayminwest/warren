import { afterEach, describe, expect, test } from "bun:test";
import {
	dumpFileName,
	humanSize,
	renderParityDiff,
	requireDbUrl,
	tableListFromToc,
} from "./lib.ts";

describe("pg-migrate/lib", () => {
	describe("dumpFileName", () => {
		test("builds a dated filename-safe stamp from a UTC instant", () => {
			const name = dumpFileName(new Date("2026-09-02T19:15:07Z"));
			expect(name).toBe("warren-pg-dump-2026-09-02T191507.dump");
		});
	});

	describe("humanSize", () => {
		test("renders bytes, kilobytes, and gigabytes", () => {
			expect(humanSize(204)).toBe("204 B");
			expect(humanSize(2048)).toBe("2.0 kB");
			expect(humanSize(1.7 * 1024 * 1024 * 1024)).toBe("1.7 GB");
		});

		test("renders a non-finite size as unknown rather than crashing", () => {
			expect(humanSize(Number.NaN)).toBe("?");
			expect(humanSize(-1)).toBe("?");
		});
	});

	describe("tableListFromToc", () => {
		test("extracts schema.table entries from TABLE DATA lines in TOC order", () => {
			const toc = [
				";\n; Archive created at 2026-09-02",
				"215; 1259 16456 TABLE public events warren",
				"3121; 0 16456 TABLE DATA public events warren",
				"3122; 0 16458 TABLE DATA public runs warren",
				'3123; 0 16460 TABLE DATA "drizzle" "__drizzle_migrations" postgres',
				"3124; 0 0 BLOB DATA - warren",
			].join("\n");
			expect(tableListFromToc(toc)).toEqual([
				"public.events",
				"public.runs",
				"drizzle.__drizzle_migrations",
			]);
		});

		test("returns an empty list for a TOC with no table data", () => {
			expect(tableListFromToc("215; 1259 1 TABLE public events warren")).toEqual([]);
		});
	});

	describe("requireDbUrl", () => {
		const ENV_KEY = "WARREN_TEST_REQUIRE_DB_URL";
		afterEach(() => {
			delete process.env[ENV_KEY];
		});

		test("prefers the flag over the environment", () => {
			process.env[ENV_KEY] = "postgres://from-env";
			expect(requireDbUrl(ENV_KEY, "postgres://from-flag")).toBe("postgres://from-flag");
		});

		test("falls back to the environment", () => {
			process.env[ENV_KEY] = "postgres://from-env";
			expect(requireDbUrl(ENV_KEY)).toBe("postgres://from-env");
		});

		test("throws with a copy-paste hint when neither source supplies a URL", () => {
			expect(() => requireDbUrl(ENV_KEY)).toThrow(/is required/);
		});
	});

	describe("renderParityDiff", () => {
		test("marks matched rows with = and mismatched rows with ! plus a note", () => {
			const out = renderParityDiff("parity", [
				{ name: "rows: events", source: "10", target: "10", match: true },
				{
					name: "max(events.id)",
					source: "9",
					target: "absent",
					match: false,
					reason: "value differs",
				},
			]);
			expect(out).toContain("=\n");
			expect(out).toContain("rows: events");
			expect(out).toContain("max(events.id)  9       absent  !  value differs");
			expect(out).toContain("value differs");
		});
	});
});
