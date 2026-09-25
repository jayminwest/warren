import { describe, expect, test } from "bun:test";
import { createSecretKey } from "node:crypto";
import { jsonResponse, recordingFetch } from "../github/test-helpers.ts";
import {
	INSTALLATION_TOKEN_EXPIRY_MARGIN_MS,
	InstallationTokenSource,
} from "./installation-tokens.ts";
import { parseGitHubAppPrivateKey } from "./jwt.ts";
import { generateTestAppKeyPair } from "./test-helpers.ts";

const ONE_HOUR_MS = 60 * 60 * 1000;

function makeSource(
	overrides: Partial<ConstructorParameters<typeof InstallationTokenSource>[0]> = {},
) {
	const { privateKeyPem } = generateTestAppKeyPair();
	return new InstallationTokenSource({
		appId: "4560297",
		privateKey: parseGitHubAppPrivateKey(privateKeyPem),
		installationId: "555",
		...overrides,
	});
}

function tokenResponse(token: string, expiresAtMs: number): Response {
	return jsonResponse(201, { token, expires_at: new Date(expiresAtMs).toISOString() });
}

describe("InstallationTokenSource", () => {
	test("mints an installation token against the access_tokens route, JWT-authenticated", async () => {
		const { fetch, calls } = recordingFetch([
			tokenResponse("ghs_live_token", Date.now() + ONE_HOUR_MS),
		]);
		const source = makeSource({ fetch });
		const result = await source.mint();
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.secret).toBe("ghs_live_token");
		expect(typeof result.value.expiresAt).toBe("number");

		expect(calls).toHaveLength(1);
		const call = calls[0];
		if (call === undefined) throw new Error("expected one recorded call");
		expect(call.method).toBe("POST");
		expect(call.url).toBe("https://api.github.com/app/installations/555/access_tokens");
		// JWT bearer: three base64url segments, iss = the App id.
		const auth = call.headers.authorization ?? "";
		const jwt = auth.replace(/^Bearer /, "");
		expect(jwt.split(".")).toHaveLength(3);
		const payload = JSON.parse(
			Buffer.from(jwt.split(".")[1] as string, "base64url").toString("utf8"),
		) as { iss?: unknown };
		expect(payload.iss).toBe("4560297");
	});

	test("caches the token and reuses it until the expiry margin", async () => {
		const expiresAt = Date.now() + ONE_HOUR_MS;
		const { fetch, calls } = recordingFetch([tokenResponse("ghs_cached", expiresAt)]);
		const source = makeSource({ fetch });
		const first = await source.mint();
		const second = await source.mint();
		expect(first.ok && second.ok).toBe(true);
		expect(calls).toHaveLength(1);
	});

	test("re-mints once the cached token enters the expiry margin", async () => {
		const t0 = 1_800_000_000_000;
		let nowMs = t0;
		const { fetch, calls } = recordingFetch([
			tokenResponse("ghs_first", t0 + ONE_HOUR_MS),
			tokenResponse("ghs_second", t0 + ONE_HOUR_MS + 1000),
		]);
		const source = makeSource({ fetch, now: () => nowMs });
		const first = await source.mint();
		expect(first.ok && first.value.secret === "ghs_first").toBe(true);
		// Inside the margin: expiry - margin < now.
		nowMs = t0 + ONE_HOUR_MS - INSTALLATION_TOKEN_EXPIRY_MARGIN_MS + 1;
		const second = await source.mint();
		expect(second.ok && second.value.secret === "ghs_second").toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("mintFresh bypasses the cache read — the heartbeat probe's liveness proof (warren-1295)", async () => {
		const expiresAt = Date.now() + ONE_HOUR_MS;
		const { fetch, calls } = recordingFetch([
			tokenResponse("ghs_first", expiresAt),
			tokenResponse("ghs_fresh", expiresAt),
		]);
		const source = makeSource({ fetch });
		const cached = await source.mint();
		expect(cached.ok && cached.value.secret === "ghs_first").toBe(true);
		// A second mint() would be a cache hit; mintFresh must trade a new JWT.
		const fresh = await source.mintFresh();
		expect(fresh.ok && fresh.value.secret === "ghs_fresh").toBe(true);
		expect(calls).toHaveLength(2);
		// The fresh token lands in the cache — a probe tick warms real traffic.
		const after = await source.mint();
		expect(after.ok && after.value.secret === "ghs_fresh").toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("maps a 401 (bad App JWT / wrong installation) to unauthorized", async () => {
		const { fetch } = recordingFetch([jsonResponse(401, { message: "Bad credentials" })]);
		const source = makeSource({ fetch });
		const result = await source.mint();
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unauthorized");
	});

	test("maps a malformed access_tokens body to http_error and does not cache it", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(201, { token: "ghs_x" }), // no expires_at
			tokenResponse("ghs_recovered", Date.now() + ONE_HOUR_MS),
		]);
		const source = makeSource({ fetch });
		const failed = await source.mint();
		expect(failed.ok).toBe(false);
		if (!failed.ok) expect(failed.error.kind).toBe("http_error");
		const retried = await source.mint();
		expect(retried.ok && retried.value.secret === "ghs_recovered").toBe(true);
		expect(calls).toHaveLength(2);
	});

	test("surfaces an unsignable key as no_credential rather than throwing", async () => {
		const source = makeSource({
			privateKey: createSecretKey(Buffer.alloc(32)),
			fetch: (() => {
				throw new Error("fetch must not be reached when the JWT cannot be signed");
			}) as unknown as typeof fetch,
		});
		const result = await source.mint();
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("no_credential");
			expect(result.error.detail).toContain("failed to sign the GitHub App JWT");
		}
	});
});

describe("InstallationTokenSource.mintForRepository (warren-b425)", () => {
	test("scopes the token to one repository with contents and workflows write", async () => {
		const { fetch, calls } = recordingFetch([
			tokenResponse("ghs_scoped", Date.now() + ONE_HOUR_MS),
		]);
		const result = await makeSource({ fetch }).mintForRepository("widgets");
		expect(result.ok && result.value.secret === "ghs_scoped").toBe(true);
		expect(JSON.parse(calls[0]?.body ?? "null")).toEqual({
			repositories: ["widgets"],
			permissions: { contents: "write", workflows: "write" },
		});
	});

	test("falls back to contents-only when the installation lacks the workflows grant", async () => {
		const { fetch, calls } = recordingFetch([
			jsonResponse(422, {
				message: "The permissions requested are not granted to this installation.",
			}),
			tokenResponse("ghs_contents_only", Date.now() + ONE_HOUR_MS),
		]);
		const result = await makeSource({ fetch }).mintForRepository("widgets");
		expect(result.ok && result.value.secret === "ghs_contents_only").toBe(true);
		expect(JSON.parse(calls[1]?.body ?? "null")).toEqual({
			repositories: ["widgets"],
			permissions: { contents: "write" },
		});
	});

	test("caches per repository and never shares the installation-wide slot", async () => {
		const expiresAt = Date.now() + ONE_HOUR_MS;
		const { fetch, calls } = recordingFetch([
			tokenResponse("ghs_widgets", expiresAt),
			tokenResponse("ghs_gadgets", expiresAt),
			tokenResponse("ghs_installation", expiresAt),
		]);
		const source = makeSource({ fetch });
		expect((await source.mintForRepository("widgets")).ok).toBe(true);
		const again = await source.mintForRepository("widgets");
		expect(again.ok && again.value.secret === "ghs_widgets").toBe(true);
		const other = await source.mintForRepository("gadgets");
		expect(other.ok && other.value.secret === "ghs_gadgets").toBe(true);
		const wide = await source.mint();
		expect(wide.ok && wide.value.secret === "ghs_installation").toBe(true);
		expect(calls).toHaveLength(3);
		expect(calls[2]?.body).toBe("{}");
	});

	test("does not retry a non-422 failure", async () => {
		const { fetch, calls } = recordingFetch([jsonResponse(401, { message: "Bad credentials" })]);
		const result = await makeSource({ fetch }).mintForRepository("widgets");
		expect(result.ok).toBe(false);
		expect(calls).toHaveLength(1);
	});
});
