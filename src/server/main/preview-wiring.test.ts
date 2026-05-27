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
import { createPreviewAuthAndProxy } from "./preview-wiring.ts";

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
			repos: stubRepos,
			logger,
		});
		expect(result.previewAuth).toBeDefined();
		expect(result.previewProxy).toBeDefined();
	});
});
