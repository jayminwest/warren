/**
 * Test doubles for the GitHub App forge: a throwaway RSA keypair (the App
 * private key the provider parses at construction) and a fetch stub that
 * layers the two App-only routes (`POST /app/installations/:id/access_tokens`,
 * `GET /app`) over the shared `stubGitHubServer` PR/checks stub.
 */

import { generateKeyPairSync } from "node:crypto";
import { stubGitHubServer } from "../github/stub-server.ts";
import { jsonResponse } from "../github/test-helpers.ts";

/** A fresh RSA keypair per call — PEM strings, ready for the provider. */
export function generateTestAppKeyPair(): { publicKeyPem: string; privateKeyPem: string } {
	const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
	return {
		publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
		privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }),
	};
}

/** A repository the `/installation/repositories` stub reports. */
export interface StubInstallationRepo {
	readonly owner: string;
	readonly name: string;
	readonly defaultBranch?: string;
	readonly private?: boolean;
}

export interface StubAppServerOptions {
	/** Token the access_tokens route mints; defaults to a `ghs_`-shaped stub. */
	readonly installationToken?: string;
	/** ISO expiry the route reports; defaults to one hour from now. */
	readonly expiresAt?: string;
	/** App slug `GET /app` reports; defaults to "warren-stub-app". */
	readonly slug?: string;
	/** Count of access_tokens calls, for cache assertions. */
	readonly mints?: { count: number };
	/** warren-2601: repositories `GET /installation/repositories` reports. */
	readonly installationRepos?: readonly StubInstallationRepo[];
}

/** Resolve a fetch stub call into its URL + uppercased method. */
function requestRoute(input: URL | RequestInfo, init?: RequestInit): { url: URL; method: string } {
	const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
	const method = (init?.method ?? "GET").toUpperCase();
	return { url: new URL(raw), method };
}

/** Serve one `per_page`-paginated `/installation/repositories` page (warren-2601). */
function installationReposResponse(
	repos: readonly StubInstallationRepo[],
	searchParams: URLSearchParams,
): Response {
	const perPage = Number(searchParams.get("per_page") ?? "30");
	const page = Number(searchParams.get("page") ?? "1");
	const all = repos.map((r) => ({
		name: r.name,
		full_name: `${r.owner}/${r.name}`,
		private: r.private ?? false,
		clone_url: `https://github.com/${r.owner}/${r.name}.git`,
		default_branch: r.defaultBranch ?? "main",
		owner: { login: r.owner },
	}));
	const start = (page - 1) * perPage;
	return jsonResponse(200, {
		total_count: all.length,
		repositories: all.slice(start, start + perPage),
	});
}

/**
 * Fetch stub covering the App routes plus every `/repos/...` route the
 * delegated `GitHubForge` transport calls.
 */
export function stubGitHubAppServer(options: StubAppServerOptions = {}): { fetch: typeof fetch } {
	const reposStub = stubGitHubServer().fetch;
	const token = options.installationToken ?? "ghs_stub_installation_token";
	const expiresAt = options.expiresAt ?? new Date(Date.now() + 60 * 60 * 1000).toISOString();
	const slug = options.slug ?? "warren-stub-app";
	const fn = (async (input: URL | RequestInfo, init?: RequestInit): Promise<Response> => {
		const { url, method } = requestRoute(input, init);
		if (url.pathname.endsWith("/access_tokens") && method === "POST") {
			if (options.mints !== undefined) options.mints.count += 1;
			return jsonResponse(201, { token, expires_at: expiresAt });
		}
		if (url.pathname === "/app" && method === "GET") {
			return jsonResponse(200, { slug });
		}
		// warren-2601: the repo-picker listing route, paginated like the real endpoint
		// so the provider's page walk is exercised.
		if (url.pathname === "/installation/repositories" && method === "GET") {
			return installationReposResponse(options.installationRepos ?? [], url.searchParams);
		}
		return reposStub(input, init);
	}) as unknown as typeof fetch;
	return { fetch: fn };
}
