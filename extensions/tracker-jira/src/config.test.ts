import { describe, expect, test } from "bun:test";
import { ConfigError, jiraAuthHeader, loadConfig } from "./config.ts";

const base = {
	JIRA_BASE_URL: "https://acme.atlassian.net",
	JIRA_EMAIL: "bot@acme.example",
	JIRA_API_TOKEN: "token-123",
	JIRA_JQL: "project = WAR AND labels = warren",
};

describe("loadConfig", () => {
	test("reads the minimum a Jira Cloud site needs", () => {
		const config = loadConfig(base);
		expect(config.baseUrl).toBe("https://acme.atlassian.net");
		expect(config.auth).toEqual({
			kind: "basic",
			email: "bot@acme.example",
			apiToken: "token-123",
		});
		expect(config.jql).toBe("project = WAR AND labels = warren");
		expect(config.port).toBe(8080);
		expect(config.blockedByInward).toBe("is blocked by");
		expect(config.bearerToken).toBeUndefined();
	});

	test("trims the trailing slash off the site url", () => {
		expect(loadConfig({ ...base, JIRA_BASE_URL: "https://acme.atlassian.net//" }).baseUrl).toBe(
			"https://acme.atlassian.net",
		);
	});

	test("names the variable that is missing", () => {
		expect(() => loadConfig({ ...base, JIRA_JQL: undefined })).toThrow(/JIRA_JQL is required/);
		expect(() => loadConfig({ ...base, JIRA_BASE_URL: "  " })).toThrow(/JIRA_BASE_URL is required/);
	});

	test("refuses a site url that is not http", () => {
		expect(() => loadConfig({ ...base, JIRA_BASE_URL: "acme.atlassian.net" })).toThrow(ConfigError);
	});

	test("takes JIRA_BEARER instead of the email and token pair", () => {
		const config = loadConfig({
			...base,
			JIRA_EMAIL: undefined,
			JIRA_API_TOKEN: undefined,
			JIRA_BEARER: "oauth-abc",
		});
		expect(config.auth).toEqual({ kind: "bearer", token: "oauth-abc" });
	});

	test("refuses both auth modes at once rather than picking one", () => {
		expect(() => loadConfig({ ...base, JIRA_BEARER: "oauth-abc" })).toThrow(/not both/);
	});

	test("refuses half of the basic pair", () => {
		expect(() => loadConfig({ ...base, JIRA_API_TOKEN: undefined })).toThrow(/JIRA_API_TOKEN/);
	});

	test("refuses a port that is not a positive whole number", () => {
		expect(() => loadConfig({ ...base, TRACKER_PORT: "0" })).toThrow(/positive whole number/);
		expect(() => loadConfig({ ...base, TRACKER_PORT: "http" })).toThrow(/positive whole number/);
		expect(loadConfig({ ...base, TRACKER_PORT: "9000" }).port).toBe(9000);
	});

	test("carries the warren-facing bearer separately from the Jira credential", () => {
		const config = loadConfig({ ...base, TRACKER_BEARER: "warren-side" });
		expect(config.bearerToken).toBe("warren-side");
		expect(config.auth).toEqual({
			kind: "basic",
			email: "bot@acme.example",
			apiToken: "token-123",
		});
	});
});

describe("jiraAuthHeader", () => {
	test("base64-encodes the email and token for basic auth", () => {
		const header = jiraAuthHeader({ kind: "basic", email: "a@b.c", apiToken: "t" });
		expect(header).toBe(`Basic ${Buffer.from("a@b.c:t").toString("base64")}`);
	});

	test("passes a bearer token through", () => {
		expect(jiraAuthHeader({ kind: "bearer", token: "abc" })).toBe("Bearer abc");
	});
});
