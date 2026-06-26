/**
 * Webhook adapters for the closed-loop healer (warren-3db0, Phase 2).
 *
 * Sentry and Grafana both POST alert payloads with wildly different
 * shapes; the healer only ever reasons about one internal `HealAlert`.
 * These adapters are the thin normalization seam — they pull a stable
 * fingerprint (the dedupe key), a human title, an optional culprit
 * (file / function / service the alert blames), a detail blob, the
 * source links an operator/agent can open, and best-effort repo
 * inference (`owner/repo`) used as the project-routing fallback when no
 * static `healer.projectMapping` key matches.
 *
 * The adapters are intentionally defensive: third-party webhook payloads
 * drift, so every field beyond a derivable fingerprint is optional and
 * coerced rather than asserted. A fingerprint is always derivable: the
 * title defaults to `'alert'` and the fingerprint falls back to
 * `sentry:${title}` / `grafana:${title}`, so normalization never fails.
 */

export type HealAlertSource = "sentry" | "grafana";

export const HEAL_ALERT_SOURCES: readonly HealAlertSource[] = ["sentry", "grafana"];

export interface HealAlert {
	/** Stable dedupe key — the cooldown / max-retries gates count on it. */
	readonly fingerprint: string;
	readonly title: string;
	/** File / function / service the alert blames; null when absent. */
	readonly culprit: string | null;
	/** Free-text body (stack message, alert annotation); null when absent. */
	readonly detail: string | null;
	/** URLs an operator/agent can open to inspect the alert. */
	readonly links: readonly string[];
	readonly source: HealAlertSource;
	/** Inferred `owner/repo` for the project-routing fallback; null when none. */
	readonly repo: string | null;
}

type Json = Record<string, unknown>;

function asString(value: unknown): string | null {
	if (typeof value === "string" && value.trim() !== "") return value.trim();
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return null;
}

function asObject(value: unknown): Json | null {
	return typeof value === "object" && value !== null && !Array.isArray(value)
		? (value as Json)
		: null;
}

/**
 * Extract an `owner/repo` slug from any string that looks like a GitHub
 * URL or a bare `owner/repo`. Returns null when nothing matches so the
 * caller falls through to the next inference source.
 */
export function inferRepoSlug(raw: string | null): string | null {
	if (raw === null) return null;
	const url = raw.match(/github\.com[/:]([^/\s]+)\/([^/\s#?]+?)(?:\.git)?(?:[/#?]|$)/i);
	if (url?.[1] !== undefined && url[2] !== undefined) return `${url[1]}/${url[2]}`;
	const bare = raw.match(/^([\w.-]+)\/([\w.-]+)$/);
	if (bare?.[1] !== undefined && bare[2] !== undefined) return `${bare[1]}/${bare[2]}`;
	return null;
}

function collectLinks(...candidates: (string | null)[]): string[] {
	const seen = new Set<string>();
	for (const c of candidates) {
		if (c !== null && /^https?:\/\//i.test(c)) seen.add(c);
	}
	return [...seen];
}

/**
 * Normalize a Sentry issue-alert webhook. Sentry nests the event under
 * `data.event` (legacy `event` is also accepted). The issue `id` is the
 * most stable fingerprint; we fall back to the event `event_id` then the
 * title so a malformed-but-titled payload still dedupes consistently.
 */
export function normalizeSentryAlert(payload: unknown): HealAlert {
	const root = asObject(payload) ?? {};
	const data = asObject(root.data) ?? {};
	const event = asObject(data.event) ?? asObject(root.event) ?? {};
	const issue = asObject(data.issue) ?? asObject(root.issue) ?? {};

	const title = asString(event.title) ?? asString(root.message) ?? asString(issue.title) ?? "alert";
	const fingerprint =
		asString(issue.id) ?? asString(event.event_id) ?? asString(root.id) ?? `sentry:${title}`;
	const culprit = asString(event.culprit) ?? asString(root.culprit);
	const detail = asString(event.message) ?? asString(root.message);
	const repo = inferRepoSlug(asString(root.repository) ?? asString(event.culprit));
	const links = collectLinks(asString(root.url), asString(issue.web_url), asString(event.web_url));

	return { fingerprint, title, culprit, detail, links, source: "sentry", repo };
}

/**
 * Normalize a Grafana unified-alerting webhook. Grafana batches firing
 * alerts under `alerts[]`; we key off the first firing alert (or the
 * group when the array is empty). `fingerprint`/`labels.__alert_rule_uid__`
 * are the stablest dedupe keys; the rule name is the title.
 */
export function normalizeGrafanaAlert(payload: unknown): HealAlert {
	const root = asObject(payload) ?? {};
	const alerts = Array.isArray(root.alerts) ? root.alerts : [];
	const first = asObject(alerts[0]) ?? {};
	const labels = asObject(first.labels) ?? {};
	const annotations = asObject(first.annotations) ?? {};

	const title =
		asString(labels.alertname) ?? asString(root.title) ?? asString(root.ruleName) ?? "alert";
	const fingerprint =
		asString(first.fingerprint) ??
		asString(labels.__alert_rule_uid__) ??
		asString(root.groupKey) ??
		`grafana:${title}`;
	const culprit = asString(labels.service) ?? asString(labels.job) ?? asString(labels.instance);
	const detail = asString(annotations.description) ?? asString(annotations.summary);
	const repo = inferRepoSlug(asString(labels.repository) ?? asString(annotations.repository));
	const links = collectLinks(
		asString(first.generatorURL),
		asString(first.silenceURL),
		asString(root.externalURL),
	);

	return { fingerprint, title, culprit, detail, links, source: "grafana", repo };
}

/** Dispatch a raw webhook payload to its source-specific adapter. */
export function normalizeAlert(source: HealAlertSource, payload: unknown): HealAlert {
	return source === "sentry" ? normalizeSentryAlert(payload) : normalizeGrafanaAlert(payload);
}

/** Type guard for the `?source=` query param. */
export function isHealAlertSource(value: string | null): value is HealAlertSource {
	return value !== null && (HEAL_ALERT_SOURCES as readonly string[]).includes(value);
}
