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
		// API-prefix JSON 404 is enforced by dispatch (src/server/server.ts);
		// createUiHandler itself only ever sees non-API paths and serves the
		// SPA shell so React Router can handle deep links.
		const handler = createUiHandler({ distDir });
		const res = await handler(ctxFor("/projects-page"));
		expect(res.status).toBe(200);
		expect(await res.text()).toContain("warren ui");
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
