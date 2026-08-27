/**
 * Unit tests for the env-var integer parsers exported from
 * `src/server/main/index.ts` (warren-da37 / pl-60a6 step 1). The HTTP-query
 * variants live in `server.test.ts`; this file covers the env-only
 * `resolvePgPoolMax` so the strict round-trip check (`String(n) ===
 * raw`) is regression-locked: junk-suffix inputs (`"10x"`,
 * `"5 abc"`) must throw rather than silently coercing to the leading
 * integer.
 */

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WARREN_DB_POOL_MAX_ENV } from "../../db/client.ts";
import { OPERATOR_TOKEN_FILE } from "../auth.ts";
import { bootServer, resolvePgPoolMax } from "./index.ts";

describe("resolvePgPoolMax", () => {
	test("undefined / blank env returns undefined (let openDatabase default win)", () => {
		expect(resolvePgPoolMax({})).toBeUndefined();
		expect(resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "" })).toBeUndefined();
	});

	test("valid positive integer parses through unchanged", () => {
		expect(resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "10" })).toBe(10);
		expect(resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "1" })).toBe(1);
	});

	test("non-positive integers throw", () => {
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "0" })).toThrow(
			/must be a positive integer/,
		);
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "-5" })).toThrow(
			/must be a positive integer/,
		);
	});

	// warren-da37: the strict round-trip check is the regression target.
	// Reverting `String(n) !== raw` in `parseIntEnv` makes these pass with
	// the leading integer instead of throwing.
	test("junk-suffix inputs reject instead of silently truncating", () => {
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "10x" })).toThrow(
			/must be a positive integer/,
		);
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "5abc" })).toThrow(
			/must be a positive integer/,
		);
		expect(() => resolvePgPoolMax({ [WARREN_DB_POOL_MAX_ENV]: "1.5" })).toThrow(
			/must be a positive integer/,
		);
	});
});

/**
 * warren-ef6e: fresh-install token bootstrap end-to-end. Boots against a temp
 * data dir with NO WARREN_API_TOKEN and proves the persist/reuse/override
 * contract against the live HTTP surface. `process.env` is restored in
 * `finally` so the mutation the bootstrap performs never bleeds into other
 * tests in this file's process.
 */
describe("bootServer token bootstrap (warren-ef6e)", () => {
	const bootEnv = (dataDir: string): Record<string, string> => ({
		WARREN_DATA_DIR: dataDir,
		WARREN_BIND_HOST: "127.0.0.1",
		WARREN_BIND_PORT: "0",
		WARREN_SCHEDULER_DISABLED: "1",
		WARREN_DISABLE_UI: "1",
	});

	test("mints + persists on first boot, reuses on the second, and keeps 401s strict", async () => {
		const previous = process.env.WARREN_API_TOKEN;
		delete process.env.WARREN_API_TOKEN;
		const dataDir = mkdtempSync(join(tmpdir(), "warren-boot-token-"));
		try {
			const first = await bootServer({ env: bootEnv(dataDir) });
			try {
				const minted = process.env.WARREN_API_TOKEN;
				expect(minted).toBeDefined();
				if (minted === undefined) throw new Error("expected a minted token in process.env");
				expect(readFileSync(join(dataDir, OPERATOR_TOKEN_FILE), "utf8")).toContain(minted);
				expect(
					(
						await fetch(`${first.url}/whoami`, {
							headers: { authorization: `Bearer ${minted}` },
						})
					).status,
				).toBe(200);
				// warren-851b posture: a stale/malformed token still rejects 401.
				expect(
					(
						await fetch(`${first.url}/whoami`, {
							headers: { authorization: "Bearer stale" },
						})
					).status,
				).toBe(401);
				expect((await fetch(`${first.url}/whoami`)).status).toBe(401);
			} finally {
				await first.stop();
			}

			const second = await bootServer({ env: bootEnv(dataDir) });
			try {
				expect(process.env.WARREN_API_TOKEN ?? "").toBe(
					readFileSync(join(dataDir, OPERATOR_TOKEN_FILE), "utf8").trim(),
				);
			} finally {
				await second.stop();
			}
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.WARREN_API_TOKEN;
			} else {
				process.env.WARREN_API_TOKEN = previous;
			}
		}
	});

	test("an explicit WARREN_API_TOKEN wins over the persisted token", async () => {
		const previous = process.env.WARREN_API_TOKEN;
		delete process.env.WARREN_API_TOKEN;
		const dataDir = mkdtempSync(join(tmpdir(), "warren-boot-override-"));
		const first = await bootServer({ env: bootEnv(dataDir) });
		await first.stop();

		const explicit = await bootServer({
			env: { ...bootEnv(dataDir), WARREN_API_TOKEN: "explicit-token" },
		});
		try {
			expect(
				(
					await fetch(`${explicit.url}/whoami`, {
						headers: { authorization: "Bearer explicit-token" },
					})
				).status,
			).toBe(200);
			// ...and the persisted token is NOT admitted while the env override runs.
			const persisted = readFileSync(join(dataDir, OPERATOR_TOKEN_FILE), "utf8").trim();
			expect(
				(
					await fetch(`${explicit.url}/whoami`, {
						headers: { authorization: `Bearer ${persisted}` },
					})
				).status,
			).toBe(401);
		} finally {
			await explicit.stop();
			rmSync(dataDir, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.WARREN_API_TOKEN;
			} else {
				process.env.WARREN_API_TOKEN = previous;
			}
		}
	});
});

describe("bootServer setup handoff (warren-48f8)", () => {
	const bootEnv = (dataDir: string): Record<string, string> => ({
		WARREN_DATA_DIR: dataDir,
		WARREN_BIND_HOST: "127.0.0.1",
		WARREN_BIND_PORT: "0",
		WARREN_SCHEDULER_DISABLED: "1",
		WARREN_DISABLE_UI: "1",
	});

	test("arms a one-time /setup code that redeems over HTTP exactly once", async () => {
		const previous = process.env.WARREN_API_TOKEN;
		delete process.env.WARREN_API_TOKEN;
		const dataDir = mkdtempSync(join(tmpdir(), "warren-boot-handoff-"));
		try {
			const handle = await bootServer({ env: bootEnv(dataDir), setupHandoff: true });
			try {
				expect(handle.setupUrl).toBeDefined();
				const url = handle.setupUrl;
				if (url === undefined) throw new Error("expected an armed setup URL");
				const first = await fetch(url);
				expect(first.status).toBe(200);
				const html = await first.text();
				expect(html).toContain('"warren.apiToken"');
				// The redemption page carries the minted operator token.
				const token = process.env.WARREN_API_TOKEN ?? "";
				expect(html).toContain(JSON.stringify(token));
				// Single-use: the same URL never answers 200 twice.
				const second = await fetch(url);
				expect(second.status).toBe(400);
				expect((await second.text()).toLowerCase()).not.toContain(token.toLowerCase());
			} finally {
				await handle.stop();
			}
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.WARREN_API_TOKEN;
			} else {
				process.env.WARREN_API_TOKEN = previous;
			}
		}
	});

	test("mints no code and 404s /setup on an ordinary boot", async () => {
		const previous = process.env.WARREN_API_TOKEN;
		delete process.env.WARREN_API_TOKEN;
		const dataDir = mkdtempSync(join(tmpdir(), "warren-boot-nohandoff-"));
		try {
			const handle = await bootServer({ env: bootEnv(dataDir) });
			try {
				expect(handle.setupUrl).toBeUndefined();
				expect((await fetch(`${handle.url}/setup?code=anything`)).status).toBe(404);
			} finally {
				await handle.stop();
			}
		} finally {
			rmSync(dataDir, { recursive: true, force: true });
			if (previous === undefined) {
				delete process.env.WARREN_API_TOKEN;
			} else {
				process.env.WARREN_API_TOKEN = previous;
			}
		}
	});
});
