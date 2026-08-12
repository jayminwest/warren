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

export interface StubAppServerOptions {
	/** Token the access_tokens route mints; defaults to a `ghs_`-shaped stub. */
	readonly installationToken?: string;
	/** ISO expiry the route reports; defaults to one hour from now. */
	readonly expiresAt?: string;
	/** App slug `GET /app` reports; defaults to "warren-stub-app". */
	readonly slug?: string;
	/** Count of access_tokens calls, for cache assertions. */
	readonly mints?: { count: number };
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
		const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(raw);
		const method = (init?.method ?? "GET").toUpperCase();
		if (url.pathname.endsWith("/access_tokens") && method === "POST") {
			if (options.mints !== undefined) options.mints.count += 1;
			return jsonResponse(201, { token, expires_at: expiresAt });
		}
		if (url.pathname === "/app" && method === "GET") {
			return jsonResponse(200, { slug });
		}
		return reposStub(input, init);
	}) as unknown as typeof fetch;
	return { fetch: fn };
}
