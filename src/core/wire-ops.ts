/**
 * Ops-overview window vocabulary (warren-7194). Split out of wire.ts under
 * the file-size budget (the same move as ./wire-inbox.ts) and re-exported
 * there so the canonical import path stays `src/core/wire.ts`.
 */

/** Trailing-window options for the `GET /ops/overview` snapshot. */
export const OPS_WINDOWS = ["24h", "7d", "30d"] as const satisfies readonly string[];
export type OpsWindow = (typeof OPS_WINDOWS)[number];

/** Epoch-ms span of each ops-overview window, keyed by the wire token. */
export const OPS_WINDOW_MS: Readonly<Record<OpsWindow, number>> = {
	"24h": 24 * 60 * 60 * 1000,
	"7d": 7 * 24 * 60 * 60 * 1000,
	"30d": 30 * 24 * 60 * 60 * 1000,
};
