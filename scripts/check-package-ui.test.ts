import { describe, expect, test } from "bun:test";
import { assertUiInPackManifest } from "./check-package-ui.ts";

function manifest(paths: readonly string[]) {
	return { files: paths.map((path) => ({ path })) };
}

describe("assertUiInPackManifest", () => {
	test("passes when index.html and assets are present without UI sources", () => {
		const { problems } = assertUiInPackManifest(
			manifest([
				"package.json",
				"src/cli/main.ts",
				"src/server/config.ts",
				"src/ui/dist/index.html",
				"src/ui/dist/assets/index-AbCdEf12.js",
				"src/ui/dist/assets/index-FeDcBa34.css",
			]),
		);
		expect(problems).toEqual([]);
	});

	test("fails when the dist index is absent", () => {
		const { problems } = assertUiInPackManifest(manifest(["package.json", "src/cli/main.ts"]));
		expect(problems.some((problem) => problem.includes("src/ui/dist/index.html"))).toBe(true);
	});

	test("fails when dist ships with no hashed assets", () => {
		const { problems } = assertUiInPackManifest(manifest(["src/ui/dist/index.html"]));
		expect(problems.some((problem) => problem.includes("src/ui/dist/assets/"))).toBe(true);
	});

	test("fails when UI sources leak into the tarball", () => {
		const { problems } = assertUiInPackManifest(
			manifest([
				"src/ui/dist/index.html",
				"src/ui/dist/assets/index-AbCdEf12.js",
				"src/ui/src/api/client.ts",
			]),
		);
		expect(problems.some((problem) => problem.includes("src/ui/src/api/client.ts"))).toBe(true);
	});

	test("does not flag package-internal paths under src/ outside src/ui", () => {
		const { problems } = assertUiInPackManifest(
			manifest([
				"src/index.ts",
				"src/server/server.ts",
				"src/ui/dist/index.html",
				"src/ui/dist/assets/index-AbCdEf12.js",
			]),
		);
		expect(problems).toEqual([]);
	});
});
