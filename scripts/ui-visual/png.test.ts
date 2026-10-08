import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

import { createImage, decodePng, encodePng, pngSize } from "./png.ts";

/** Build a PNG by hand so the decoder sees formats `encodePng` never writes. */
function handPng(opts: {
	width: number;
	height: number;
	colorType: number;
	rows: number[][];
	filter: number;
	extra?: { type: string; body: number[] }[];
	interlace?: number;
}): Uint8Array {
	const chunk = (type: string, body: Uint8Array) => {
		const out = Buffer.alloc(12 + body.length);
		out.writeUInt32BE(body.length, 0);
		out.write(type, 4, "ascii");
		Buffer.from(body).copy(out, 8);
		return out; // CRC left zero: the decoder does not verify it.
	};
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(opts.width, 0);
	ihdr.writeUInt32BE(opts.height, 4);
	ihdr.set([8, opts.colorType, 0, 0, opts.interlace ?? 0], 8);
	const raw = opts.rows.flatMap((row) => [opts.filter, ...row]);
	return new Uint8Array(
		Buffer.concat([
			Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
			chunk("IHDR", ihdr),
			...(opts.extra ?? []).map((c) => chunk(c.type, Uint8Array.from(c.body))),
			chunk("IDAT", deflateSync(Uint8Array.from(raw))),
			chunk("IEND", new Uint8Array()),
		]),
	);
}

function pixel(img: { width: number; data: Uint8Array }, x: number, y: number): number[] {
	const i = (y * img.width + x) * 4;
	return Array.from(img.data.subarray(i, i + 4));
}

describe("encodePng / decodePng", () => {
	test("round-trips an RGBA image byte for byte", () => {
		const img = createImage(7, 5, [10, 20, 30, 255]);
		for (let i = 0; i < img.data.length; i++) img.data[i] = (i * 37) % 256;
		const back = decodePng(encodePng(img));
		expect(back.width).toBe(7);
		expect(back.height).toBe(5);
		expect(Array.from(back.data)).toEqual(Array.from(img.data));
	});

	test("expands RGB, grey, grey+alpha, and palette images to RGBA", () => {
		const rgb = decodePng(
			handPng({ width: 2, height: 1, colorType: 2, filter: 0, rows: [[1, 2, 3, 4, 5, 6]] }),
		);
		expect(pixel(rgb, 1, 0)).toEqual([4, 5, 6, 255]);
		const grey = decodePng(handPng({ width: 1, height: 1, colorType: 0, filter: 0, rows: [[90]] }));
		expect(pixel(grey, 0, 0)).toEqual([90, 90, 90, 255]);
		const ga = decodePng(
			handPng({ width: 1, height: 1, colorType: 4, filter: 0, rows: [[90, 7]] }),
		);
		expect(pixel(ga, 0, 0)).toEqual([90, 90, 90, 7]);
		const pal = decodePng(
			handPng({
				width: 2,
				height: 1,
				colorType: 3,
				filter: 0,
				rows: [[1, 0]],
				extra: [
					{ type: "PLTE", body: [9, 9, 9, 200, 100, 50] },
					{ type: "tRNS", body: [0] },
				],
			}),
		);
		expect(pixel(pal, 0, 0)).toEqual([200, 100, 50, 255]);
		expect(pixel(pal, 1, 0)).toEqual([9, 9, 9, 0]);
	});

	test("reverses every filter type", () => {
		// Grey 2x2 rows [10, 20] / [30, 40], each filtered by hand.
		const cases: [number, number[][]][] = [
			[
				1,
				[
					[10, 10],
					[30, 10],
				],
			], // Sub
			[
				2,
				[
					[10, 20],
					[20, 20],
				],
			], // Up
			[
				3,
				[
					[10, 15],
					[25, 15],
				],
			], // Average: 20-(10>>1), 30-(10>>1), 40-((30+20)>>1)
			[
				4,
				[
					[10, 10],
					[20, 10],
				],
			], // Paeth: row 1 predicts 10, then 30
		];
		for (const [filter, rows] of cases) {
			const img = decodePng(handPng({ width: 2, height: 2, colorType: 0, filter, rows }));
			expect([
				pixel(img, 0, 0)[0],
				pixel(img, 1, 0)[0],
				pixel(img, 0, 1)[0],
				pixel(img, 1, 1)[0],
			]).toEqual([10, 20, 30, 40]);
		}
	});

	test("decodes a committed golden (Chromium writes 8-bit RGB)", () => {
		const bytes = new Uint8Array(
			readFileSync(join(import.meta.dir, "__golden__", "agents-phone-light.png")),
		);
		const img = decodePng(bytes);
		expect(pngSize(bytes)).toEqual({ width: 393, height: 852 });
		expect(img.data.length).toBe(393 * 852 * 4);
		expect(pixel(img, 0, 0)[3]).toBe(255);
	});

	test("rejects malformed and unsupported input", () => {
		expect(() => decodePng(new Uint8Array([1, 2, 3]))).toThrow(/signature/);
		const interlaced = handPng({
			width: 1,
			height: 1,
			colorType: 0,
			filter: 0,
			rows: [[0]],
			interlace: 1,
		});
		expect(() => decodePng(interlaced)).toThrow(/interlaced/);
		const huge = handPng({ width: 100_000, height: 100_000, colorType: 6, filter: 0, rows: [] });
		expect(() => decodePng(huge)).toThrow(/out of range/);
		const short = handPng({ width: 4, height: 4, colorType: 0, filter: 0, rows: [[1, 2, 3, 4]] });
		expect(() => decodePng(short)).toThrow(/truncated/);
	});
});
