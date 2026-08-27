import { describe, expect, test } from "bun:test";
import { fetchGitHubUserLogin } from "./user-lookup.ts";

function jsonResponse(body: unknown, status = 200): Response {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function fakeFetch(responder: (input: unknown, init?: RequestInit) => Response): typeof fetch {
	return responder as unknown as typeof fetch;
}

describe("fetchGitHubUserLogin", () => {
	test("returns the login and id for an authenticated user", async () => {
		const calls: string[] = [];
		const user = await fetchGitHubUserLogin("ghp_test", {
			fetch: fakeFetch((input, init) => {
				calls.push(String(input));
				expect((init?.headers as Record<string, string>).authorization).toBe("Bearer ghp_test");
				return jsonResponse({ login: "octocat", id: 123 });
			}),
		});
		expect(user).toEqual({ login: "octocat", id: 123 });
		expect(calls).toEqual(["https://api.github.com/user"]);
	});

	test("returns undefined on a non-2xx response", async () => {
		const user = await fetchGitHubUserLogin("ghp_bad", {
			fetch: fakeFetch(() => jsonResponse({ message: "Bad credentials" }, 401)),
		});
		expect(user).toBeUndefined();
	});

	test("returns undefined on an unparseable or malformed body", async () => {
		const badJson = await fetchGitHubUserLogin("t", {
			fetch: fakeFetch(() => new Response("<html>not json</html>", { status: 200 })),
		});
		expect(badJson).toBeUndefined();
		const badShape = await fetchGitHubUserLogin("t", {
			fetch: fakeFetch(() => jsonResponse({ login: "octocat" })),
		});
		expect(badShape).toBeUndefined();
	});
});
