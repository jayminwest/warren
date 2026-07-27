import { useQuery } from "@tanstack/react-query";
import { metaApi } from "@/api/client.ts";
import {
	type Capabilities,
	resolveCapabilities,
	retryWhoami,
} from "./use-capabilities.helpers.ts";

export type { Capabilities, CapabilityStatus } from "./use-capabilities.helpers.ts";

/**
 * The UI's single source of truth for what this browser may do
 * (warren-f53e / pl-b82d step 19).
 *
 * Before public mode the SPA inferred permission from "is there a token in
 * localStorage" — a guess that is wrong in both directions once
 * `WARREN_AUTH=public` exists: a tokenless visitor is a legitimate reader,
 * and a stale token grants nothing. `GET /whoami` (warren-e195) answers the
 * question authoritatively, so every operator-only affordance renders off
 * this hook instead of a per-site conditional.
 *
 * Fetched once per session under this key: the answer changes only when the
 * stored token does, and both sites that change it (`LoginPage`, `Layout`'s
 * log out) clear the query cache.
 */
export const WHOAMI_QUERY_KEY = ["meta", "whoami"] as const;

/** Read this browser's capability set. See `WHOAMI_QUERY_KEY`. */
export function useCapabilities(): Capabilities {
	const whoami = useQuery({
		queryKey: WHOAMI_QUERY_KEY,
		queryFn: ({ signal }) => metaApi.whoami(signal),
		staleTime: Number.POSITIVE_INFINITY,
		gcTime: Number.POSITIVE_INFINITY,
		retry: retryWhoami,
	});
	return resolveCapabilities(whoami);
}
