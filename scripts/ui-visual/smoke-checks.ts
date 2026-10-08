/**
 * Pure smoke assertions for the ui-visual harness (warren-99e1). The
 * browser spec (`smoke.pw.ts`) gathers a `PageObservation` per manifest
 * case and hands it here; everything below runs under `bun test` with no
 * browser, so the judgement logic stays covered.
 */

import type { PageCase } from "./pages.ts";

/** The four smoke checks, in the order they are reported. */
export const SMOKE_CHECKS = ["console", "overflow", "root", "text"] as const;
export type SmokeCheck = (typeof SMOKE_CHECKS)[number];

/** What the browser saw on one case, collected after the page settles. */
export interface PageObservation {
	/** `console.error` messages and uncaught `pageerror`s, in arrival order. */
	readonly consoleErrors: readonly string[];
	/**
	 * Width of each horizontal scroll surface: the document, plus the
	 * console shell's `<main>`, which scrolls on its own (`overflow-y-auto`
	 * makes its x axis scroll too), so the document never sees overflow
	 * inside it.
	 */
	readonly scrollers: readonly ScrollerWidth[];
	/** `document.querySelector("#root").childElementCount`. */
	readonly rootChildCount: number;
	/** `document.body.innerText`. */
	readonly bodyText: string;
}

export interface ScrollerWidth {
	/** `html` or `main`. */
	readonly selector: string;
	readonly scrollWidth: number;
	readonly clientWidth: number;
}

/** One failed check with one human-readable reason. */
export interface SmokeProblem {
	readonly check: SmokeCheck;
	readonly detail: string;
}

/**
 * Render-leak tokens: what a template shows when it formats a missing or
 * non-primitive value. Matched case-sensitively on word boundaries so
 * "nan" inside "Finance" or "undefinedness" in prose does not trip it.
 */
const LEAK_PATTERNS: readonly { readonly token: string; readonly re: RegExp }[] = [
	{ token: "undefined", re: /\bundefined\b/ },
	{ token: "NaN", re: /\bNaN\b/ },
	{ token: "[object Object]", re: /\[object Object\]/ },
];

/** Each leak token found in `text`, with a short excerpt around the first hit. */
export function findLeakedText(text: string): string[] {
	const hits: string[] = [];
	for (const { token, re } of LEAK_PATTERNS) {
		const m = re.exec(text);
		if (m === null) continue;
		const start = Math.max(0, m.index - 30);
		const excerpt = text
			.slice(start, m.index + token.length + 30)
			.replace(/\s+/g, " ")
			.trim();
		hits.push(`"${token}" in "…${excerpt}…"`);
	}
	return hits;
}

/** Every problem one observation shows; empty when the page is clean. */
export function evaluateSmoke(obs: PageObservation): SmokeProblem[] {
	const problems: SmokeProblem[] = obs.consoleErrors.map((detail) => ({
		check: "console",
		detail,
	}));
	for (const sc of obs.scrollers) {
		const overflow = sc.scrollWidth - sc.clientWidth;
		if (overflow <= 0) continue;
		problems.push({
			check: "overflow",
			detail: `horizontal overflow in ${sc.selector}: scrollWidth ${sc.scrollWidth} > clientWidth ${sc.clientWidth} (+${overflow}px)`,
		});
	}
	if (obs.rootChildCount === 0)
		problems.push({ check: "root", detail: "#root rendered no children" });
	for (const detail of findLeakedText(obs.bodyText)) problems.push({ check: "text", detail });
	return problems;
}

/**
 * A smoke failure the harness tolerates until its tracked fix lands. The
 * harness also fails when a listed failure STOPS reproducing, so the list
 * only shrinks: delete the entry in the PR that fixes it.
 */
export interface KnownFailure {
	/** Manifest page id (`PAGES[].id`). */
	readonly page: string;
	readonly check: SmokeCheck;
	/** Tolerate only problems whose detail matches. Omitted = any problem of `check`. */
	readonly match?: RegExp;
	/** Omitted = every viewport / theme. */
	readonly viewport?: string;
	readonly theme?: string;
	/** The seeds issue tracking the fix, e.g. "warren-1234". */
	readonly seed: string;
	readonly reason: string;
}

/**
 * Anonymous probes from the login page draw 401s under `WARREN_AUTH=token`,
 * and Chromium logs every 4xx resource load as a console error (warren-8ee5).
 */
const LOGIN_PROBE_401 =
	/status of 401 \(Unauthorized\) \(https?:\/\/[^/]+\/(whoami|instance|events\/stream)\b/;

/** Tracked smoke failures. Every entry names the seed that removes it. */
export const KNOWN_FAILURES: readonly KnownFailure[] = [
	{
		page: "login",
		check: "console",
		match: LOGIN_PROBE_401,
		seed: "warren-8ee5",
		reason:
			"login fires /whoami, /instance, and the lifecycle stream anonymously; each 401s under token auth",
	},
];

function appliesTo(k: KnownFailure, c: Pick<PageCase, "page" | "viewport" | "theme">): boolean {
	return (
		k.page === c.page.id &&
		(k.viewport === undefined || k.viewport === c.viewport) &&
		(k.theme === undefined || k.theme === c.theme)
	);
}

export interface SmokeVerdict {
	/** Problems no known failure covers. */
	readonly unexpected: readonly SmokeProblem[];
	/** Known failures that matched nothing: the entry is stale and must go. */
	readonly stale: readonly KnownFailure[];
	/** Known failures that reproduced as expected. */
	readonly tolerated: readonly KnownFailure[];
}

/** Split one case's problems against the known-failure list. */
export function reconcile(
	c: Pick<PageCase, "page" | "viewport" | "theme">,
	problems: readonly SmokeProblem[],
	known: readonly KnownFailure[] = KNOWN_FAILURES,
): SmokeVerdict {
	const applicable = known.filter((k) => appliesTo(k, c));
	const used = new Set<KnownFailure>();
	const unexpected = problems.filter((p) => {
		const k = applicable.find(
			(x) => x.check === p.check && (x.match === undefined || x.match.test(p.detail)),
		);
		if (k === undefined) return true;
		used.add(k);
		return false;
	});
	return {
		unexpected,
		stale: applicable.filter((k) => !used.has(k)),
		tolerated: applicable.filter((k) => used.has(k)),
	};
}

/** The assertion message for a verdict; empty when the case passes. */
export function formatVerdict(caseName: string, v: SmokeVerdict): string {
	const lines = v.unexpected.map((p) => `[${p.check}] ${p.detail}`);
	for (const k of v.stale) {
		lines.push(
			`[${k.check}] known failure (${k.seed}) no longer reproduces: ` +
				"delete it from KNOWN_FAILURES in scripts/ui-visual/smoke-checks.ts",
		);
	}
	return lines.length === 0 ? "" : `${caseName}\n${lines.join("\n")}`;
}
