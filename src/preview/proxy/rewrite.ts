/**
 * Path-mode HTML / URL byte-level rewrite logic for the preview proxy
 * (warren-b902 split of src/preview/proxy/index.ts; SPEC §11.L addendum,
 * warren-ab3a + warren-63e1).
 *
 * Two byte-wise transforms run over the head of `text/html` responses
 * (capped at `HTML_HEAD_LOOKAHEAD_BYTES` to bound the work):
 *
 *   - `injectBaseHref` — splice `<base href="<pathPrefix>/">` after the
 *     opening `<head>` tag. Idempotent: skipped when a `<base>` element
 *     is already in the window.
 *   - `rewriteRootRelativeAttrs` — prefix root-relative `href`, `src`,
 *     `srcset` attribute values so absolute paths emitted by Next.js /
 *     Vite / SvelteKit / Astro asset pipelines land back under the
 *     preview's `/p/<runId>/...` prefix.
 *
 * `rewriteLocationHeader` is the same idea applied to `Location:` on
 * 3xx responses (text, not bytes). `applyPathModeRewrites` is the
 * orchestrator that stitches them together; subdomain mode bypasses it
 * entirely because the upstream origin already owns its own URL space.
 */

/** SPEC §11.L addendum (warren-ab3a): cap the lookahead for `<head>` /
 *  `<base>` detection to the first 64 KiB of body. Documents without a
 *  parseable `<head>` in that window pass through untouched. The same
 *  cap bounds the root-relative URL attribute rewrite (warren-63e1)
 *  so neither transform pays for a hostile multi-megabyte upstream. */
export const HTML_HEAD_LOOKAHEAD_BYTES = 64 * 1024;

const TEXT_ENCODER = new TextEncoder();
const HEAD_OPEN_BYTES = TEXT_ENCODER.encode("<head");
const BASE_OPEN_BYTES = TEXT_ENCODER.encode("<base");

/**
 * Path-mode response transforms (SPEC §11.L addendum, warren-ab3a).
 * Rewrites a same-origin `Location:` on 3xx responses, and best-effort
 * injects `<base href="<pathPrefix>/">` after the opening `<head>` tag
 * on `text/html` bodies. All other content types and statuses stream
 * through unchanged.
 */
export async function applyPathModeRewrites(
	upstream: Response,
	headers: Headers,
	pathPrefix: string,
): Promise<Response> {
	if (upstream.status >= 300 && upstream.status < 400) {
		const loc = headers.get("location");
		if (loc !== null) {
			const rewritten = rewriteLocationHeader(loc, pathPrefix);
			if (rewritten !== loc) headers.set("location", rewritten);
		}
	}

	if (!isHtmlContentType(headers.get("content-type")) || upstream.body === null) {
		return new Response(upstream.body, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	// `headers` was already stripped of content-encoding and content-length
	// by the caller (forwardToUpstream) so the browser doesn't try to
	// gunzip plaintext or trust a length from the encoded upstream body.

	const reader = upstream.body.getReader();
	const chunks: Uint8Array[] = [];
	let collected = 0;
	let exhausted = false;
	while (collected < HTML_HEAD_LOOKAHEAD_BYTES) {
		const { value, done } = await reader.read();
		if (done) {
			exhausted = true;
			break;
		}
		chunks.push(value);
		collected += value.byteLength;
	}
	const head = concatChunks(chunks, collected);
	const baseInjected = injectBaseHref(head, pathPrefix);
	const afterBase = baseInjected ?? head;
	const attrsRewritten = rewriteRootRelativeAttrs(afterBase, pathPrefix);
	const startBytes = attrsRewritten ?? afterBase;

	if (exhausted) {
		// Cast: TS's BodyInit shape excludes the parameterized
		// Uint8Array<ArrayBufferLike> Bun's lib emits, but the runtime
		// accepts Uint8Array everywhere a BufferSource is allowed.
		return new Response(startBytes as unknown as BodyInit, {
			status: upstream.status,
			statusText: upstream.statusText,
			headers,
		});
	}

	const stream = new ReadableStream<Uint8Array>({
		async start(controller) {
			controller.enqueue(startBytes);
			try {
				while (true) {
					const { value, done } = await reader.read();
					if (done) break;
					if (value !== undefined) controller.enqueue(value);
				}
				controller.close();
			} catch (err) {
				controller.error(err);
			}
		},
	});
	return new Response(stream, {
		status: upstream.status,
		statusText: upstream.statusText,
		headers,
	});
}

function concatChunks(chunks: readonly Uint8Array[], total: number): Uint8Array {
	if (chunks.length === 1) {
		const single = chunks[0];
		if (single !== undefined) return single;
	}
	const out = new Uint8Array(total);
	let offset = 0;
	for (const c of chunks) {
		out.set(c, offset);
		offset += c.byteLength;
	}
	return out;
}

/**
 * Match `Content-Type: text/html` (parameters tolerated, e.g.
 * `text/html; charset=utf-8`). Other media types pass through the
 * rewriter untouched.
 */
export function isHtmlContentType(value: string | null): boolean {
	if (value === null) return false;
	const semi = value.indexOf(";");
	const media = (semi === -1 ? value : value.slice(0, semi)).trim().toLowerCase();
	return media === "text/html";
}

/**
 * Inject `<base href="<pathPrefix>/">` immediately after the opening
 * `<head>` tag. Idempotent: returns `null` (no rewrite) when an existing
 * `<base>` element is already present anywhere in the lookahead window,
 * or when no `<head>` tag is found in the first
 * `HTML_HEAD_LOOKAHEAD_BYTES` bytes. Operates on bytes so the head
 * portion of arbitrary UTF-8 documents round-trips losslessly — we only
 * splice ASCII bytes in at an ASCII-tag boundary.
 */
export function injectBaseHref(body: Uint8Array, pathPrefix: string): Uint8Array | null {
	const window = body.subarray(0, Math.min(body.length, HTML_HEAD_LOOKAHEAD_BYTES));
	const headStart = indexOfAsciiCaseInsensitive(window, HEAD_OPEN_BYTES);
	if (headStart === -1) return null;
	// Find the next `>` that closes the opening tag. The tag may have
	// attributes (`<head lang="en">`); attributes are bounded by the same
	// `>` rule HTML uses, so we just scan for it.
	let cursor = headStart + HEAD_OPEN_BYTES.length;
	while (cursor < window.length && window[cursor] !== 0x3e /* > */) cursor++;
	if (cursor >= window.length) return null;
	const insertAt = cursor + 1;
	if (hasBaseElement(window, insertAt)) return null;
	const inject = TEXT_ENCODER.encode(`<base href="${pathPrefix}/">`);
	const out = new Uint8Array(body.length + inject.length);
	out.set(body.subarray(0, insertAt), 0);
	out.set(inject, insertAt);
	out.set(body.subarray(insertAt), insertAt + inject.length);
	return out;
}

/**
 * Rewrite root-relative `href`, `src`, and `srcset` attribute values
 * (warren-63e1) so root-relative URLs emitted by Next.js / Vite /
 * SvelteKit / Astro asset pipelines land back under the preview's
 * `/p/<runId>/...` prefix. Operates byte-wise over the same
 * `HTML_HEAD_LOOKAHEAD_BYTES` window the `<base>` injection uses so
 * the post-window stream still passes through unchanged.
 *
 * Returns the modified buffer, or `null` when nothing in the window
 * needed rewriting (caller falls back to the original bytes). The
 * scanner is conservative: it only fires on a `<attr>=<quote>/<value><quote>`
 * pattern where the attribute name is preceded by an HTML attribute
 * boundary (whitespace, `<`, or `/`), the value begins with a single
 * `/` (protocol-relative `//host` and absolute URLs are left alone),
 * and the value is not already prefixed with `<pathPrefix>/`. `srcset`
 * is split on commas and each entry's leading URL is rewritten in
 * place.
 */
export function rewriteRootRelativeAttrs(body: Uint8Array, pathPrefix: string): Uint8Array | null {
	const limit = Math.min(body.length, HTML_HEAD_LOOKAHEAD_BYTES);
	const prefixBytes = TEXT_ENCODER.encode(pathPrefix);
	const parts: Uint8Array[] = [];
	let segmentStart = 0;
	let cursor = 0;
	let mutated = false;

	while (cursor < limit) {
		const m = matchAttributeAt(body, cursor, limit);
		if (m === null) {
			cursor++;
			continue;
		}
		const value = body.subarray(m.valueStart, m.valueEnd);
		const rewritten = m.isSrcset
			? rewriteSrcsetValue(value, prefixBytes)
			: rewriteUrlValue(value, prefixBytes);
		if (rewritten !== null) {
			parts.push(body.subarray(segmentStart, m.valueStart));
			parts.push(rewritten);
			segmentStart = m.valueEnd;
			mutated = true;
		}
		cursor = m.valueEnd;
	}

	if (!mutated) return null;
	parts.push(body.subarray(segmentStart));
	let total = 0;
	for (const p of parts) total += p.byteLength;
	return concatChunks(parts, total);
}

interface AttributeMatch {
	readonly valueStart: number;
	readonly valueEnd: number;
	readonly isSrcset: boolean;
}

/**
 * Find a `<attr>=<quote>...<quote>` pattern at exactly `i`, where attr is
 * one of `href`, `src`, `srcset`. Returns the inclusive byte range of the
 * attribute value (without the surrounding quotes) on a hit, null otherwise.
 *
 * The preceding byte must be a known HTML attribute boundary so we don't
 * match `xhref=` inside another word or a string literal — the realistic
 * non-match risk is matching attribute names that are substrings of other
 * tokens inside an inline `<script>`/`<style>` block. We accept that risk
 * inside the 64 KiB head window because (a) inline scripts in the head are
 * rare on production bundlers, (b) substring matches inside JS string
 * literals would have to be quoted with `"`/`'` to trigger, and (c) the
 * rewrite only fires on values starting with `/`.
 */
function matchAttributeAt(body: Uint8Array, i: number, limit: number): AttributeMatch | null {
	for (const attr of ATTR_PATTERNS) {
		if (i + attr.name.length + 2 > body.length) continue;
		if (!matchesAsciiCi(body, i, attr.name)) continue;
		// Boundary check: previous byte must be whitespace, `<`, or `/`.
		if (i > 0) {
			const prev = body[i - 1];
			if (
				prev !== 0x20 /* space */ &&
				prev !== 0x09 /* tab */ &&
				prev !== 0x0a /* LF */ &&
				prev !== 0x0d /* CR */ &&
				prev !== 0x3c /* < */ &&
				prev !== 0x2f /* / */
			) {
				continue;
			}
		}
		const eqPos = i + attr.name.length;
		if (body[eqPos] !== 0x3d /* = */) continue;
		const quotePos = eqPos + 1;
		const quote = body[quotePos];
		if (quote !== 0x22 /* " */ && quote !== 0x27 /* ' */) continue;
		const valueStart = quotePos + 1;
		let valueEnd = valueStart;
		while (valueEnd < body.length && body[valueEnd] !== quote) valueEnd++;
		// Unterminated quoted value → bail. valueEnd at limit/end is OK only when
		// the closing quote exists; otherwise the rewrite is unsafe.
		if (valueEnd >= body.length) continue;
		if (valueStart > limit) continue;
		return { valueStart, valueEnd, isSrcset: attr.isSrcset };
	}
	return null;
}

const ATTR_PATTERNS: ReadonlyArray<{ name: Uint8Array; isSrcset: boolean }> = [
	{ name: new TextEncoder().encode("srcset"), isSrcset: true },
	{ name: new TextEncoder().encode("href"), isSrcset: false },
	{ name: new TextEncoder().encode("src"), isSrcset: false },
];

function matchesAsciiCi(haystack: Uint8Array, at: number, needle: Uint8Array): boolean {
	if (at + needle.length > haystack.length) return false;
	for (let j = 0; j < needle.length; j++) {
		const h = haystack[at + j];
		const n = needle[j];
		if (h === undefined || n === undefined) return false;
		const hLower = h >= 0x41 && h <= 0x5a ? h + 0x20 : h;
		const nLower = n >= 0x41 && n <= 0x5a ? n + 0x20 : n;
		if (hLower !== nLower) return false;
	}
	return true;
}

/**
 * Rewrite a single root-relative URL value. Returns null when the value
 * doesn't qualify (empty, doesn't start with `/`, starts with `//`,
 * already prefixed). On a hit returns a new buffer with `prefix`
 * prepended.
 */
function rewriteUrlValue(value: Uint8Array, prefix: Uint8Array): Uint8Array | null {
	if (value.length === 0) return null;
	if (value[0] !== 0x2f /* / */) return null;
	// Protocol-relative `//host/...` — out of scope.
	if (value.length >= 2 && value[1] === 0x2f) return null;
	if (startsWithPrefix(value, prefix)) {
		// Already at the prefix root or under the prefix. `/p/<id>` exactly
		// and `/p/<id>/...` both pass through.
		if (value.length === prefix.length) return null;
		if (value[prefix.length] === 0x2f) return null;
	}
	const out = new Uint8Array(prefix.length + value.length);
	out.set(prefix, 0);
	out.set(value, prefix.length);
	return out;
}

/**
 * Rewrite a `srcset` attribute value. Splits on commas at the top level
 * (commas inside data: URLs are not handled — those skip the rewrite
 * anyway because they don't start with `/`). For each entry, the URL is
 * the leading whitespace-trimmed run up to the next whitespace; only
 * that URL portion is rewritten via `rewriteUrlValue`.
 */
function rewriteSrcsetValue(value: Uint8Array, prefix: Uint8Array): Uint8Array | null {
	const text = new TextDecoder("utf-8", { fatal: false }).decode(value);
	const entries = text.split(",");
	let changed = false;
	const rewrittenEntries = entries.map((entry) => {
		const leading = entry.match(/^\s*/)?.[0] ?? "";
		const rest = entry.slice(leading.length);
		const urlEnd = rest.search(/\s/);
		const url = urlEnd === -1 ? rest : rest.slice(0, urlEnd);
		const tail = urlEnd === -1 ? "" : rest.slice(urlEnd);
		if (url.length === 0) return entry;
		const urlBytes = new TextEncoder().encode(url);
		const rewritten = rewriteUrlValue(urlBytes, prefix);
		if (rewritten === null) return entry;
		changed = true;
		return `${leading}${new TextDecoder().decode(rewritten)}${tail}`;
	});
	if (!changed) return null;
	return new TextEncoder().encode(rewrittenEntries.join(","));
}

function startsWithPrefix(value: Uint8Array, prefix: Uint8Array): boolean {
	if (value.length < prefix.length) return false;
	for (let i = 0; i < prefix.length; i++) {
		if (value[i] !== prefix[i]) return false;
	}
	return true;
}

/**
 * Rewrite a `Location:` header value into the path-mode prefix when it
 * names a same-origin absolute path. Returns the input unchanged when:
 *   - the value is empty;
 *   - the value is an absolute URL (`http://...`, `https://...`);
 *   - the value is a scheme-relative URL (`//host/path`);
 *   - the value already lives under `<pathPrefix>/`.
 *
 * Only path-mode callers invoke this; subdomain mode preserves URL
 * semantics already.
 */
export function rewriteLocationHeader(value: string, pathPrefix: string): string {
	if (value.length === 0) return value;
	// Same-origin absolute paths start with a single `/`; protocol-relative
	// `//host/path` and absolute URLs (`http(s)://...`) are out of scope.
	if (!value.startsWith("/") || value.startsWith("//")) return value;
	if (value === pathPrefix) return value;
	if (value.startsWith(`${pathPrefix}/`)) return value;
	return `${pathPrefix}${value}`;
}

function indexOfAsciiCaseInsensitive(haystack: Uint8Array, needle: Uint8Array, start = 0): number {
	if (needle.length === 0) return start;
	const end = haystack.length - needle.length;
	outer: for (let i = start; i <= end; i++) {
		for (let j = 0; j < needle.length; j++) {
			const h = haystack[i + j];
			const n = needle[j];
			if (h === undefined || n === undefined) continue outer;
			const hLower = h >= 0x41 && h <= 0x5a ? h + 0x20 : h;
			const nLower = n >= 0x41 && n <= 0x5a ? n + 0x20 : n;
			if (hLower !== nLower) continue outer;
		}
		return i;
	}
	return -1;
}

/**
 * Return true iff the buffer contains a `<base>` element (i.e. `<base`
 * followed by whitespace, `/`, or `>`) — `<basefont>` is the only other
 * element starting with `<base` and is deprecated enough we ignore it.
 */
function hasBaseElement(buf: Uint8Array, from: number): boolean {
	let cursor = from;
	while (cursor < buf.length) {
		const idx = indexOfAsciiCaseInsensitive(buf, BASE_OPEN_BYTES, cursor);
		if (idx === -1) return false;
		const next = buf[idx + BASE_OPEN_BYTES.length];
		if (
			next === 0x20 || // space
			next === 0x09 || // tab
			next === 0x0a || // LF
			next === 0x0d || // CR
			next === 0x2f || // /
			next === 0x3e // >
		) {
			return true;
		}
		cursor = idx + BASE_OPEN_BYTES.length;
	}
	return false;
}
