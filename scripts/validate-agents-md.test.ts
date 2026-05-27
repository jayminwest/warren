import { describe, expect, test } from "bun:test";
import {
	extractBacktickedPaths,
	extractBunRunScripts,
	extractFencedBashBlocks,
	stripShellComments,
} from "./validate-agents-md.ts";

describe("validate-agents-md helpers", () => {
	test("extractFencedBashBlocks captures bash/sh/shell fences", () => {
		const md = [
			"prose",
			"```bash",
			"bun test",
			"```",
			"more prose",
			"```sh",
			"echo hi",
			"```",
			"```ts",
			"const x = 1;",
			"```",
		].join("\n");
		const blocks = extractFencedBashBlocks(md);
		expect(blocks).toHaveLength(2);
		expect(blocks[0]).toContain("bun test");
		expect(blocks[1]).toContain("echo hi");
	});

	test("stripShellComments removes inline # comments", () => {
		const stripped = stripShellComments("bun test  # this runs `bun run lint` too");
		expect(stripped).toContain("bun test");
		expect(stripped).not.toContain("bun run lint");
	});

	test("extractBunRunScripts ignores commented-out commands", () => {
		const blocks = ["bun run build:ui  # also runs `bun run build` internally"];
		const scripts = extractBunRunScripts(blocks);
		expect(scripts.has("build:ui")).toBe(true);
		expect(scripts.has("build")).toBe(false);
	});

	test("extractBunRunScripts captures colon-namespaced and hyphenated names", () => {
		const scripts = extractBunRunScripts([
			"bun run lint && bun run db:generate:sqlite && bun run validate:agents-md",
		]);
		expect(scripts.has("lint")).toBe(true);
		expect(scripts.has("db:generate:sqlite")).toBe(true);
		expect(scripts.has("validate:agents-md")).toBe(true);
	});

	test("extractBacktickedPaths skips non-path tokens", () => {
		const md =
			"see `src/server/types.ts` and `package.json`, npm pkg `@os-eco/burrow`, " +
			"placeholder `src/runs/...`, URL `https://example.com/foo.md`, " +
			"bare ext `.ts`, glob `src/**/*.ts`, code `foo()`, external `../burrow/SPEC.md`";
		const paths = extractBacktickedPaths(md);
		expect(paths).toContain("src/server/types.ts");
		expect(paths).toContain("package.json");
		expect(paths).not.toContain("@os-eco/burrow");
		expect(paths.some((p) => p.endsWith("..."))).toBe(false);
		expect(paths.some((p) => p.startsWith("http"))).toBe(false);
		expect(paths).not.toContain(".ts");
		expect(paths.some((p) => p.includes("*"))).toBe(false);
		expect(paths.some((p) => p.includes("("))).toBe(false);
	});
});
