import { describe, expect, test } from "bun:test";

import {
	diffKind,
	expectedGoldenFiles,
	GOLDEN_ENV,
	goldenGate,
	isGoldenPair,
	MAX_GOLDEN_BYTES,
} from "./golden-cases.ts";
import { PAGES, type PageSpec } from "./pages.ts";

const at = (path: string) => (): string => path;

describe("isGoldenPair", () => {
	test("drops only phone x dark", () => {
		expect(isGoldenPair("desktop", "light")).toBe(true);
		expect(isGoldenPair("desktop", "dark")).toBe(true);
		expect(isGoldenPair("phone", "light")).toBe(true);
		expect(isGoldenPair("phone", "dark")).toBe(false);
	});
});

describe("expectedGoldenFiles", () => {
	test("names three PNGs per page, sorted", () => {
		const pages: PageSpec[] = [
			{ id: "runs", route: "/runs", path: at("/runs") },
			{ id: "agents", route: "/agents", path: at("/agents") },
		];
		expect(expectedGoldenFiles(pages)).toEqual([
			"agents.desktop.dark.png",
			"agents.desktop.light.png",
			"agents.phone.light.png",
			"runs.desktop.dark.png",
			"runs.desktop.light.png",
			"runs.phone.light.png",
		]);
	});

	test("covers every manifest page by default", () => {
		expect(expectedGoldenFiles()).toHaveLength(PAGES.length * 3);
	});

	test("holds an 8 MB budget", () => {
		expect(MAX_GOLDEN_BYTES).toBe(8 * 1024 * 1024);
	});
});

describe("goldenGate", () => {
	test("runs on linux/x64 with the workflow's env flag", () => {
		expect(goldenGate({ [GOLDEN_ENV]: "1" }, "linux", "x64")).toEqual({ enabled: true });
	});

	test("skips on a macOS laptop even with the flag set", () => {
		const gate = goldenGate({ [GOLDEN_ENV]: "1" }, "darwin", "arm64");
		expect(gate.enabled).toBe(false);
		if (!gate.enabled) {
			expect(gate.reason).toContain("darwin/arm64");
			expect(gate.reason).toContain("update_goldens=true");
		}
	});

	test("skips on the arm64 variant of the image", () => {
		expect(goldenGate({ [GOLDEN_ENV]: "1" }, "linux", "arm64").enabled).toBe(false);
	});

	test("skips on linux/x64 without the flag", () => {
		const gate = goldenGate({}, "linux", "x64");
		expect(gate.enabled).toBe(false);
		if (!gate.enabled) expect(gate.reason).toContain(`${GOLDEN_ENV} is not 1`);
	});
});

describe("diffKind", () => {
	test("maps Playwright snapshot attachment names", () => {
		expect(diffKind("runs.desktop.light-expected.png")).toBe("expected");
		expect(diffKind("runs.desktop.light-actual.png")).toBe("actual");
		expect(diffKind("runs.desktop.light-diff.png")).toBe("diff");
	});

	test("ignores everything else", () => {
		expect(diffKind("runs.desktop.light-previous.png")).toBeNull();
		expect(diffKind("trace")).toBeNull();
		expect(diffKind("runs.desktop.light.png")).toBeNull();
	});
});
