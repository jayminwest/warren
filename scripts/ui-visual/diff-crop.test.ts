import { describe, expect, test } from "bun:test";

import {
	composeFailure,
	crop,
	cropBox,
	diffMarkerBox,
	downscale,
	pairDiffBox,
	sideBySide,
} from "./diff-crop.ts";
import { createImage, type RgbaImage } from "./png.ts";

const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [255, 0, 0, 255];

function paint(img: RgbaImage, x: number, y: number, rgba: readonly number[]): void {
	img.data.set(rgba, (y * img.width + x) * 4);
}

function pixel(img: RgbaImage, x: number, y: number): number[] {
	const i = (y * img.width + x) * 4;
	return Array.from(img.data.subarray(i, i + 4));
}

describe("diffMarkerBox", () => {
	test("bounds and counts only pure red pixels", () => {
		const diff = createImage(100, 80, [200, 200, 200, 255]);
		paint(diff, 10, 20, RED);
		paint(diff, 30, 25, RED);
		paint(diff, 90, 70, [255, 255, 0, 255]); // anti-aliasing (yellow) is not counted
		paint(diff, 5, 5, [254, 0, 0, 255]);
		expect(diffMarkerBox(diff)).toEqual({ box: { x: 10, y: 20, width: 21, height: 6 }, count: 2 });
	});

	test("returns no box for a diff with no red", () => {
		expect(diffMarkerBox(createImage(4, 4, WHITE))).toEqual({ box: null, count: 0 });
	});
});

describe("pairDiffBox", () => {
	test("finds changed pixels above the tolerance", () => {
		const a = createImage(20, 20, WHITE);
		const b = createImage(20, 20, WHITE);
		paint(b, 3, 4, [0, 0, 0, 255]);
		paint(b, 15, 6, [250, 250, 250, 255]); // within tolerance
		expect(pairDiffBox(a, b)).toEqual({ x: 3, y: 4, width: 1, height: 1 });
	});

	test("counts area only one image covers as changed", () => {
		expect(pairDiffBox(createImage(10, 10, WHITE), createImage(10, 12, WHITE))).toEqual({
			x: 0,
			y: 10,
			width: 10,
			height: 2,
		});
	});
});

describe("cropBox", () => {
	test("pads, clamps to the canvas, and caps the height", () => {
		const canvas = { width: 100, height: 1000 };
		expect(
			cropBox({ x: 5, y: 10, width: 10, height: 10 }, canvas, { pad: 8, maxHeight: 500 }),
		).toEqual({
			box: { x: 0, y: 2, width: 23, height: 26 },
			truncated: false,
		});
		expect(
			cropBox({ x: 50, y: 100, width: 60, height: 800 }, canvas, { pad: 8, maxHeight: 500 }),
		).toEqual({
			box: { x: 42, y: 92, width: 58, height: 500 },
			truncated: true,
		});
	});
});

describe("crop / sideBySide / downscale", () => {
	test("crop fills outside the source with the fill colour", () => {
		const img = createImage(4, 4, WHITE);
		const out = crop(img, { x: 2, y: 2, width: 4, height: 4 }, [1, 2, 3, 4]);
		expect(pixel(out, 0, 0)).toEqual(WHITE);
		expect(pixel(out, 3, 3)).toEqual([1, 2, 3, 4]);
	});

	test("sideBySide lays panels out with a gap", () => {
		const out = sideBySide([createImage(3, 2, WHITE), createImage(2, 4, RED)], 1);
		expect([out.width, out.height]).toEqual([6, 4]);
		expect(pixel(out, 0, 0)).toEqual(WHITE);
		expect(pixel(out, 4, 3)).toEqual(RED);
		expect(pixel(out, 3, 0)).toEqual([128, 128, 128, 255]);
	});

	test("downscale averages each block", () => {
		const img = createImage(4, 2, WHITE);
		paint(img, 0, 0, [0, 0, 0, 255]);
		paint(img, 1, 1, [0, 0, 0, 255]);
		const out = downscale(img, 2);
		expect([out.width, out.height]).toEqual([2, 1]);
		expect(pixel(out, 0, 0)).toEqual([128, 128, 128, 255]);
		expect(pixel(out, 1, 0)).toEqual(WHITE);
		expect(downscale(img, 1)).toBe(img);
	});
});

describe("composeFailure", () => {
	test("crops all three panels to the red region and reports the count", () => {
		const expected = createImage(200, 300, WHITE);
		const actual = createImage(200, 300, WHITE);
		const diff = createImage(200, 300, [240, 240, 240, 255]);
		for (let x = 50; x < 60; x++) paint(diff, x, 100, RED);
		const c = composeFailure(
			{ expected, actual, diff },
			{ pad: 4, maxHeight: 900, maxWidth: 2400, gap: 2 },
		);
		expect(c?.box).toEqual({ x: 46, y: 96, width: 18, height: 9 });
		expect(c?.diffPixels).toBe(10);
		expect([c?.image.width, c?.image.height]).toEqual([18 * 3 + 4, 9]);
		expect(c?.scale).toBe(1);
	});

	test("downscales wide composites by a whole factor", () => {
		const page = createImage(1440, 100, WHITE);
		const diff = createImage(1440, 100, WHITE);
		paint(diff, 0, 0, RED);
		paint(diff, 1439, 99, RED);
		const c = composeFailure({ expected: page, actual: page, diff });
		expect(c?.scale).toBe(2);
		expect(c?.image.width).toBe(Math.ceil((1440 * 3 + 24) / 2));
	});

	test("falls back to the whole actual image when there is no baseline", () => {
		const c = composeFailure({ actual: createImage(30, 40, WHITE) });
		expect(c?.box).toEqual({ x: 0, y: 0, width: 30, height: 40 });
		expect(c?.diffPixels).toBeNull();
	});

	test("returns null with no images or no changed pixels", () => {
		expect(composeFailure({})).toBeNull();
		const same = createImage(5, 5, WHITE);
		expect(
			composeFailure({ expected: same, actual: same, diff: createImage(5, 5, WHITE) }),
		).toBeNull();
	});
});
