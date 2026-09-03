import type { ConsoleStats } from "./use-console-stats.ts";

/**
 * Pure label/format logic behind the console topbar figures, split out
 * so the repo-root `bun test` (which resolves no `@/` alias) can test
 * it without importing the component module.
 */

/** Topbar health label, identical at every width (warren-d6ea). */
export function healthLabel(health: ConsoleStats["health"]): "HEALTHY" | "UNREACHABLE" | "—" {
	return health === "ok" ? "HEALTHY" : health === "down" ? "UNREACHABLE" : "—";
}

/**
 * BURN figure: `spend.last24hUsd / 24` off the shared ops-overview query.
 * Null while loading, for spectators (spend is operator-only), or when
 * `services.dbReachable` is false — the strip shows "— / H", never a
 * fabricated zero.
 */
export function deriveBurnUsdPerHour(
	spend: { readonly last24hUsd: number } | undefined,
	dbReachable: boolean | undefined,
): number | null {
	if (spend === undefined || dbReachable === false) return null;
	return spend.last24hUsd / 24;
}

/** BURN stat value; null renders the quiet placeholder. */
export function burnValue(burnUsdPerHour: number | null): string {
	return burnUsdPerHour === null ? "— / H" : `$${burnUsdPerHour.toFixed(2)} / H`;
}

/** RUNTIME stat value off `GET /instance`; null renders the placeholder. */
export function runtimeValue(runtime: ConsoleStats["runtime"]): string | null {
	return runtime === null ? null : runtime.toUpperCase();
}
