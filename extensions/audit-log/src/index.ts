/**
 * @warren-ext/audit-log — the flagship warren observer extension (plan pl-116e).
 *
 * A standalone Bun package. It consumes warren's EXISTING HTTP surfaces only
 * (runs list + per-run NDJSON event tails), keeps a durable cursor in its own
 * SQLite store, normalizes lifecycle facts into append-only audit rows, and
 * exports `GET /audit-log.jsonl?since=` plus `/healthz`.
 *
 * Boundary contract (enforced by scripts/check-layers.ts, rules
 * `extensions-are-standalone` and `core-does-not-import-extensions`): this
 * package imports nothing from warren's `src/` or `scripts/`, and warren core
 * imports nothing from here. Everything it knows about warren's wire shapes is
 * derived from docs/openapi.yaml and observed responses — the places that hurt
 * are logged in FRICTION.md.
 *
 * Build order (plan pl-116e):
 *   warren-0781 — this scaffold + the boundary gate (done)
 *   warren-a0ff — collector: cursor-tailing client with durable resume
 *   warren-653a — audit store and normalization, idempotent replay
 *   warren-9c7c — export and health surface
 *   warren-88b8 — container image, README env contract, final FRICTION.md
 *   warren-c8c3 — end-to-end smoke with golden export
 */

export const EXTENSION_NAME = "audit-log";
export const EXTENSION_VERSION = "0.0.0";

/** Configuration the extension resolves from its environment. */
export interface ExtensionConfig {
	/** Base URL of the warren instance to observe, e.g. https://warren.example.com */
	readonly warrenBaseUrl: string;
	/** Bearer credential for warren's API. Never logged, never echoed by /healthz. */
	readonly warrenApiToken: string;
}

/** Resolve the environment contract, or name every missing variable. */
export function resolveConfig(
	env: Record<string, string | undefined>,
): { ok: true; config: ExtensionConfig } | { ok: false; missing: string[] } {
	const missing: string[] = [];
	const warrenBaseUrl = env.WARREN_BASE_URL;
	const warrenApiToken = env.WARREN_API_TOKEN;
	if (warrenBaseUrl === undefined || warrenBaseUrl === "") missing.push("WARREN_BASE_URL");
	if (warrenApiToken === undefined || warrenApiToken === "") missing.push("WARREN_API_TOKEN");
	if (missing.length > 0 || warrenBaseUrl === undefined || warrenApiToken === undefined) {
		return { ok: false, missing };
	}
	return { ok: true, config: { warrenBaseUrl, warrenApiToken } };
}

function main(): void {
	const resolved = resolveConfig(process.env);
	if (!resolved.ok) {
		console.error(
			`${EXTENSION_NAME}: missing required environment: ${resolved.missing.join(", ")}`,
		);
		process.exit(1);
	}
	console.error(
		`${EXTENSION_NAME}: scaffold only — the collector lands in warren-a0ff (plan pl-116e step 2)`,
	);
	process.exit(1);
}

if (import.meta.main) main();
