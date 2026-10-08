import { describe, expect, test } from "bun:test";

import {
	commentAction,
	cropNote,
	failureComment,
	formatRatio,
	type GoldenFailure,
	noDiffFailureComment,
	parseGoldenResult,
	pickFailures,
	reportedPixels,
	resolvedComment,
	sizeChange,
	UI_VISUAL_MARKER,
} from "./diff-comment.ts";

const RESULT = {
	case: "runs.desktop.light",
	page: "runs",
	viewport: "desktop",
	theme: "light",
	url: "/runs",
	golden: "scripts/ui-visual/__golden__/runs-desktop-light.png",
	images: ["actual.png", "diff.png", "expected.png"],
	error:
		"Error: expect(page).toHaveScreenshot(expected) failed\n\n  12960 pixels (ratio 0.01 of all image pixels) are different.",
};

const RUN = {
	headSha: "0123456789abcdef0123456789abcdef01234567",
	runUrl: "https://example.test/run/9",
};

function failure(name: string): GoldenFailure {
	const [page = "", viewport = "", theme = ""] = name.split(".");
	return { name, page, viewport, theme, images: [], reportedPixels: null, sizeChange: null };
}

describe("parseGoldenResult", () => {
	test("reads what golden.pw.ts writes", () => {
		expect(parseGoldenResult(RESULT)).toEqual({
			name: "runs.desktop.light",
			page: "runs",
			viewport: "desktop",
			theme: "light",
			images: ["expected", "actual", "diff"],
			reportedPixels: 12960,
			sizeChange: null,
		});
	});

	test("rejects shapes the spec never writes", () => {
		expect(parseGoldenResult(null)).toBeNull();
		expect(parseGoldenResult([])).toBeNull();
		expect(parseGoldenResult({ ...RESULT, viewport: "tablet" })).toBeNull();
		expect(parseGoldenResult({ ...RESULT, theme: "sepia" })).toBeNull();
		expect(parseGoldenResult({ ...RESULT, page: "Runs<img>" })).toBeNull();
		expect(parseGoldenResult({ ...RESULT, case: "agents.desktop.light" })).toBeNull();
	});

	test("ignores image names it does not know", () => {
		expect(parseGoldenResult({ ...RESULT, images: ["actual.png", "../x.png"] })?.images).toEqual([
			"actual",
		]);
	});
});

describe("message parsing", () => {
	test("reads Playwright's pixel count and size change", () => {
		expect(reportedPixels(RESULT.error)).toBe(12960);
		expect(reportedPixels("Timeout 20000ms exceeded")).toBeNull();
		const msg = "Expected an image 1440px by 900px, received 1440px by 950px. 4 pixels (ratio 0.01";
		expect(sizeChange(msg)).toEqual(["1440x900", "1440x950"]);
		expect(sizeChange(RESULT.error)).toBeNull();
	});

	test("formats ratios as percentages", () => {
		expect(formatRatio(0.0123)).toBe("1.23%");
		expect(formatRatio(0.00001)).toBe("<0.01%");
		expect(formatRatio(0)).toBe("0.00%");
		expect(formatRatio(null)).toBe("n/a");
	});
});

describe("pickFailures", () => {
	test("keeps the biggest changes, unknown ratios first, and counts the rest", () => {
		const rows = [
			{ failure: failure("a.desktop.light"), ratio: 0.01 },
			{ failure: failure("b.desktop.light"), ratio: 0.2 },
			{ failure: failure("c.desktop.light"), ratio: null },
			{ failure: failure("d.desktop.light"), ratio: 0.05 },
		];
		const { shown, hidden } = pickFailures(rows, 3);
		expect(shown.map((r) => r.failure.page)).toEqual(["c", "b", "d"]);
		expect(hidden).toBe(1);
	});
});

describe("comment bodies", () => {
	test("failure comment starts with the marker and lists every shown case", () => {
		const body = failureComment(
			RUN,
			[
				{
					failure: { ...failure("runs.desktop.light"), sizeChange: ["1440x900", "1440x950"] },
					ratio: 0.0123,
					imageUrl: "https://raw.example.test/x.png",
					note: "Crop of 10x10 px at (0, 0).",
				},
				{
					failure: failure("agents.phone.light"),
					ratio: null,
					imageUrl: null,
					note: "No image to crop.",
				},
			],
			2,
		);
		expect(body.startsWith(`${UI_VISUAL_MARKER}\n`)).toBe(true);
		expect(body).toContain("### ui-visual: 4 golden screenshots differ");
		expect(body).toContain("`0123456`");
		expect(body).toContain(
			"| `runs` | desktop | light | 1.23%, size 1440x900 → 1440x950 | [image](https://raw.example.test/x.png) |",
		);
		expect(body).toContain("| `agents` | phone | light | n/a | artifact |");
		expect(body).toContain("![runs.desktop.light](https://raw.example.test/x.png)");
		expect(body).toContain("…and 2 more failing cases, only in the artifact.");
		expect(body).toContain("update_goldens=true");
	});

	test("resolved and no-diff bodies keep the marker", () => {
		expect(resolvedComment(RUN).startsWith(UI_VISUAL_MARKER)).toBe(true);
		expect(resolvedComment(RUN)).toContain("golden screenshots match");
		expect(noDiffFailureComment(RUN).startsWith(UI_VISUAL_MARKER)).toBe(true);
	});

	test("crop notes mention truncation and scale only when they apply", () => {
		const box = { x: 1, y: 2, width: 3, height: 4 };
		expect(cropNote({ box, truncated: false, scale: 1 })).toBe("Crop of 3x4 px at (1, 2).");
		expect(cropNote({ box, truncated: true, scale: 2 })).toBe(
			"Crop of 3x4 px at (1, 2); the changed region continues below; shown at 1/2 scale.",
		);
	});
});

describe("commentAction", () => {
	test("posts failures, and edits an existing comment once clean", () => {
		expect(commentAction({ conclusion: "failure", failures: 2, hasComment: false })).toBe(
			"post-failures",
		);
		expect(commentAction({ conclusion: "success", failures: 0, hasComment: false })).toBe("none");
		expect(commentAction({ conclusion: "success", failures: 0, hasComment: true })).toBe("resolve");
		expect(commentAction({ conclusion: "failure", failures: 0, hasComment: true })).toBe(
			"note-no-diff",
		);
		expect(commentAction({ conclusion: "failure", failures: 0, hasComment: false })).toBe("none");
	});
});
