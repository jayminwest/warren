/**
 * Crop a failed golden case down to what changed (warren-70d9).
 *
 * Playwright's `diff.png` is the pixelmatch output: every pixel it counted
 * as different is pure red (255, 0, 0), anti-aliasing is yellow, and the rest
 * is a faded greyscale copy. So the red pixels are exactly the failing set:
 * their bounding box is the crop, and their count is the diff pixel ratio.
 * Without a diff image (a missing baseline) the crop compares expected and
 * actual directly.
 *
 * The composite puts expected | actual | diff side by side, padded, height
 * capped, and downscaled by a whole factor so a 1440px page stays legible.
 * Pure: RGBA in, RGBA out (see `png.ts`).
 */

import { createImage, type RgbaImage } from "./png.ts";

export interface Box {
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
}

export interface CropOptions {
	/** Context kept around the changed region, in source pixels. */
	readonly pad: number;
	/** Source rows kept at most; a taller region keeps its top. */
	readonly maxHeight: number;
	/** Composite width before the whole-factor downscale kicks in. */
	readonly maxWidth: number;
	/** Gap between panels, in source pixels. */
	readonly gap: number;
}

export const DEFAULT_CROP: CropOptions = { pad: 24, maxHeight: 900, maxWidth: 2400, gap: 12 };

/** Gap and out-of-bounds fill: a mid grey that reads in both themes. */
const BACKGROUND: [number, number, number, number] = [128, 128, 128, 255];

class BoxBuilder {
	private minX = Number.POSITIVE_INFINITY;
	private minY = Number.POSITIVE_INFINITY;
	private maxX = -1;
	private maxY = -1;
	count = 0;

	add(x: number, y: number): void {
		this.count++;
		if (x < this.minX) this.minX = x;
		if (y < this.minY) this.minY = y;
		if (x > this.maxX) this.maxX = x;
		if (y > this.maxY) this.maxY = y;
	}

	box(): Box | null {
		if (this.count === 0) return null;
		return {
			x: this.minX,
			y: this.minY,
			width: this.maxX - this.minX + 1,
			height: this.maxY - this.minY + 1,
		};
	}
}

/** The pixelmatch "different" colour. */
function isDiffPixel(data: Uint8Array, i: number): boolean {
	return data[i] === 255 && data[i + 1] === 0 && data[i + 2] === 0;
}

/** Bounding box and count of the red pixels in a Playwright diff image. */
export function diffMarkerBox(diff: RgbaImage): { box: Box | null; count: number } {
	const builder = new BoxBuilder();
	for (let y = 0; y < diff.height; y++) {
		for (let x = 0; x < diff.width; x++) {
			if (isDiffPixel(diff.data, (y * diff.width + x) * 4)) builder.add(x, y);
		}
	}
	return { box: builder.box(), count: builder.count };
}

function pixelsDiffer(a: RgbaImage, b: RgbaImage, x: number, y: number, tolerance: number) {
	if (x >= a.width || y >= a.height || x >= b.width || y >= b.height) return true;
	const ia = (y * a.width + x) * 4;
	const ib = (y * b.width + x) * 4;
	for (let c = 0; c < 4; c++) {
		if (Math.abs((a.data[ia + c] ?? 0) - (b.data[ib + c] ?? 0)) > tolerance) return true;
	}
	return false;
}

/**
 * Bounding box of the pixels that differ between two images by more than
 * `tolerance` in any channel. Where the sizes differ, the area only one
 * image covers counts as changed.
 */
export function pairDiffBox(a: RgbaImage, b: RgbaImage, tolerance = 16): Box | null {
	const builder = new BoxBuilder();
	const width = Math.max(a.width, b.width);
	const height = Math.max(a.height, b.height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			if (pixelsDiffer(a, b, x, y, tolerance)) builder.add(x, y);
		}
	}
	return builder.box();
}

/** Pad a box, clamp it to the canvas, and keep at most `maxHeight` rows. */
export function cropBox(
	box: Box,
	canvas: { width: number; height: number },
	options: Pick<CropOptions, "pad" | "maxHeight">,
): { box: Box; truncated: boolean } {
	const x = Math.max(0, box.x - options.pad);
	const y = Math.max(0, box.y - options.pad);
	const right = Math.min(canvas.width, box.x + box.width + options.pad);
	const bottom = Math.min(canvas.height, box.y + box.height + options.pad);
	const height = Math.min(bottom - y, options.maxHeight);
	return { box: { x, y, width: right - x, height }, truncated: bottom - y > options.maxHeight };
}

/** Copy `box` out of an image; anything outside the image is `fill`. */
export function crop(image: RgbaImage, box: Box, fill = BACKGROUND): RgbaImage {
	const out = createImage(box.width, box.height, fill);
	for (let row = 0; row < box.height; row++) {
		const y = box.y + row;
		if (y < 0 || y >= image.height) continue;
		const x0 = Math.max(0, box.x);
		const x1 = Math.min(image.width, box.x + box.width);
		if (x1 <= x0) continue;
		const src = image.data.subarray((y * image.width + x0) * 4, (y * image.width + x1) * 4);
		out.data.set(src, (row * box.width + (x0 - box.x)) * 4);
	}
	return out;
}

/** Lay images out left to right, top-aligned, `gap` pixels apart. */
export function sideBySide(images: readonly RgbaImage[], gap: number): RgbaImage {
	const width = images.reduce((sum, img) => sum + img.width, 0) + gap * (images.length - 1);
	const height = Math.max(...images.map((img) => img.height));
	const out = createImage(width, height, BACKGROUND);
	let left = 0;
	for (const img of images) {
		for (let y = 0; y < img.height; y++) {
			const src = img.data.subarray(y * img.width * 4, (y + 1) * img.width * 4);
			out.data.set(src, (y * width + left) * 4);
		}
		left += img.width + gap;
	}
	return out;
}

/** Mean RGBA of the `factor` x `factor` block at (x0, y0), clipped to the image. */
function blockMean(image: RgbaImage, x0: number, y0: number, factor: number): number[] {
	const sum = [0, 0, 0, 0];
	const x1 = Math.min(image.width, x0 + factor);
	const y1 = Math.min(image.height, y0 + factor);
	for (let y = y0; y < y1; y++) {
		for (let x = x0; x < x1; x++) {
			const i = (y * image.width + x) * 4;
			for (let c = 0; c < 4; c++) sum[c] = (sum[c] ?? 0) + (image.data[i + c] ?? 0);
		}
	}
	const n = (x1 - x0) * (y1 - y0);
	return sum.map((s) => Math.round(s / n));
}

/** Shrink by a whole factor, averaging each `factor` x `factor` block. */
export function downscale(image: RgbaImage, factor: number): RgbaImage {
	if (factor <= 1) return image;
	const width = Math.ceil(image.width / factor);
	const height = Math.ceil(image.height / factor);
	const out = createImage(width, height);
	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			out.data.set(blockMean(image, x * factor, y * factor, factor), (y * width + x) * 4);
		}
	}
	return out;
}

export interface FailureImages {
	readonly expected?: RgbaImage;
	readonly actual?: RgbaImage;
	readonly diff?: RgbaImage;
}

export interface Composite {
	readonly image: RgbaImage;
	/** The crop in page pixels. */
	readonly box: Box;
	/** The changed region was taller than `maxHeight`; only its top is shown. */
	readonly truncated: boolean;
	/** Pixels pixelmatch counted as different, or null without a diff image. */
	readonly diffPixels: number | null;
	readonly scale: number;
}

function changedRegion(images: FailureImages): { box: Box | null; count: number | null } {
	if (images.diff !== undefined) return diffMarkerBox(images.diff);
	if (images.expected !== undefined && images.actual !== undefined) {
		return { box: pairDiffBox(images.expected, images.actual), count: null };
	}
	const only = images.actual ?? images.expected;
	if (only === undefined) return { box: null, count: null };
	return { box: { x: 0, y: 0, width: only.width, height: only.height }, count: null };
}

/**
 * One side-by-side PNG for a failed case, in expected | actual | diff order
 * (whichever exist), cropped to the changed region. Null when there is
 * nothing to show.
 */
export function composeFailure(
	images: FailureImages,
	options: CropOptions = DEFAULT_CROP,
): Composite | null {
	const panels = [images.expected, images.actual, images.diff].filter(
		(img): img is RgbaImage => img !== undefined,
	);
	const region = changedRegion(images);
	if (panels.length === 0 || region.box === null) return null;
	const canvas = {
		width: Math.max(...panels.map((p) => p.width)),
		height: Math.max(...panels.map((p) => p.height)),
	};
	const { box, truncated } = cropBox(region.box, canvas, options);
	const joined = sideBySide(
		panels.map((p) => crop(p, box)),
		options.gap,
	);
	const scale = Math.max(1, Math.ceil(joined.width / options.maxWidth));
	return { image: downscale(joined, scale), box, truncated, diffPixels: region.count, scale };
}
