/**
 * Static SPA serving from `src/ui/dist` (SPEC §6, §7).
 *
 * Phase 9's UI surface is just the file server: Phase 10 builds the
 * actual React app. The wiring here lets warren ship the dist dir
 * inside its container image and serve it from the same Bun.serve
 * the API rides on (no nginx, no separate origin → no CORS dance).
 *
 * Three behaviours:
 *   - GET /                       → serve `index.html`
 *   - GET /assets/<file>          → serve the file with its content-type
 *   - GET /<spa-route>            → fall through to `index.html` so React
 *                                    Router can handle deep links
 *
 * API routes register *before* the UI catch-all in `routes.ts`, so the
 * UI handler only ever sees requests that didn't match a real route.
 *
 * Path safety: every requested path is `resolve()`d under the dist root
 * and rejected if it escapes (defense-in-depth against path traversal,
 * even though the request URL is already URL-decoded by Bun). Files are
 * served via `Bun.file()` for zero-copy streaming.
 */

import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { RouteContext, RouteHandler } from "./types.ts";

const CONTENT_TYPES: Readonly<Record<string, string>> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".mjs": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".gif": "image/gif",
	".webp": "image/webp",
	".ico": "image/x-icon",
	".woff": "font/woff",
	".woff2": "font/woff2",
	".ttf": "font/ttf",
	".otf": "font/otf",
	".map": "application/json; charset=utf-8",
	".txt": "text/plain; charset=utf-8",
};

export interface UiHandlerOptions {
	readonly distDir: string;
	/** Override `Bun.file` for tests / sandboxed environments. */
	readonly readFile?: (path: string) => { exists: boolean; bytes(): Promise<Uint8Array> };
}

export function createUiHandler(opts: UiHandlerOptions): RouteHandler {
	const root = resolve(opts.distDir);
	const indexPath = join(root, "index.html");
	const readFile = opts.readFile ?? defaultReadFile;

	return async (ctx: RouteContext): Promise<Response> => {
		const requested = decodePath(ctx.url.pathname);

		// Try the literal file under dist first.
		const candidate = resolveUnder(root, requested);
		if (candidate !== null) {
			const file = readFile(candidate);
			if (file.exists) return await renderFile(candidate, file);
		}

		// Fall through to SPA index.html for deep links.
		const index = readFile(indexPath);
		if (!index.exists) {
			return new Response("ui dist missing", {
				status: 500,
				headers: { "content-type": "text/plain" },
			});
		}
		return await renderFile(indexPath, index);
	};
}

function decodePath(pathname: string): string {
	if (pathname === "" || pathname === "/") return "/";
	try {
		return decodeURIComponent(pathname);
	} catch {
		return pathname;
	}
}

/**
 * Resolve `pathname` against the dist root, rejecting any path that
 * escapes (`..` traversal, absolute paths). Returns the canonical path
 * inside `root`, or null when the request should be rejected.
 */
function resolveUnder(root: string, pathname: string): string | null {
	if (pathname === "/" || pathname === "") return null;
	const trimmed = pathname.startsWith("/") ? pathname.slice(1) : pathname;
	if (trimmed === "") return null;
	const candidate = resolve(root, trimmed);
	if (candidate !== root && !candidate.startsWith(root + sep)) return null;
	return candidate;
}

async function renderFile(path: string, file: { bytes(): Promise<Uint8Array> }): Promise<Response> {
	const bytes = await file.bytes();
	// `bytes` is Uint8Array<ArrayBufferLike>; the Response BodyInit expects
	// BufferSource. Use the .buffer slice to give Response a plain
	// ArrayBuffer view it can stream.
	const body = bytes.buffer.slice(
		bytes.byteOffset,
		bytes.byteOffset + bytes.byteLength,
	) as ArrayBuffer;
	return new Response(body, {
		status: 200,
		headers: {
			"content-type": contentTypeFor(path),
			"cache-control": "no-store",
		},
	});
}

function contentTypeFor(path: string): string {
	const idx = path.lastIndexOf(".");
	if (idx === -1) return "application/octet-stream";
	const ext = path.slice(idx).toLowerCase();
	return CONTENT_TYPES[ext] ?? "application/octet-stream";
}

interface ReadResult {
	exists: boolean;
	bytes(): Promise<Uint8Array>;
}

function defaultReadFile(path: string): ReadResult {
	if (!existsSync(path)) return missingFile;
	try {
		const stat = statSync(path);
		if (!stat.isFile()) return missingFile;
	} catch {
		return missingFile;
	}
	const file = Bun.file(path);
	return {
		exists: true,
		bytes: () => file.bytes(),
	};
}

const missingFile: ReadResult = {
	exists: false,
	bytes: async () => new Uint8Array(),
};
