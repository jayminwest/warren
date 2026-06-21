/**
 * Preview-saturation + auth-strength readiness checks for
 * `warren doctor` and `GET /readyz`. Split out of `checks.ts`
 * (warren-5bf4) so the barrel stays under the 500-line global limit;
 * re-exported verbatim from `./checks.ts`, so every importer keeps
 * resolving unchanged.
 *
 * Covers: port-allocator saturation, live-preview saturation against
 * the global cap, and signed-cookie token strength.
 */

import { PREVIEW_MAX_LIVE_WARN_RATIO } from "../preview/eviction/index.ts";
import { type PortUsage, PREVIEW_PORT_USAGE_WARN_RATIO } from "../preview/port-allocator.ts";
import type { DiagnosticCheck, EnvLike } from "./checks.ts";

/**
 * Preview port allocator saturation (R-19 / SPEC §11.L, warren-2277). Fails
 * when ≥ `warnRatio` of the configured port range is in use by `starting`
 * or `live` runs — operators can either raise `WARREN_PREVIEW_PORT_RANGE`
 * or tighten idle-TTL / max-lifetime so the eviction worker reclaims
 * faster. Pure: takes a `usage()` probe (the allocator implements it) so
 * tests don't need a live db handle.
 */
export interface PreviewPortUsageProbe {
	usage(): Promise<PortUsage>;
}

export async function checkPreviewPortAllocator(deps: {
	readonly probe: PreviewPortUsageProbe;
	readonly warnRatio?: number;
}): Promise<DiagnosticCheck> {
	const warnRatio = deps.warnRatio ?? PREVIEW_PORT_USAGE_WARN_RATIO;
	let usage: PortUsage;
	try {
		usage = await deps.probe.usage();
	} catch (err) {
		return {
			name: "preview_port_allocator",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "verify WARREN_DB_URL is reachable and the runs table has the preview columns (migration 0009)",
		};
	}
	const ratio = usage.total === 0 ? 1 : usage.inUse / usage.total;
	const summary = `${usage.inUse}/${usage.total} ports in use (range ${usage.range.start}-${usage.range.end})`;
	if (ratio >= warnRatio) {
		return {
			name: "preview_port_allocator",
			ok: false,
			message: `${summary}, ≥ ${Math.round(warnRatio * 100)}% saturation`,
			hint: "raise WARREN_PREVIEW_PORT_RANGE or tighten WARREN_PREVIEW_IDLE_TTL / WARREN_PREVIEW_MAX_LIFETIME so the eviction worker reclaims faster",
		};
	}
	return { name: "preview_port_allocator", ok: true, message: summary };
}

/**
 * Live-preview saturation against the global cap (R-19 / SPEC §11.L,
 * warren-ea6b). Fails when the count of `starting`/`live` previews is at
 * or above `warnRatio` of `WARREN_PREVIEW_MAX_LIVE`. Operators tighten
 * `WARREN_PREVIEW_IDLE_TTL` / `WARREN_PREVIEW_MAX_LIFETIME` so the
 * eviction worker reclaims faster, or raise the cap if the deploy needs
 * more concurrent previews. Pure: takes a `count()` probe so tests don't
 * need a live db handle.
 */
export interface PreviewLiveCountProbe {
	count(): Promise<number>;
}

export async function checkPreviewMaxLive(deps: {
	readonly probe: PreviewLiveCountProbe;
	readonly maxLive: number;
	readonly warnRatio?: number;
}): Promise<DiagnosticCheck> {
	const warnRatio = deps.warnRatio ?? PREVIEW_MAX_LIVE_WARN_RATIO;
	let live: number;
	try {
		live = await deps.probe.count();
	} catch (err) {
		return {
			name: "preview_max_live",
			ok: false,
			message: err instanceof Error ? err.message : String(err),
			hint: "verify WARREN_DB_URL is reachable and the runs table has the preview columns (migration 0009)",
		};
	}
	const ratio = deps.maxLive === 0 ? 1 : live / deps.maxLive;
	const summary = `${live}/${deps.maxLive} live previews`;
	if (ratio >= warnRatio) {
		return {
			name: "preview_max_live",
			ok: false,
			message: `${summary}, ≥ ${Math.round(warnRatio * 100)}% of WARREN_PREVIEW_MAX_LIVE`,
			hint: "raise WARREN_PREVIEW_MAX_LIVE or tighten WARREN_PREVIEW_IDLE_TTL / WARREN_PREVIEW_MAX_LIFETIME so the eviction worker reclaims faster",
		};
	}
	return { name: "preview_max_live", ok: true, message: summary };
}

/**
 * Preview signed-cookie auth strength check (R-19 / SPEC §11.L,
 * warren-8a10). When `WARREN_PREVIEW_HOST` is set, the proxy preamble
 * is gated by an HMAC derived from `WARREN_API_TOKEN`. A weak token
 * ("changeme", "warren-token", a tutorial copy-paste) leaves a
 * private-code preview accessible to anyone who can guess the token —
 * the SPEC's risk #2 mitigation. Warns when the token matches a
 * placeholder or is shorter than `MIN_TOKEN_LENGTH`. No-ops when
 * `WARREN_PREVIEW_HOST` is absent (the proxy surface is off).
 */
export const PREVIEW_TOKEN_PLACEHOLDERS: readonly string[] = [
	"changeme",
	"placeholder",
	"warren-token",
	"your-token-here",
	"insecure",
	"secret",
];
/** Below this length the token is considered weak even if not a known placeholder. */
export const PREVIEW_MIN_TOKEN_LENGTH = 16;

export function checkPreviewAuthStrength(deps: { readonly env: EnvLike }): DiagnosticCheck {
	const host = deps.env.WARREN_PREVIEW_HOST?.trim() ?? "";
	if (host === "") {
		return {
			name: "preview_auth_strength",
			ok: true,
			message: "WARREN_PREVIEW_HOST unset (preview proxy disabled)",
		};
	}
	const token = deps.env.WARREN_API_TOKEN ?? "";
	if (token === "") {
		return {
			name: "preview_auth_strength",
			ok: false,
			message: "WARREN_PREVIEW_HOST is set but WARREN_API_TOKEN is empty",
			hint: "set WARREN_API_TOKEN to a strong random value (e.g. `openssl rand -hex 32`)",
		};
	}
	if (PREVIEW_TOKEN_PLACEHOLDERS.includes(token.toLowerCase())) {
		return {
			name: "preview_auth_strength",
			ok: false,
			message: "WARREN_API_TOKEN looks like a placeholder copy-pasted from docs",
			hint: "rotate WARREN_API_TOKEN to a strong random value (e.g. `openssl rand -hex 32`); the preview proxy uses it as the signed-cookie secret",
		};
	}
	if (token.length < PREVIEW_MIN_TOKEN_LENGTH) {
		return {
			name: "preview_auth_strength",
			ok: false,
			message: `WARREN_API_TOKEN is ${token.length} chars; preview surface needs ≥${PREVIEW_MIN_TOKEN_LENGTH}`,
			hint: "rotate WARREN_API_TOKEN to a strong random value (e.g. `openssl rand -hex 32`)",
		};
	}
	return { name: "preview_auth_strength", ok: true, message: `host=${host}` };
}
