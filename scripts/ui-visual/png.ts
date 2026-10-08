/**
 * A small PNG codec for the ui-visual PR comment (warren-70d9).
 *
 * The comment job crops Playwright's expected/actual/diff screenshots, so it
 * has to read and write PNGs. A dependency (pngjs) would only reach this repo
 * transitively, and the job runs on a bare runner with no `bun install`, so
 * this file uses `node:zlib` alone. It reads the formats Chromium and pngjs
 * write (8-bit grey, RGB, palette, grey+alpha, RGBA; not interlaced) and
 * always writes 8-bit RGBA.
 *
 * The images come from a PR's artifact, so they are untrusted input: the
 * decoder caps the pixel count and the inflated size before it allocates.
 */

import { deflateSync, inflateSync } from "node:zlib";

/** Straight (not premultiplied) RGBA, 4 bytes per pixel, row-major. */
export interface RgbaImage {
	readonly width: number;
	readonly height: number;
	readonly data: Uint8Array;
}

/** Larger than any full-page screenshot the harness takes (1440 x ~40000). */
export const MAX_PIXELS = 60_000_000;

const SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];
/** Bytes per pixel for each 8-bit colour type. */
const CHANNELS: Readonly<Record<number, number>> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/** A blank image, every pixel set to `fill` (RGBA). */
export function createImage(
	width: number,
	height: number,
	fill: readonly [number, number, number, number] = [0, 0, 0, 0],
): RgbaImage {
	const data = new Uint8Array(width * height * 4);
	for (let i = 0; i < data.length; i += 4) data.set(fill, i);
	return { width, height, data };
}

interface Chunks {
	header: Uint8Array;
	palette: Uint8Array | null;
	transparency: Uint8Array | null;
	data: Uint8Array[];
}

function readChunks(bytes: Uint8Array): Chunks {
	if (bytes.length < 8 || SIGNATURE.some((b, i) => bytes[i] !== b)) {
		throw new Error("not a PNG: bad signature");
	}
	const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const chunks: Chunks = { header: new Uint8Array(), palette: null, transparency: null, data: [] };
	let offset = 8;
	while (offset + 12 <= bytes.length) {
		const length = view.getUint32(offset);
		const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
		const body = bytes.subarray(offset + 8, offset + 8 + length);
		if (body.length !== length) throw new Error(`truncated PNG chunk ${type}`);
		if (type === "IHDR") chunks.header = body;
		else if (type === "PLTE") chunks.palette = body;
		else if (type === "tRNS") chunks.transparency = body;
		else if (type === "IDAT") chunks.data.push(body);
		else if (type === "IEND") break;
		offset += 12 + length;
	}
	return chunks;
}

interface Header {
	width: number;
	height: number;
	colorType: number;
	channels: number;
}

function parseHeader(ihdr: Uint8Array): Header {
	if (ihdr.length !== 13) throw new Error("PNG has no valid IHDR chunk");
	const view = new DataView(ihdr.buffer, ihdr.byteOffset, ihdr.byteLength);
	const width = view.getUint32(0);
	const height = view.getUint32(4);
	const [bitDepth, colorType, , , interlace] = ihdr.subarray(8);
	const channels = CHANNELS[colorType ?? -1];
	if (bitDepth !== 8 || channels === undefined) {
		throw new Error(`unsupported PNG format (bit depth ${bitDepth}, colour type ${colorType})`);
	}
	if (interlace !== 0) throw new Error("interlaced PNGs are not supported");
	if (width === 0 || height === 0 || width * height > MAX_PIXELS) {
		throw new Error(`PNG size ${width}x${height} is out of range`);
	}
	return { width, height, colorType: colorType ?? 0, channels };
}

function paeth(a: number, b: number, c: number): number {
	const p = a + b - c;
	const pa = Math.abs(p - a);
	const pb = Math.abs(p - b);
	const pc = Math.abs(p - c);
	if (pa <= pb && pa <= pc) return a;
	return pb <= pc ? b : c;
}

function predict(filter: number, a: number, b: number, c: number): number {
	switch (filter) {
		case 0:
			return 0;
		case 1:
			return a;
		case 2:
			return b;
		case 3:
			return (a + b) >> 1;
		case 4:
			return paeth(a, b, c);
		default:
			throw new Error(`bad PNG filter type ${filter}`);
	}
}

/** Reverse one row's filter in place, reading the row above from `out`. */
function unfilterRow(raw: Uint8Array, out: Uint8Array, y: number, stride: number, bpp: number) {
	const filter = raw[y * (stride + 1)] ?? 0;
	const src = y * (stride + 1) + 1;
	const row = y * stride;
	const up = row - stride;
	for (let i = 0; i < stride; i++) {
		const left = i >= bpp;
		const a = left ? (out[row + i - bpp] ?? 0) : 0;
		const b = y > 0 ? (out[up + i] ?? 0) : 0;
		const c = y > 0 && left ? (out[up + i - bpp] ?? 0) : 0;
		out[row + i] = ((raw[src + i] ?? 0) + predict(filter, a, b, c)) & 0xff;
	}
}

/** Reverse the per-row filters into packed samples, `stride` bytes per row. */
function unfilter(raw: Uint8Array, header: Header): Uint8Array {
	const stride = header.width * header.channels;
	const out = new Uint8Array(header.height * stride);
	for (let y = 0; y < header.height; y++) unfilterRow(raw, out, y, stride, header.channels);
	return out;
}

function expand(samples: Uint8Array, header: Header, chunks: Chunks): Uint8Array {
	if (header.colorType === 6) return samples;
	const pixels = header.width * header.height;
	const out = new Uint8Array(pixels * 4);
	for (let p = 0; p < pixels; p++) {
		out.set(pixelAt(samples, p, header.colorType, chunks), p * 4);
	}
	return out;
}

function pixelAt(s: Uint8Array, p: number, colorType: number, chunks: Chunks): number[] {
	if (colorType === 2) return [s[p * 3] ?? 0, s[p * 3 + 1] ?? 0, s[p * 3 + 2] ?? 0, 255];
	if (colorType === 0) {
		const g = s[p] ?? 0;
		return [g, g, g, 255];
	}
	if (colorType === 4) {
		const g = s[p * 2] ?? 0;
		return [g, g, g, s[p * 2 + 1] ?? 255];
	}
	const index = s[p] ?? 0;
	const palette = chunks.palette ?? new Uint8Array();
	const alpha = chunks.transparency?.[index] ?? 255;
	return [palette[index * 3] ?? 0, palette[index * 3 + 1] ?? 0, palette[index * 3 + 2] ?? 0, alpha];
}

/** Decode a PNG into RGBA. Throws on anything malformed or unsupported. */
export function decodePng(bytes: Uint8Array): RgbaImage {
	const chunks = readChunks(bytes);
	const header = parseHeader(chunks.header);
	const expected = header.height * (header.width * header.channels + 1);
	const compressed = Buffer.concat(chunks.data);
	const raw = new Uint8Array(inflateSync(compressed, { maxOutputLength: expected }));
	if (raw.length !== expected) throw new Error("PNG image data is truncated");
	return {
		width: header.width,
		height: header.height,
		data: expand(unfilter(raw, header), header, chunks),
	};
}

const CRC_TABLE = (() => {
	const table = new Uint32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		table[n] = c >>> 0;
	}
	return table;
})();

function crc32(bytes: Uint8Array): number {
	let c = 0xffffffff;
	for (const byte of bytes) c = (CRC_TABLE[(c ^ byte) & 0xff] ?? 0) ^ (c >>> 8);
	return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
	const out = new Uint8Array(12 + body.length);
	const view = new DataView(out.buffer);
	view.setUint32(0, body.length);
	for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
	out.set(body, 8);
	view.setUint32(8 + body.length, crc32(out.subarray(4, 8 + body.length)));
	return out;
}

/** Filter one row with Sub (1) or Up (2), whichever leaves smaller residuals. */
function filterRow(data: Uint8Array, row: number, stride: number): Uint8Array {
	const sub = new Uint8Array(stride + 1);
	const up = new Uint8Array(stride + 1);
	sub[0] = 1;
	up[0] = 2;
	let subCost = 0;
	let upCost = 0;
	for (let i = 0; i < stride; i++) {
		const x = data[row + i] ?? 0;
		const left = i >= 4 ? (data[row + i - 4] ?? 0) : 0;
		const above = row > 0 ? (data[row - stride + i] ?? 0) : 0;
		const s = (x - left) & 0xff;
		const u = (x - above) & 0xff;
		sub[i + 1] = s;
		up[i + 1] = u;
		subCost += s < 128 ? s : 256 - s;
		upCost += u < 128 ? u : 256 - u;
	}
	return upCost < subCost ? up : sub;
}

/** Encode RGBA as an 8-bit RGBA PNG. */
export function encodePng(image: RgbaImage): Uint8Array {
	const stride = image.width * 4;
	if (image.data.length !== stride * image.height) throw new Error("image data size mismatch");
	const filtered = new Uint8Array(image.height * (stride + 1));
	for (let y = 0; y < image.height; y++) {
		filtered.set(filterRow(image.data, y * stride, stride), y * (stride + 1));
	}
	const ihdr = new Uint8Array(13);
	const view = new DataView(ihdr.buffer);
	view.setUint32(0, image.width);
	view.setUint32(4, image.height);
	ihdr.set([8, 6, 0, 0, 0], 8);
	const parts = [
		Uint8Array.from(SIGNATURE),
		chunk("IHDR", ihdr),
		chunk("IDAT", new Uint8Array(deflateSync(filtered, { level: 9 }))),
		chunk("IEND", new Uint8Array()),
	];
	return new Uint8Array(Buffer.concat(parts));
}

/** Width and height from the IHDR chunk, without inflating the image. */
export function pngSize(bytes: Uint8Array): { width: number; height: number } {
	const header = parseHeader(readChunks(bytes).header);
	return { width: header.width, height: header.height };
}
