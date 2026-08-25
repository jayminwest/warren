import { describe, expect, test } from "bun:test";
import { ValidationError } from "../errors.ts";
import { renderCrossForkPullRequestIntent } from "./pr-request.ts";

describe("renderCrossForkPullRequestIntent", () => {
	test("renders the exact cross-fork POST body with a fork-qualified head", () => {
		const intent = renderCrossForkPullRequestIntent({
			upstreamOwner: "openclaw",
			upstreamRepo: "openclaw",
			baseBranch: "main",
			forkOwner: "warren-run-bot",
			headBranch: "warren/issue-42",
			title: "Fix the thing (#42)",
			body: "Closes #42.\n\nEvidence: …",
		});
		expect(intent.method).toBe("POST");
		expect(intent.url).toBe("/repos/openclaw/openclaw/pulls");
		expect(intent.body).toEqual({
			title: "Fix the thing (#42)",
			head: "warren-run-bot:warren/issue-42",
			base: "main",
			body: "Closes #42.\n\nEvidence: …",
			maintainer_can_modify: true,
			draft: true,
		});
	});

	test("draft defaults true and maintainer_can_modify can be set false", () => {
		const intent = renderCrossForkPullRequestIntent({
			upstreamOwner: "o",
			upstreamRepo: "r",
			baseBranch: "main",
			forkOwner: "bot",
			headBranch: "b",
			title: "t",
			body: "b",
			draft: false,
			maintainerCanModify: false,
		});
		expect(intent.body.draft).toBe(false);
		expect(intent.body.maintainer_can_modify).toBe(false);
	});

	test("the rendered intent is deeply frozen as tamper-evident dry-run proof", () => {
		const intent = renderCrossForkPullRequestIntent({
			upstreamOwner: "o",
			upstreamRepo: "r",
			baseBranch: "main",
			forkOwner: "bot",
			headBranch: "b",
			title: "t",
			body: "b",
		});
		expect(Object.isFrozen(intent)).toBe(true);
		expect(Object.isFrozen(intent.body)).toBe(true);
		expect(() => {
			(intent.body as { title: string }).title = "tampered";
		}).toThrow();
	});

	test("rejects missing required fields as ValidationError", () => {
		expect(() =>
			renderCrossForkPullRequestIntent({
				upstreamOwner: "",
				upstreamRepo: "r",
				baseBranch: "main",
				forkOwner: "bot",
				headBranch: "b",
				title: "t",
				body: "b",
			}),
		).toThrow(ValidationError);
		expect(() =>
			renderCrossForkPullRequestIntent({
				upstreamOwner: "o",
				upstreamRepo: "r",
				baseBranch: "main",
				forkOwner: "bot",
				headBranch: "b",
				title: "t",
				body: "",
			}),
		).toThrow(ValidationError);
	});

	test("rendering performs no transport I/O — the module has no transport import", async () => {
		const source = await Bun.file(new URL("./pr-request.ts", import.meta.url).pathname).text();
		expect(source.includes("GithubTransport")).toBe(false);
		expect(source.includes("http-transport")).toBe(false);
		expect(source.includes("fetch(")).toBe(false);
	});
});
