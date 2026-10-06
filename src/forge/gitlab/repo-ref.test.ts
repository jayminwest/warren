import { describe, expect, test } from "bun:test";
import {
	gitLabRepoLayout,
	parseGitLabCoordinate,
	parseGitLabInstance,
	parseGitLabRepoRef,
	unpackGitLabRef,
} from "./repo-ref.ts";
import { gitLabDotCom } from "./test-helpers.ts";

function instance(url: string) {
	const parsed = parseGitLabInstance(url);
	if (parsed === null) throw new Error(`fixture instance must parse: ${url}`);
	return parsed;
}

describe("parseGitLabInstance", () => {
	test("keeps the port and a relative URL root, lowercases the host", () => {
		expect(parseGitLabInstance("https://GitLab.Example.com:8443/gitlab/")).toEqual({
			origin: "https://gitlab.example.com:8443",
			host: "gitlab.example.com:8443",
			hostname: "gitlab.example.com",
			basePath: "/gitlab",
		});
		expect(parseGitLabInstance("https://gitlab.com")?.basePath).toBe("");
	});

	test("rejects what cannot name an instance", () => {
		for (const raw of [
			"",
			"gitlab.com",
			"ssh://git@gitlab.com",
			"https://user:pw@gitlab.com",
			"https://gitlab.com/?x=1",
			"https://gitlab.com/#top",
		]) {
			expect(parseGitLabInstance(raw)).toBeNull();
		}
	});
});

describe("parseGitLabRepoRef", () => {
	test("packs host and full project path for every accepted grammar", () => {
		const urls = [
			"https://gitlab.com/acme/platform/widget",
			"https://gitlab.com/acme/platform/widget.git",
			"https://gitlab.com/acme/platform/widget/",
			"http://gitlab.com/acme/platform/widget.git",
			"git@gitlab.com:acme/platform/widget.git",
			"ssh://git@gitlab.com/acme/platform/widget.git",
			"ssh://git@gitlab.com:2222/acme/platform/widget.git",
			"https://gitlab.com/acme/platform/widget/-/merge_requests/12",
			"https://gitlab.com/acme/platform/widget/-/tree/main/src",
			"  https://GITLAB.com/acme/platform/widget  ",
		];
		for (const url of urls) {
			expect(parseGitLabRepoRef(gitLabDotCom(), url)).toEqual({
				forge: "gitlab",
				key: "gitlab.com/acme/platform/widget",
			});
		}
	});

	test("unpacks the key back to the project path the API addresses", () => {
		const ref = parseGitLabRepoRef(gitLabDotCom(), "git@gitlab.com:a/b/c/d.git");
		if (ref === null) throw new Error("unreachable");
		expect(unpackGitLabRef(ref)).toBe("a/b/c/d");
	});

	test("owns only the configured host, its port and its URL root", () => {
		const selfHosted = instance("https://git.example.com:8443/gitlab");
		expect(
			parseGitLabRepoRef(selfHosted, "https://git.example.com:8443/gitlab/team/app.git")?.key,
		).toBe("git.example.com:8443/team/app");
		// ssh paths never carry the relative URL root, and ssh has its own port.
		expect(parseGitLabRepoRef(selfHosted, "git@git.example.com:team/app.git")?.key).toBe(
			"git.example.com:8443/team/app",
		);
		for (const foreign of [
			"https://git.example.com/gitlab/team/app.git",
			"https://git.example.com:8443/team/app.git",
			"https://gitlab.com/team/app.git",
			"git@gitlab.com:team/app.git",
		]) {
			expect(parseGitLabRepoRef(selfHosted, foreign)).toBeNull();
		}
	});

	test("returns null for foreign hosts and malformed paths", () => {
		const foreign = [
			"https://github.com/o/r.git",
			"git@github.com:o/r.git",
			"fake://projects/widget",
			"https://gitlab.com/onlyone",
			"https://gitlab.com/-/merge_requests/1",
			"https://gitlab.com/acme/../widget",
			"https://gitlab.com/acme/-widget",
			"https://gitlab.com/acme/wid%20get",
			"https://gitlab.com/acme/widget?private_token=x",
			"ftp://gitlab.com/acme/widget",
			"not a url",
			"",
		];
		for (const url of foreign) {
			expect(parseGitLabRepoRef(gitLabDotCom(), url)).toBeNull();
		}
	});
});

describe("gitLabRepoLayout", () => {
	test("folds every group into the owner segment", () => {
		expect(gitLabRepoLayout(gitLabDotCom(), "https://gitlab.com/acme/widget.git")).toEqual({
			owner: "acme",
			name: "widget",
		});
		expect(gitLabRepoLayout(gitLabDotCom(), "https://gitlab.com/acme/platform/widget")).toEqual({
			owner: "acme-platform",
			name: "widget",
		});
	});

	test("keeps same-named projects in different namespaces apart", () => {
		const layouts = [
			"https://gitlab.com/a/sub/app",
			"https://gitlab.com/b/sub/app",
			"https://gitlab.com/a-sub/app",
			"https://gitlab.com/a/sub-app/app",
		].map((url) => {
			const layout = gitLabRepoLayout(gitLabDotCom(), url);
			return `${layout?.owner}/${layout?.name}`;
		});
		expect(new Set(layouts).size).toBe(layouts.length);
		expect(layouts).toEqual(["a-sub/app", "b-sub/app", "a--sub/app", "a-sub--app/app"]);
	});

	test("returns null for a URL the instance does not own", () => {
		expect(gitLabRepoLayout(gitLabDotCom(), "https://github.com/o/r")).toBeNull();
		expect(parseGitLabCoordinate(gitLabDotCom(), "https://gitlab.com/o")).toBeNull();
	});
});
