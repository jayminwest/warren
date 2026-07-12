/**
 * Shared Kubernetes-API error mapping for the K8s runtime backend. Extracted
 * from `provider.ts` (pl-829f step 19 / warren-31d4) so `create`/`status` and
 * the new `cancel`/`terminate`/pod-GC paths map an `ApiException` onto the
 * seam's structured `RuntimeProviderError` through ONE helper rather than three
 * copies. Pure — no cluster access.
 */

import { ApiException } from "@kubernetes/client-node";
import { RuntimeProviderError } from "../errors.ts";

/**
 * Extract a human message from a K8s `ApiException` — its `body` is the API's
 * `Status` object (`{ message, reason, code }`), sometimes still a JSON string.
 * Falls back to the exception's own message.
 */
export function apiErrorMessage(err: ApiException<unknown>): string {
	let body: unknown = err.body;
	if (typeof body === "string") {
		const raw = body;
		try {
			body = JSON.parse(raw);
		} catch {
			return raw;
		}
	}
	if (typeof body === "object" && body !== null && "message" in body) {
		const msg = (body as { message?: unknown }).message;
		if (typeof msg === "string" && msg !== "") return msg;
	}
	return err.message;
}

/**
 * Map a K8s API failure onto the seam's structured `RuntimeProviderError`
 * (namespace-missing, RBAC-forbidden, quota, transport). Non-`ApiException`
 * errors (a bug in our own code) rethrow unchanged rather than being disguised
 * as a provider error.
 */
export function mapApiError(err: unknown, context: string): Error {
	if (err instanceof ApiException) {
		return new RuntimeProviderError(
			`K8s ${context} failed (HTTP ${err.code}): ${apiErrorMessage(err)}`,
			{
				cause: err,
				recoveryHint:
					"verify the warren-runs namespace exists, the run ServiceAccount has pods/configmaps create+delete RBAC, and no ResourceQuota is exhausted (plan step 26 provisions these).",
			},
		);
	}
	return err instanceof Error ? err : new Error(String(err));
}
