import { describe, expect, test } from "bun:test";
import { ReadOnlyGithubClient } from "./client.ts";
import { GithubRateLimitError } from "./errors.ts";
import { FakeGithubServer } from "./fake-server.ts";

const TOKEN = "ghp_test-token-value-123";

describe("rate limit classification", () => {
	test("an exhausted primary limit raises a primary GithubRateLimitError", async () => {
		const server = new FakeGithubServer({ redactionSecret: TOKEN })
			.setResource("/repos/openclaw/openclaw", { node_id: "R_1" })
			.setRateLimit({ limit: 5000, remaining: 0, resetEpochSeconds: 1_800_000_000 });
		const client = new ReadOnlyGithubClient(server);
		try {
			await client.getRepository("openclaw", "openclaw");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(GithubRateLimitError);
			const rate = error as GithubRateLimitError;
			expect(rate.kind).toBe("primary");
			expect(rate.limit).toBe(5000);
			expect(rate.remaining).toBe(0);
			expect(rate.resetEpochSeconds).toBe(1_800_000_000);
			expect(JSON.stringify(rate.toJson())).not.toContain(TOKEN);
		}
	});

	test("an abuse-detection response raises a secondary GithubRateLimitError", async () => {
		const server = new FakeGithubServer({ redactionSecret: TOKEN })
			.setResource("/repos/openclaw/openclaw", { node_id: "R_1" })
			.setAbuseDetection({ retryAfterSeconds: 30 });
		const client = new ReadOnlyGithubClient(server);
		try {
			await client.getRepository("openclaw", "openclaw");
			expect.unreachable();
		} catch (error) {
			expect(error).toBeInstanceOf(GithubRateLimitError);
			const rate = error as GithubRateLimitError;
			expect(rate.kind).toBe("secondary");
			expect(rate.retryAfterSeconds).toBe(30);
		}
	});

	test("clearing the rate limits lets reads through again", async () => {
		const server = new FakeGithubServer()
			.setResource("/repos/openclaw/openclaw", {
				node_id: "R_1",
				name: "openclaw",
				full_name: "openclaw/openclaw",
				owner: { login: "openclaw" },
				default_branch: "main",
				fork: false,
				archived: false,
				html_url: "u",
			})
			.setRateLimit({ limit: 5000, remaining: 0, resetEpochSeconds: 1 });
		const client = new ReadOnlyGithubClient(server);
		await expect(client.getRepository("openclaw", "openclaw")).rejects.toBeInstanceOf(
			GithubRateLimitError,
		);
		server.clearRateLimits();
		const result = await client.getRepository("openclaw", "openclaw");
		expect(result.data?.name).toBe("openclaw");
	});
});
