/*
 * Canonical responsive contract (warren-3315 / pl-dfb5 step 5).
 *
 * Warren's UI is mobile-first. Unprefixed (base) utility classes target
 * the phone range; the first Tailwind breakpoint `sm:` (640px) is where
 * the desktop/compact layout takes over. This module is the single
 * source of truth for the breakpoint targets plus the reusable
 * class-name tokens that encode the standardized patterns, so pages stop
 * re-typing the same ad-hoc strings and every surface degrades the same
 * way. Step 6 (warren-42ba) applies these tokens across all pages.
 *
 * Breakpoint targets:
 *  - PHONE_MAX (393px) — primary phone target (iPhone 14/15/16 logical
 *    width). Everything must look intentional here.
 *  - PHONE_MIN (360px) — smallest supported logical width (older / small
 *    Android). Layouts must remain usable with no horizontal overflow
 *    that hides data; they may get tighter but must not break.
 *  - SM (640px) — Tailwind's first breakpoint and our mobile→desktop
 *    cutover. Below it, base styles apply; at/above it, `sm:` styles win.
 */

/** Primary phone logical width (px) — the main design target. */
export const PHONE_MAX = 393;

/** Smallest supported logical width (px) — graceful-degradation floor. */
export const PHONE_MIN = 360;

/** Tailwind's first breakpoint (px) — the mobile→desktop cutover. */
export const SM_BREAKPOINT = 640;

/**
 * Reusable wide-table-on-mobile pattern.
 *
 * The `Table` primitive (components/ui/table.tsx) already wraps the
 * `<table>` in `relative w-full overflow-auto`, so a table that is too
 * wide for the viewport scrolls horizontally inside its card instead of
 * squishing. These tokens drive the per-cell strategy that makes that
 * scroll clean:
 *
 *  - `cellNoWrap` — every `TableHead`/`TableCell` keeps its content on
 *    one line so columns retain their natural width and the overflow
 *    wrapper provides a single clean horizontal scroll rather than a
 *    ragged multi-line table.
 *  - `cellTruncate` — wide free-text columns (ids, messages, paths) cap
 *    their width and ellipsize instead of forcing the whole table wider
 *    than the data that actually needs to be read.
 */
export const responsiveTable = {
	cellNoWrap: "whitespace-nowrap",
	cellTruncate: "max-w-[16rem] truncate",
} as const;

/**
 * Card header rows that pair a title/stat with action controls. On
 * narrow viewports the controls wrap to a second row instead of
 * overflowing or colliding with the title.
 */
export const responsiveCardHeaderRow =
	"flex flex-row flex-wrap items-center justify-between gap-2 space-y-0";

/**
 * A control pushed to the trailing edge of a filter row (e.g. a project
 * `<select>` with `ml-auto`). On mobile it becomes a full-width row; on
 * `sm+` it floats back to its auto width at the trailing edge.
 */
export const responsiveTrailingControl = "w-full sm:ml-auto sm:w-auto";

/**
 * Mobile-first form control sizing. Bumps inputs/selects/buttons to 44px
 * touch targets and 16px text on phones (the 16px floor suppresses iOS
 * Safari's focus auto-zoom), collapsing to the compact desktop sizing at
 * `sm+`.
 */
export const responsiveFormControl = "h-11 text-base sm:h-9 sm:text-sm";

/**
 * Footer action row (e.g. Cancel / submit). Stacks full-width buttons on
 * mobile so the primary action sits at the bottom of the thumb-reach
 * stack, then becomes a right-aligned row at `sm+`.
 */
export const responsiveFooterActions = "flex flex-col gap-2 sm:flex-row sm:justify-end";

/** Each button inside {@link responsiveFooterActions}. */
export const responsiveFooterButton = "w-full sm:w-auto";
