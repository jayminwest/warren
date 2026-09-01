import { describe, expect, test } from "bun:test";
import type { RepoRef } from "../contract.ts";
import { jsonResponse, recordingFetch } from "../github/test-helpers.ts";
import { ADO_PR_DESCRIPTION_MAX, AdoForge, fitPrDescription } from "./provider.ts";
import { stubAdoServer } from "./stub-server.ts";
import { CLONE_URL, setup } from "./test-helpers.ts";

const draft = {
	title: "Add the widget",
	body: "Body.",
	headBranch: "warren/run-1",
	baseBranch: "main",
};

describe("AdoForge capabilities and credential", () => {
	test("declares the PAT capability set", () => {
		const { forge } = setup();
		expect(forge.capabilities).toEqual({
			checkRuns: true,
			jobLogs: true,
			pullRequestBodyEdit: true,
			branchDelete: true,
			botIdentity: false,
			installationRepos: false,
			credentialLifetime: "static",
		});
	});

	test("gitCredential hands out the PAT with a static lifetime", async () => {
		const { forge, ref } = setup();
		const credential = await forge.gitCredential(ref);
		expect(credential).toEqual({
			ok: true,
			value: { username: "pat", secret: "test-pat", expiresAt: null },
		});
	});

	test("an empty token degrades every call to no_credential, naming the repo", async () => {
		const forge = new AdoForge({ token: "", fetch: stubAdoServer().fetch });
		const ref = forge.parseRepoRef(CLONE_URL) as RepoRef;
		const credential = await forge.gitCredential(ref);
		expect(credential.ok).toBe(false);
		if (!credential.ok) {
			expect(credential.error.kind).toBe("no_credential");
			expect(credential.error.detail).toContain(ref.key);
		}
		const opened = await forge.openPullRequest(ref, draft);
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.error.kind).toBe("no_credential");
	});

	test("every request carries the PAT as basic auth against the project-scoped API", async () => {
		const { forge, ref, stub } = setup();
		await forge.openPullRequest(ref, draft);
		const call = stub.state.calls[0];
		expect(call?.authorization).toBe(`Basic ${Buffer.from(":test-pat").toString("base64")}`);
		expect(call?.url).toBe(
			"https://dev.azure.com/acme/Widgets/_apis/git/repositories/widget/pullrequests?api-version=7.1",
		);
	});
});

describe("AdoForge pull requests", () => {
	test("openPullRequest posts refs/heads names and returns the web URL", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, { ...draft, draft: true });
		expect(opened.ok).toBe(true);
		if (!opened.ok) return;
		expect(opened.value).toEqual({
			forge: "ado",
			key: `${ref.key}#1`,
			number: 1,
			webUrl: "https://dev.azure.com/acme/Widgets/_git/widget/pullrequest/1",
		});
		expect(stub.state.prs[0]).toMatchObject({
			sourceRefName: "refs/heads/warren/run-1",
			targetRefName: "refs/heads/main",
			title: "Add the widget",
			description: "Body.",
		});
		expect(stub.state.calls[0]?.url).toContain("/pullrequests?");
	});

	test("a duplicate open resolves to the existing PR through the 409", async () => {
		const { forge, ref, stub } = setup();
		const first = await forge.openPullRequest(ref, draft);
		const second = await forge.openPullRequest(ref, draft);
		expect(first.ok && second.ok && second.value.number === first.value.number).toBe(true);
		expect(stub.state.calls.map((c) => c.method)).toEqual(["POST", "POST", "GET"]);
	});

	test("a fork-qualified head is unsupported rather than mis-targeted", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, { ...draft, headBranch: "fork:branch" });
		expect(opened.ok).toBe(false);
		if (!opened.ok) expect(opened.error.kind).toBe("unsupported");
		expect(stub.state.calls).toHaveLength(0);
	});

	test("findPullRequest filters on source, target and status", async () => {
		const { forge, ref, stub } = setup();
		await forge.openPullRequest(ref, draft);
		const found = await forge.findPullRequest(ref, {
			headBranch: "warren/run-1",
			baseBranch: "main",
		});
		expect(found.ok && found.value?.number).toBe(1);
		const url = new URL(stub.state.calls[1]?.url ?? "");
		expect(url.searchParams.get("searchCriteria.sourceRefName")).toBe("refs/heads/warren/run-1");
		expect(url.searchParams.get("searchCriteria.targetRefName")).toBe("refs/heads/main");
		expect(url.searchParams.get("searchCriteria.status")).toBe("active");
	});

	test("findPullRequest with state closed skips active PRs and finds abandoned ones", async () => {
		const { forge, ref, stub } = setup();
		await forge.openPullRequest(ref, draft);
		const closed = await forge.findPullRequest(ref, { ...draft, state: "closed" });
		expect(closed.ok && closed.value).toBeNull();
		const pr = stub.state.prs[0];
		if (pr !== undefined) pr.status = "abandoned";
		const found = await forge.findPullRequest(ref, { ...draft, state: "closed" });
		expect(found.ok && found.value?.number).toBe(1);
		const all = await forge.findPullRequest(ref, { ...draft, state: "all" });
		expect(all.ok && all.value?.number).toBe(1);
	});

	test("getPullRequest maps active/completed/abandoned onto the lifecycle", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		if (!opened.ok) throw new Error("unreachable");
		const pr = stub.state.prs[0];
		if (pr === undefined) throw new Error("unreachable");

		const open = await forge.getPullRequest(ref, opened.value);
		expect(open.ok && open.value).toEqual({
			lifecycle: "open",
			mergedAt: null,
			headCommit: "stub-sha-2",
			baseBranch: "main",
		});

		pr.status = "completed";
		pr.closedDate = "2026-08-29T10:00:00Z";
		const merged = await forge.getPullRequest(ref, opened.value);
		expect(merged.ok && merged.value.lifecycle).toBe("merged");
		expect(merged.ok && merged.value.mergedAt).toBe(Date.parse("2026-08-29T10:00:00Z"));

		pr.status = "abandoned";
		const abandoned = await forge.getPullRequest(ref, opened.value);
		expect(abandoned.ok && abandoned.value).toMatchObject({
			lifecycle: "closed_unmerged",
			mergedAt: null,
		});
	});

	test("setPullRequestBody patches the description", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		if (!opened.ok) throw new Error("unreachable");
		const edited = await forge.setPullRequestBody(ref, opened.value, "Rewritten.");
		expect(edited.ok).toBe(true);
		expect(stub.state.prs[0]?.description).toBe("Rewritten.");
	});

	test("openPullRequest cuts a description past the Azure DevOps limit and marks the cut", async () => {
		const { forge, ref, stub } = setup();
		const body = "x".repeat(ADO_PR_DESCRIPTION_MAX + 500);
		const opened = await forge.openPullRequest(ref, { ...draft, body });
		expect(opened.ok).toBe(true);
		const sent = stub.state.prs[0]?.description ?? "";
		expect(sent.length).toBe(ADO_PR_DESCRIPTION_MAX);
		expect(sent.startsWith("xxxx")).toBe(true);
		expect(sent).toContain("4000-character limit)");
	});

	test("fitPrDescription cuts the middle so trailing fragments survive", () => {
		const tail = "<!-- warren:preview-start -->\nhttps://p.example\n<!-- warren:preview-end -->";
		const body = "y".repeat(ADO_PR_DESCRIPTION_MAX + 500) + tail;
		const fitted = fitPrDescription(body);
		expect(fitted.length).toBeLessThanOrEqual(ADO_PR_DESCRIPTION_MAX);
		expect(fitted.startsWith("yyyy")).toBe(true);
		expect(fitted).toContain("<!-- warren:preview-start -->");
		expect(fitted).toEndWith("<!-- warren:preview-end -->");
	});

	test("setPullRequestBody applies the same description cap", async () => {
		const { forge, ref, stub } = setup();
		const opened = await forge.openPullRequest(ref, draft);
		if (!opened.ok) throw new Error("unreachable");
		const edited = await forge.setPullRequestBody(
			ref,
			opened.value,
			"y".repeat(ADO_PR_DESCRIPTION_MAX + 1),
		);
		expect(edited.ok).toBe(true);
		expect(stub.state.prs[0]?.description.length).toBe(ADO_PR_DESCRIPTION_MAX);
	});

	test("fitPrDescription leaves a body at the limit untouched", () => {
		const exact = "z".repeat(ADO_PR_DESCRIPTION_MAX);
		expect(fitPrDescription(exact)).toBe(exact);
		expect(fitPrDescription("short")).toBe("short");
	});
});

describe("AdoForge deleteBranch", () => {
	test("looks the ref up and zeroes its object id", async () => {
		const { forge, ref, stub } = setup();
		const result = await forge.deleteBranch(ref, "warren/run-1");
		expect(result.ok).toBe(true);
		expect(stub.state.refs.has("warren/run-1")).toBe(false);
		const update = stub.state.calls[1];
		expect(update?.method).toBe("POST");
		expect(update?.url).toContain("/refs?api-version=7.1");
	});

	test("a branch that is already gone is not_found", async () => {
		const { forge, ref } = setup();
		const result = await forge.deleteBranch(ref, "warren/none");
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("not_found");
	});

	test("a refused update surfaces as conflict with the update status", async () => {
		const { fetch } = recordingFetch([
			jsonResponse(200, { value: [{ name: "refs/heads/b", objectId: "abc" }] }),
			jsonResponse(200, { value: [{ success: false, updateStatus: "rejectedByPolicy" }] }),
		]);
		const forge = new AdoForge({ token: "t", fetch });
		const ref = forge.parseRepoRef(CLONE_URL) as RepoRef;
		const result = await forge.deleteBranch(ref, "b");
		expect(result.ok).toBe(false);
		if (!result.ok) {
			expect(result.error.kind).toBe("conflict");
			expect(result.error.detail).toContain("rejectedByPolicy");
		}
	});
});

describe("AdoForge error mapping", () => {
	test("transport failures cross the seam with their kind and status", async () => {
		const { fetch } = recordingFetch([
			jsonResponse(404, { message: "TF401180" }),
			jsonResponse(429, {}),
		]);
		const forge = new AdoForge({ token: "t", fetch });
		const ref = forge.parseRepoRef(CLONE_URL) as RepoRef;
		const missing = await forge.getPullRequest(ref, {
			forge: "ado",
			key: "k",
			number: 9,
			webUrl: "",
		});
		expect(missing.ok).toBe(false);
		if (!missing.ok) expect(missing.error).toMatchObject({ kind: "not_found", status: 404 });
	});

	test("a 203 sign-in page on any call is unauthorized", async () => {
		const { fetch } = recordingFetch([new Response("<html>", { status: 203 })]);
		const forge = new AdoForge({ token: "t", fetch });
		const ref = forge.parseRepoRef(CLONE_URL) as RepoRef;
		const result = await forge.findPullRequest(ref, draft);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error.kind).toBe("unauthorized");
	});

	test("botIdentity and listInstallationRepos are unsupported", async () => {
		const { forge } = setup();
		const identity = await forge.botIdentity();
		const repos = await forge.listInstallationRepos();
		expect(!identity.ok && identity.error.kind).toBe("unsupported");
		expect(!repos.ok && repos.error.kind).toBe("unsupported");
	});
});
