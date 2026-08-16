/**
 * Unit tests for `createPreviewAuthAndProxy` (warren-8d3d / pl-9088
 * step 10). Locks the four-way matrix derived from
 * (token null | non-null) × (mode 'path' | 'subdomain' with host null
 * | non-null) so the split keeps the same off-by-default semantics:
 * - `--no-auth` (token null)  → off in every mode
 * - subdomain mode + host null → off (warns)
 * - subdomain mode + host set  → on
 * - path mode + any host       → on
 */

import { describe, expect, test } from "bun:test";
import type { Repos } from "../../db/repos/index.ts";
import type { Logger } from "../types.ts";
import { bootPreviewSurface, createPreviewAuthAndProxy } from "./preview-wiring.ts";

function makeLogger(): { logger: Logger; warns: Array<{ obj: object; msg?: string }> } {
	const warns: Array<{ obj: object; msg?: string }> = [];
	const logger = {
		info: () => {},
		warn: (obj: object, msg?: string) => warns.push({ obj, msg }),
		error: () => {},
		debug: () => {},
	} as unknown as Logger;
	return { logger, warns };
}

const stubRepos = {} as Repos;

describe("createPreviewAuthAndProxy", () => {
	test("token null → both auth and proxy are undefined (no-auth disables surface)", () => {
		const { logger } = makeLogger();
		const result = createPreviewAuthAndProxy({
			token: null,
			previewLaunchConfig: {
				mode: "subdomain",
				host: "preview.example",
			} as ReturnType<typeof Object>,
			previewPorts: true,
			repos: stubRepos,
			logger,
		});
		expect(result.previewAuth).toBeUndefined();
		expect(result.previewProxy).toBeUndefined();
	});

	test("subdomain mode + host null → off (and warning is NOT emitted because host is null)", () => {
		const { logger, warns } = makeLogger();
		const result = createPreviewAuthAndProxy({
			token: "secret",
			previewLaunchConfig: { mode: "subdomain", host: null } as ReturnType<typeof Object>,
			previewPorts: true,
			repos: stubRepos,
			logger,
		});
		expect(result.previewAuth).toBeUndefined();
		expect(result.previewProxy).toBeUndefined();
		expect(warns).toEqual([]);
	});

	test("token non-null + --no-auth-style host-set-without-auth path is not triggered when token exists (smoke)", () => {
		const { logger, warns } = makeLogger();
		const result = createPreviewAuthAndProxy({
			token: "secret",
			previewLaunchConfig: {
				mode: "subdomain",
				host: "preview.example",
			} as ReturnType<typeof Object>,
			previewPorts: true,
			repos: stubRepos,
			logger,
		});
		expect(result.previewAuth).toBeDefined();
		expect(result.previewProxy).toBeDefined();
		expect(warns).toEqual([]);
	});

	test("path mode + token set → both auth and proxy wired (host optional)", () => {
		const { logger } = makeLogger();
		const result = createPreviewAuthAndProxy({
			token: "secret",
			previewLaunchConfig: { mode: "path", host: null } as ReturnType<typeof Object>,
			previewPorts: true,
			repos: stubRepos,
			logger,
		});
		expect(result.previewAuth).toBeDefined();
		expect(result.previewProxy).toBeDefined();
	});
	test("previewPorts: false → off in every mode, regardless of token/host (warren-820e)", () => {
		const { logger } = makeLogger();
		const cases = [
			{ mode: "path", host: null },
			{ mode: "path", host: "preview.example" },
			{ mode: "subdomain", host: null },
			{ mode: "subdomain", host: "preview.example" },
		];
		for (const previewLaunchConfig of cases) {
			const result = createPreviewAuthAndProxy({
				token: "secret",
				previewLaunchConfig: {
					...previewLaunchConfig,
				} as ReturnType<typeof Object>,
				previewPorts: false,
				repos: stubRepos,
				logger,
			});
			expect(result.previewAuth).toBeUndefined();
			expect(result.previewProxy).toBeUndefined();
		}
	});
});

describe("bootPreviewSurface (warren-3f8a)", () => {
	test("path mode on TCP boots the dedicated listener and redirects /p/ off the main origin", async () => {
		const { logger } = makeLogger();
		const surface = bootPreviewSurface({
			token: "secret",
			previewLaunchConfig: { mode: "path", host: null, port: null },
			previewPorts: true,
			repos: stubRepos,
			logger,
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		});
		try {
			expect(surface.previewAuth).toBeDefined();
			expect(surface.previewListener).toBeDefined();
			const port = surface.launchConfig.port;
			expect(port).not.toBeNull();
			expect(port).toBeGreaterThan(0);
			// The main-listener preamble is the 308 redirect, not the proxy.
			const request = new Request("http://127.0.0.1:9/p/run_abc/?q=1");
			const response = await surface.mainPreamble?.(request, new URL(request.url));
			expect(response?.status).toBe(308);
			expect(response?.headers.get("location")).toBe(`http://127.0.0.1:${port}/p/run_abc/?q=1`);
			// Non-preview paths fall through to the regular pipeline.
			const other = new Request("http://127.0.0.1:9/runs/run_abc");
			expect(await surface.mainPreamble?.(other, new URL(other.url))).toBeNull();
		} finally {
			await surface.previewListener?.stop();
		}
	});

	test("dedicated listener serves only the preview surface (404 elsewhere)", async () => {
		const { logger } = makeLogger();
		const surface = bootPreviewSurface({
			token: "secret",
			previewLaunchConfig: { mode: "path", host: null, port: null },
			previewPorts: true,
			repos: stubRepos,
			logger,
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		});
		try {
			const res = await fetch(`${surface.previewListener?.url}/whoami`);
			expect(res.status).toBe(404);
			const body = (await res.json()) as { error: { code: string } };
			expect(body.error.code).toBe("preview_not_found");
		} finally {
			await surface.previewListener?.stop();
		}
	});

	test("subdomain mode keeps the proxy on the main listener (no dedicated port)", () => {
		const { logger } = makeLogger();
		const surface = bootPreviewSurface({
			token: "secret",
			previewLaunchConfig: { mode: "subdomain", host: "preview.example", port: null },
			previewPorts: true,
			repos: stubRepos,
			logger,
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		});
		expect(surface.previewListener).toBeUndefined();
		expect(surface.mainPreamble).toBeDefined();
		expect(surface.launchConfig.port).toBeNull();
	});

	test("unix transport keeps the legacy same-origin mounting and warns", () => {
		const { logger, warns } = makeLogger();
		const surface = bootPreviewSurface({
			token: "secret",
			previewLaunchConfig: { mode: "path", host: null, port: null },
			previewPorts: true,
			repos: stubRepos,
			logger,
			transport: { kind: "unix", path: "/tmp/warren-test.sock" },
		});
		expect(surface.previewListener).toBeUndefined();
		expect(surface.mainPreamble).toBeDefined();
		expect(surface.launchConfig.port).toBeNull();
		expect(warns.some((w) => w.msg?.includes("warren-3f8a"))).toBe(true);
	});

	test("previewPorts: false disables the whole surface (no preamble, no listener)", () => {
		const { logger, warns } = makeLogger();
		const surface = bootPreviewSurface({
			token: "secret",
			previewLaunchConfig: { mode: "path", host: null, port: null },
			previewPorts: false,
			repos: stubRepos,
			logger,
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		});
		expect(surface.previewAuth).toBeUndefined();
		expect(surface.mainPreamble).toBeUndefined();
		expect(surface.previewListener).toBeUndefined();
		expect(surface.launchConfig.port).toBeNull();
		expect(warns).toEqual([]);
	});

	test("disabled surface (token null) yields no preamble and no listener", () => {
		const { logger } = makeLogger();
		const surface = bootPreviewSurface({
			token: null,
			previewLaunchConfig: { mode: "path", host: null, port: null },
			previewPorts: true,
			repos: stubRepos,
			logger,
			transport: { kind: "tcp", hostname: "127.0.0.1", port: 0 },
		});
		expect(surface.previewAuth).toBeUndefined();
		expect(surface.mainPreamble).toBeUndefined();
		expect(surface.previewListener).toBeUndefined();
	});
});
