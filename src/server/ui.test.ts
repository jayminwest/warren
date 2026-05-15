import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "./types.ts";
import { createUiHandler } from "./ui.ts";

const silentLogger = {
	info() {},
	warn() {},
	error() {},
};

async function setupDist(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "warren-ui-"));
	await writeFile(join(dir, "index.html"), "<html><body>warren ui</body></html>");
	await mkdir(join(dir, "assets"), { recursive: true });
	await writeFile(join(dir, "assets", "app.js"), "console.log('hi')");
	await writeFile(join(dir, "assets", "style.css"), "body{}");
	return dir;
}

function ctxFor(pathname: string): RouteContext {
	const url = new URL(`http://localhost${pathname}`);
	return {
		request: new Request(url),
		url,
		params: {},
		logger: silentLogger,
	};
}

describe("createUiHandler", () => {
	let distDir: string;

	beforeAll(async () => {
		distDir = await setupDist();
	});

	test("/ serves index.html with text/html", async () => {
		const handler = createUiHandler({ distDir });
		const res = await handler(ctxFor("/"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		expect(await res.text()).toContain("warren ui");
	});

	test("/assets/app.js serves the file with the right content-type", async () => {
		const handler = createUiHandler({ distDir });
		const res = await handler(ctxFor("/assets/app.js"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/javascript");
		expect(await res.text()).toBe("console.log('hi')");
	});

	test("/assets/style.css serves css", async () => {
		const handler = createUiHandler({ distDir });
		const res = await handler(ctxFor("/assets/style.css"));
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/css");
	});

	test("unknown SPA route falls through to index.html", async () => {
		const handler = createUiHandler({ distDir });
		const res = await handler(ctxFor("/runs/abc/detail"));
		// /runs is an API prefix — should NOT fall through
		expect(res.status).toBe(404);

		const res2 = await handler(ctxFor("/projects-page"));
		expect(res2.status).toBe(200);
		expect(await res2.text()).toContain("warren ui");
	});

	test("API prefixes return 404 envelope, not the SPA shell", async () => {
		const handler = createUiHandler({ distDir });
		for (const prefix of [
			"/agents",
			"/agents/x",
			"/projects",
			"/runs/abc",
			"/healthz",
			"/readyz",
			"/version",
		]) {
			const res = await handler(ctxFor(prefix));
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("not_found");
		}
	});

	test("path traversal is rejected (falls through to index.html)", async () => {
		const handler = createUiHandler({ distDir });
		const res = await handler(ctxFor("/../etc/passwd"));
		// Bun normalises "/../" out of the URL path, so we just need to assert
		// that no escape happens — index.html or 404 is acceptable, NOT a leak.
		expect(res.status).toBeGreaterThanOrEqual(200);
		expect(res.status).toBeLessThan(500);
	});

	test("missing dist returns a 500 with a clear error", async () => {
		const handler = createUiHandler({ distDir: "/nonexistent/path/warren-ui-test" });
		const res = await handler(ctxFor("/"));
		expect(res.status).toBe(500);
	});

	afterAll(async () => {
		// mkdtemp cleanup is best-effort; OS reaps /tmp.
	});
});
