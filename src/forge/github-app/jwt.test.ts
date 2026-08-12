import { describe, expect, test } from "bun:test";
import { createSecretKey, createVerify } from "node:crypto";
import {
	GITHUB_APP_JWT_IAT_BACKDATE_SECONDS,
	GITHUB_APP_JWT_TTL_SECONDS,
	mintGitHubAppJwt,
	normalizePrivateKeyPem,
	parseGitHubAppPrivateKey,
} from "./jwt.ts";
import { generateTestAppKeyPair } from "./test-helpers.ts";

function decodeSegment(segment: string): Record<string, unknown> {
	return JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("mintGitHubAppJwt", () => {
	test("mints an RS256 JWT that verifies against the public key", () => {
		const { publicKeyPem, privateKeyPem } = generateTestAppKeyPair();
		const jwt = mintGitHubAppJwt({
			appId: "12345",
			privateKey: parseGitHubAppPrivateKey(privateKeyPem),
		});
		const parts = jwt.split(".");
		expect(parts).toHaveLength(3);
		const header = decodeSegment(parts[0] as string);
		expect(header).toEqual({ alg: "RS256", typ: "JWT" });

		const verifier = createVerify("RSA-SHA256");
		verifier.update(`${parts[0]}.${parts[1]}`);
		verifier.end();
		expect(verifier.verify(publicKeyPem, parts[2] as string, "base64url")).toBe(true);
	});

	test("sets iss to the App id, backdates iat, and caps exp at the 10-minute maximum", () => {
		const { privateKeyPem } = generateTestAppKeyPair();
		const nowMs = 1_800_000_000_000;
		const jwt = mintGitHubAppJwt({
			appId: "4560297",
			privateKey: parseGitHubAppPrivateKey(privateKeyPem),
			now: () => nowMs,
		});
		const payload = decodeSegment(jwt.split(".")[1] as string);
		expect(payload.iss).toBe("4560297");
		expect(payload.iat).toBe(nowMs / 1000 - GITHUB_APP_JWT_IAT_BACKDATE_SECONDS);
		expect(payload.exp).toBe(nowMs / 1000 + GITHUB_APP_JWT_TTL_SECONDS);
		expect((payload.exp as number) - (payload.iat as number)).toBeLessThanOrEqual(660);
	});

	test("unfolds literal \\n sequences in an env-injected PEM", () => {
		const { privateKeyPem } = generateTestAppKeyPair();
		const flattened = privateKeyPem.replace(/\n/g, "\\n");
		expect(flattened).not.toContain("\n");
		const key = parseGitHubAppPrivateKey(flattened);
		const jwt = mintGitHubAppJwt({ appId: "1", privateKey: key });
		expect(jwt.split(".")).toHaveLength(3);
	});
});

describe("normalizePrivateKeyPem", () => {
	test("is a no-op on an already-multiline PEM", () => {
		const pem = "-----BEGIN KEY-----\nabc\n-----END KEY-----\n";
		expect(normalizePrivateKeyPem(pem)).toBe(pem);
	});
});

describe("parseGitHubAppPrivateKey", () => {
	test("throws on garbage input so boot fails loud", () => {
		expect(() => parseGitHubAppPrivateKey("not a pem")).toThrow();
	});

	test("throws when asked to sign with a symmetric key — the callers' defensive wrap", () => {
		expect(() =>
			mintGitHubAppJwt({ appId: "1", privateKey: createSecretKey(Buffer.alloc(32)) }),
		).toThrow();
	});
});
