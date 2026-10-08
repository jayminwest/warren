/**
 * Which ui-visual cases carry a golden screenshot, and where the golden
 * spec may run at all (warren-a132, plan pl-10db step 10).
 *
 * Pure (no Bun or Playwright APIs), so the Playwright runner (Node),
 * `run.ts`, the golden guard, and `bun test` all share one definition.
 */

import {
	caseName,
	PAGES,
	type PageSpec,
	THEMES,
	type ThemeName,
	VIEWPORT_NAMES,
	type ViewportName,
} from "./pages.ts";

/** Set to `1` by `.github/workflows/ui-visual.yml`, and nowhere else. */
export const GOLDEN_ENV = "WARREN_UI_VISUAL_GOLDEN";

/** Baselines live in `scripts/ui-visual/__golden__/` (`goldenFileName`). */
export const GOLDEN_DIR_NAME = "__golden__";
/** The generator sidecar beside the baselines (see `golden-manifest.ts`). */
export const GOLDEN_MANIFEST_FILE = "manifest.json";

/**
 * On a golden mismatch the spec copies Playwright's images to
 * `out/golden-diff/<case name>/{expected,actual,diff}.png` plus a
 * `result.json`, so a follow-up (warren-70d9's PR comment) can find them
 * without parsing Playwright's hashed test-results directory names.
 */
export const GOLDEN_DIFF_DIR = "golden-diff";

/** The whole baseline set stays under this (plan pl-10db acceptance). */
export const MAX_GOLDEN_BYTES = 8 * 1024 * 1024;

/** How to refresh the baselines; every guard and skip message points here. */
export const GOLDEN_UPDATE_HINT =
	"regenerate them in the CI container: " +
	"`gh workflow run ui-visual.yml --ref <branch> -f update_goldens=true`, " +
	"then download the `ui-goldens-<sha>` artifact into scripts/ui-visual/__golden__/ " +
	"(scripts/ui-visual/README.md, 'Golden screenshots')";

/**
 * Viewport and theme pairs without a golden. Phone x dark is the one pair
 * dropped: desktop x dark already pins the dark palette and phone x light
 * pins the phone layout, and the full matrix would crowd the 8 MB budget.
 * The smoke and a11y specs still cover every pair.
 */
export const GOLDEN_SKIPPED_PAIRS: readonly { viewport: ViewportName; theme: ThemeName }[] = [
	{ viewport: "phone", theme: "dark" },
];

/** True when this viewport and theme pair carries a golden screenshot. */
export function isGoldenPair(viewport: ViewportName, theme: ThemeName): boolean {
	return !GOLDEN_SKIPPED_PAIRS.some((p) => p.viewport === viewport && p.theme === theme);
}

/**
 * A case's golden file name: the case name with dashes for dots
 * (`runs.desktop.light` -> `runs-desktop-light.png`). Playwright rewrites
 * dots in a snapshot name to dashes anyway, so name it that way up front
 * and every consumer agrees on one spelling. The viewport and theme are
 * always the last two segments.
 */
export function goldenFileName(name: string): string {
	return `${name.replaceAll(".", "-")}.png`;
}

/** Every golden file name the manifest implies, sorted. */
export function expectedGoldenFiles(pages: readonly PageSpec[] = PAGES): string[] {
	return pages
		.flatMap((page) =>
			VIEWPORT_NAMES.flatMap((viewport) =>
				THEMES.filter((theme) => isGoldenPair(viewport, theme)).map((theme) =>
					goldenFileName(caseName(page.id, viewport, theme)),
				),
			),
		)
		.sort();
}

export type GoldenGate = { readonly enabled: true } | { readonly enabled: false; reason: string };

/**
 * The golden spec runs only inside the ui-visual workflow's pinned
 * Playwright container: linux/x64 with `GOLDEN_ENV=1`. Anywhere else
 * (a macOS laptop, the arm64 variant of the same image) fonts and
 * rasterization differ, so a comparison would fail and an update would
 * write baselines CI cannot reproduce.
 */
export function goldenGate(
	env: Readonly<Record<string, string | undefined>>,
	platform: string,
	arch: string,
): GoldenGate {
	if (platform !== "linux" || arch !== "x64") {
		return {
			enabled: false,
			reason:
				`golden screenshots render only in the ui-visual CI container (linux/x64); ` +
				`this host is ${platform}/${arch}. To refresh baselines, ${GOLDEN_UPDATE_HINT}`,
		};
	}
	if (env[GOLDEN_ENV] !== "1") {
		return {
			enabled: false,
			reason:
				`${GOLDEN_ENV} is not 1: only .github/workflows/ui-visual.yml sets it, inside the ` +
				`pinned Playwright image. To refresh baselines, ${GOLDEN_UPDATE_HINT}`,
		};
	}
	return { enabled: true };
}

export type DiffKind = "expected" | "actual" | "diff";

/**
 * Map a Playwright snapshot attachment name (`<case>-expected.png`,
 * `-actual.png`, `-diff.png`) to its kind; null for anything else.
 */
export function diffKind(attachmentName: string): DiffKind | null {
	const match = /-(expected|actual|diff)\.png$/.exec(attachmentName);
	return (match?.[1] as DiffKind | undefined) ?? null;
}
