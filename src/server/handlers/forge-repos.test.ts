/**
 * Wire-level tests for `GET /forge/repos` (warren-2601 / pl-26f3 step 10).
 *
 * Three arms the picker branches on: the App forge lists its installation's
 * repositories, a PAT/no-installation forge answers `supported: false` with
 * an empty list, and a listing failure degrades to the same discriminant
 * with the redacted forge detail — never a 5xx, because the URL-paste
 * fallback must stay usable.
 */

import { describe, expect, test } from "bun:test";
import type { Forge, ForgeCapabilities } from "../../forge/contract.ts";
import { FakeForge } from "../../forge/fake/fake-forge.ts";
import { GitHubAppForge } from "../../forge/github-app/provider.ts";
import {
	generateTestAppKeyPair,
	stubGitHubAppServer,
} from "../../forge/github-app/test-helpers.ts";
import { FakeProvider } from "../../runtime/fake/fake-provider.ts";
import type { RouteContext } from "../types.ts";
import { forgeReposHandler } from "./forge-repos.ts";
import { depsFor } from "./runs.test-helpers.ts";

function ctxFor(url: string): RouteContext {
	return {
		request: new Request(url),
		url: new URL(url),
		params: {},
		requestId: "req-test",
		logger: {
			info() {},
			warn() {},
			error() {},
			debug() {},
			child() {
				return this;
			},
		} as unknown as RouteContext["logger"],
	};
}

const BASE = "http://127.0.0.1:8377";

async function depsWithForge(forge: Forge) {
	const db = await import("../../db/client.ts").then((m) => m.openDatabase({ path: ":memory:" }));
	const repos = await import("../../db/repos/index.ts").then((m) => m.createRepos(db));
	const deps = await depsFor(repos, new FakeProvider());
	return { ...deps, forge };
}

function makeAppForge(options: { fetch: typeof globalThis.fetch }): Forge {
	const { privateKeyPem } = generateTestAppKeyPair();
	return new GitHubAppForge({
		appId: "1",
		installationId: "2",
		privateKey: privateKeyPem,
		...options,
	});
}

describe("GET /forge/repos", () => {
	test("lists the App installation's repositories with picker fields", async () => {
		const { fetch } = stubGitHubAppServer({
			installationRepos: [
				{ owner: "acme", name: "widgets", defaultBranch: "trunk", private: true },
				{ owner: "acme", name: "gadgets" },
			],
		});
		const handler = forgeReposHandler(await depsWithForge(makeAppForge({ fetch })));
		const res = await handler(ctxFor(`${BASE}/forge/repos`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			supported: boolean;
			repos: Array<{
				owner: string;
				name: string;
				cloneUrl: string;
				defaultBranch: string;
				private: boolean;
			}>;
		};
		expect(body.supported).toBe(true);
		expect(body.repos).toEqual([
			{
				owner: "acme",
				name: "widgets",
				cloneUrl: "https://github.com/acme/widgets.git",
				defaultBranch: "trunk",
				private: true,
			},
			{
				owner: "acme",
				name: "gadgets",
				cloneUrl: "https://github.com/acme/gadgets.git",
				defaultBranch: "main",
				private: false,
			},
		]);
	});

	test("walks installation-repository pages until a short page", async () => {
		const many = Array.from({ length: 105 }, (_, i) => ({ owner: "acme", name: `r${i}` }));
		const { fetch } = stubGitHubAppServer({ installationRepos: many });
		const handler = forgeReposHandler(await depsWithForge(makeAppForge({ fetch })));
		const res = await handler(ctxFor(`${BASE}/forge/repos`));
		const body = (await res.json()) as { supported: boolean; repos: unknown[] };
		expect(body.supported).toBe(true);
		expect(body.repos.length).toBe(105);
	});

	test("answers supported:false with an empty list for a PAT (no installation scope)", async () => {
		const handler = forgeReposHandler(await depsWithForge(new FakeForge()));
		const res = await handler(ctxFor(`${BASE}/forge/repos`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { supported: boolean; repos: unknown[] };
		expect(body).toEqual({ supported: false, repos: [] });
	});

	test("degrades a listing failure to supported:false with the forge detail", async () => {
		// Class extension (not spread) — Forge methods live on the prototype,
		// so a spread copy would drop them.
		class FailingListingForge extends FakeForge {
			override readonly capabilities: ForgeCapabilities = {
				...new FakeForge().capabilities,
				installationRepos: true,
			};
			override listInstallationRepos(): ReturnType<FakeForge["listInstallationRepos"]> {
				return Promise.resolve({
					ok: false as const,
					error: { kind: "no_credential", detail: "installation token mint failed" },
				});
			}
		}
		const handler = forgeReposHandler(await depsWithForge(new FailingListingForge()));
		const res = await handler(ctxFor(`${BASE}/forge/repos`));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { supported: boolean; repos: unknown[]; error?: string };
		expect(body.supported).toBe(false);
		expect(body.repos).toEqual([]);
		expect(body.error).toBe("installation token mint failed");
	});
});
