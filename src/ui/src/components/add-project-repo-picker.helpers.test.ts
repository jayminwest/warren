import { describe, expect, test } from "bun:test";
import type { ForgeRepoRow } from "@/api/client.ts";
import {
	filterRepos,
	REPO_PICKER_LIMIT,
	repoLabel,
	repoPickerMode,
} from "./add-project-repo-picker.helpers.ts";

function repo(over: Partial<ForgeRepoRow> = {}): ForgeRepoRow {
	return {
		owner: "octo",
		name: "widget",
		cloneUrl: "https://github.com/octo/widget.git",
		defaultBranch: "main",
		private: false,
		...over,
	};
}

describe("repoPickerMode", () => {
	test("returns picker for a supported listing with repositories", () => {
		expect(repoPickerMode({ supported: true, repos: [repo()] })).toBe("picker");
	});

	test("returns paste-only while the query is in flight or errored", () => {
		expect(repoPickerMode(undefined)).toBe("paste-only");
	});

	test("returns paste-only for PAT / no-forge mode (supported: false)", () => {
		expect(repoPickerMode({ supported: false, repos: [] })).toBe("paste-only");
	});

	test("returns paste-only when a supported listing comes back empty", () => {
		expect(repoPickerMode({ supported: true, repos: [] })).toBe("paste-only");
	});
});

describe("filterRepos", () => {
	test("passes everything through on a blank query, capped at the limit", () => {
		const many = Array.from({ length: REPO_PICKER_LIMIT + 20 }, (_, i) =>
			repo({ owner: "octo", name: `r${i}` }),
		);
		expect(filterRepos(many, "  ")).toHaveLength(REPO_PICKER_LIMIT);
	});

	test("matches owner/name case-insensitively on either segment", () => {
		const rows = [repo(), repo({ owner: "acme", name: "gadgets", private: true })];
		expect(filterRepos(rows, "ACME")).toEqual([rows[1]]);
		expect(filterRepos(rows, "widget")).toEqual([rows[0]]);
		expect(filterRepos(rows, "acme/gad")).toEqual([rows[1]]);
		expect(filterRepos(rows, "nope")).toEqual([]);
	});
});

describe("repoLabel", () => {
	test("marks private repositories", () => {
		expect(repoLabel(repo())).toBe("octo/widget");
		expect(repoLabel(repo({ private: true }))).toBe("octo/widget · private");
	});
});
