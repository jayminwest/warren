/**
 * Shared types for the preview proxy modules (warren-b902 split of
 * src/preview/proxy/index.ts). Lives in its own file so `responses.ts` can
 * reference `PreviewProxyConfig` without a cycle through `index.ts`.
 */

import type { Repos } from "../../db/repos/index.ts";
import type { PreviewProxyHandler } from "../../server/types.ts";
import type { PreviewAuth } from "../cookie.ts";

export type { PreviewProxyHandler };

interface PreviewProxyConfigBase {
	/** Local-worker name. Defaults to the pool's `LOCAL_WORKER_NAME`
	 *  constant; only tests should override. */
	readonly localWorkerName?: string;
	/** Override the debounce window (tests). */
	readonly lastHitDebounceMs?: number;
}

export interface PreviewProxyConfigSubdomain extends PreviewProxyConfigBase {
	readonly mode: "subdomain";
	/** Operator-facing host suffix the proxy matches against `Host:`
	 *  headers (`run-<runId>.<host>`). Resolved at boot from
	 *  `WARREN_PREVIEW_HOST`. */
	readonly host: string;
}

export interface PreviewProxyConfigPath extends PreviewProxyConfigBase {
	readonly mode: "path";
	/** Operator's warren host (informational — used only in the 401
	 *  hint URL). Path mode derives the preview origin from the
	 *  request's own `Host` header, so this is allowed to be null. */
	readonly host?: string | null;
}

export type PreviewProxyConfig = PreviewProxyConfigSubdomain | PreviewProxyConfigPath;

export interface PreviewProxyDeps {
	readonly repos: Repos;
	readonly previewAuth: PreviewAuth;
	readonly config: PreviewProxyConfig;
	/** Override `fetch` for the upstream forward (tests). */
	readonly fetch?: typeof fetch;
	/** Override `Date.now()` so debounce + cookie expiry can be pinned. */
	readonly now?: () => Date;
}
