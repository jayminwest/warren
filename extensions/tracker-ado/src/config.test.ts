import { describe, expect, test } from "bun:test";
import { adoAuthHeader, ConfigError, loadConfig } from "./config.ts";

const base = {
	ADO_ORG_URL: "https://dev.azure.com/acme",
	ADO_PROJECT: "Platform",
	ADO_PAT: "pat-123",
	ADO_WIQL: "SELECT [System.Id] FROM WorkItems WHERE [System.Tags] CONTAINS 'warren'",
};

describe("loadConfig", () => {
	test("reads the minimum an Azure DevOps project needs", () => {
		const config = loadConfig(base);
		expect(config.orgUrl).toBe("https://dev.azure.com/acme");
		expect(config.project).toBe("Platform");
		expect(config.auth).toEqual({ kind: "pat", token: "pat-123" });
		expect(config.wiql).toBe(base.ADO_WIQL);
		expect(config.port).toBe(8080);
		expect(config.blockedByLink).toBe("System.LinkTypes.Dependency-Reverse");
		expect(config.batchSize).toBe(200);
		expect(config.maxWiqlResults).toBe(5000);
		expect(config.bearerToken).toBeUndefined();
		expect(config.doneState).toBeUndefined();
	});

	test("trims the trailing slash off the organization url", () => {
		expect(loadConfig({ ...base, ADO_ORG_URL: "https://dev.azure.com/acme//" }).orgUrl).toBe(
			"https://dev.azure.com/acme",
		);
	});

	test("names the variable that is missing", () => {
		expect(() => loadConfig({ ...base, ADO_WIQL: undefined })).toThrow(/ADO_WIQL is required/);
		expect(() => loadConfig({ ...base, ADO_PROJECT: " " })).toThrow(/ADO_PROJECT is required/);
		expect(() => loadConfig({ ...base, ADO_ORG_URL: "" })).toThrow(/ADO_ORG_URL is required/);
	});

	test("refuses an organization url that is not https", () => {
		expect(() => loadConfig({ ...base, ADO_ORG_URL: "dev.azure.com/acme" })).toThrow(ConfigError);
		expect(() => loadConfig({ ...base, ADO_ORG_URL: "http://dev.azure.com/acme" })).toThrow(
			/must be an https URL/,
		);
		expect(() => loadConfig({ ...base, ADO_ORG_URL: "https://" })).toThrow(/must be an https URL/);
	});

	test("never echoes a value that could hold a credential", () => {
		for (const value of [
			"http://svc:S3cretPat@dev.azure.com/acme",
			"https://svc:S3cretPat@dev.azure.com/acme",
			"svc:S3cretPat@dev.azure.com/acme",
			"dev.azure.com/svc:S3cretPat@acme",
			"https://dev.azure.com/acme?token=S3cretPat",
			"https://dev.azure.com/acme#S3cretPat",
		]) {
			const failure = (() => {
				try {
					loadConfig({ ...base, ADO_ORG_URL: value });
					return undefined;
				} catch (err) {
					return err;
				}
			})();
			expect(failure).toBeInstanceOf(ConfigError);
			expect((failure as Error).message).not.toContain("S3cretPat");
		}
	});

	test("refuses credentials, a query or a fragment inside the organization url", () => {
		expect(() =>
			loadConfig({ ...base, ADO_ORG_URL: "https://user:pat@dev.azure.com/acme" }),
		).toThrow(/must not carry credentials/);
		expect(() =>
			loadConfig({ ...base, ADO_ORG_URL: "http://svc:S3cretPat@dev.azure.com/acme" }),
		).toThrow(/must not carry credentials/);
		expect(() => loadConfig({ ...base, ADO_ORG_URL: "https://dev.azure.com/acme?x=1" })).toThrow(
			/query or fragment/,
		);
		expect(() => loadConfig({ ...base, ADO_ORG_URL: "https://dev.azure.com/acme#top" })).toThrow(
			/query or fragment/,
		);
	});

	test("accepts an organization served under its own host", () => {
		expect(loadConfig({ ...base, ADO_ORG_URL: "https://acme.visualstudio.com" }).orgUrl).toBe(
			"https://acme.visualstudio.com",
		);
	});

	test("takes ADO_BEARER instead of a personal access token", () => {
		const config = loadConfig({ ...base, ADO_PAT: undefined, ADO_BEARER: "entra-abc" });
		expect(config.auth).toEqual({ kind: "bearer", token: "entra-abc" });
	});

	test("refuses both auth modes at once rather than picking one", () => {
		expect(() => loadConfig({ ...base, ADO_BEARER: "entra-abc" })).toThrow(/not both/);
	});

	test("refuses a missing credential and names both options", () => {
		expect(() => loadConfig({ ...base, ADO_PAT: undefined })).toThrow(/ADO_PAT.*ADO_BEARER/);
	});

	test("refuses a port that is not a positive whole number", () => {
		expect(() => loadConfig({ ...base, TRACKER_PORT: "0" })).toThrow(/positive whole number/);
		expect(() => loadConfig({ ...base, TRACKER_PORT: "http" })).toThrow(/positive whole number/);
		expect(() => loadConfig({ ...base, TRACKER_PORT: "65536" })).toThrow(/at most 65535/);
		expect(loadConfig({ ...base, TRACKER_PORT: "9000" }).port).toBe(9000);
	});

	test("carries a request deadline, thirty seconds unless configured", () => {
		expect(loadConfig(base).timeoutMs).toBe(30_000);
		expect(loadConfig({ ...base, ADO_TIMEOUT_MS: "5000" }).timeoutMs).toBe(5000);
		expect(() => loadConfig({ ...base, ADO_TIMEOUT_MS: "0" })).toThrow(/positive whole number/);
		expect(() => loadConfig({ ...base, ADO_TIMEOUT_MS: "1.5" })).toThrow(/positive whole number/);
	});

	test("refuses a batch size past the Azure DevOps limit", () => {
		expect(() => loadConfig({ ...base, ADO_BATCH_SIZE: "201" })).toThrow(/at most 200/);
		expect(loadConfig({ ...base, ADO_BATCH_SIZE: "50" }).batchSize).toBe(50);
	});

	test("carries the close state and the link type when configured", () => {
		const config = loadConfig({
			...base,
			ADO_DONE_STATE: "Resolved",
			ADO_BLOCKED_BY_LINK: "System.LinkTypes.Related",
		});
		expect(config.doneState).toBe("Resolved");
		expect(config.blockedByLink).toBe("System.LinkTypes.Related");
	});

	test("carries the warren-facing bearer separately from the Azure DevOps credential", () => {
		const config = loadConfig({ ...base, TRACKER_BEARER: "warren-side" });
		expect(config.bearerToken).toBe("warren-side");
		expect(config.auth).toEqual({ kind: "pat", token: "pat-123" });
	});
});

describe("adoAuthHeader", () => {
	test("base64-encodes an empty user name and the token for a personal access token", () => {
		const header = adoAuthHeader({ kind: "pat", token: "t" });
		expect(header).toBe(`Basic ${Buffer.from(":t").toString("base64")}`);
	});

	test("passes a bearer token through", () => {
		expect(adoAuthHeader({ kind: "bearer", token: "abc" })).toBe("Bearer abc");
	});
});
