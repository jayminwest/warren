import { describe, expect, test } from "bun:test";
import { loadConfig } from "./config.ts";
import { FakeGitHub } from "./fake-github.ts";
import { GitHubClient } from "./github/client.ts";
import { createHandler } from "./server.ts";

describe("GitHub tracker HTTP", () => {
	test("protects every endpoint before fetching GitHub and negotiates additive listing capability", async () => {
		const config = loadConfig({
			GITHUB_TOKEN: "secret",
			GITHUB_REPOSITORY: "acme/web",
			TRACKER_BEARER: "tracker-secret",
		});
		const fake = new FakeGitHub();
		const handler = createHandler(config, new GitHubClient(config, fake.fetch));
		expect((await handler(new Request("http://test/issues"))).status).toBe(401);
		expect(fake.requests).toHaveLength(0);
		const response = await handler(
			new Request("http://test/capabilities", {
				headers: { authorization: "Bearer tracker-secret" },
			}),
		);
		expect(await response.json()).toMatchObject({
			protocolVersion: "warren-tracker/v1",
			capabilities: { supportsIssueListing: true, isGitNative: false },
		});
	});
	test("serves ready issues and their full descriptions while statuses include closed issues", async () => {
		const config = loadConfig({ GITHUB_TOKEN: "secret", GITHUB_REPOSITORY: "acme/web" });
		const fake = new FakeGitHub();
		fake.issues.push({ number: 2, repository: "acme/web", state: "CLOSED" });
		const handler = createHandler(config, new GitHubClient(config, fake.fetch));
		const list = await (await handler(new Request("http://test/issues"))).json();
		expect(list.issues).toHaveLength(1);
		expect(list.issues[0].description).toContain("Acceptance");
		expect(await (await handler(new Request("http://test/issue-statuses"))).json()).toEqual({
			statuses: { "acme/web#1": "open", "acme/web#2": "closed" },
		});
		expect((await handler(new Request("http://test/issues/%"))).status).toBe(400);
	});
});
