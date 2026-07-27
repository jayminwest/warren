import type { ReactElement, ReactNode } from "react";
import { Navigate } from "react-router-dom";
import type { CapabilityName } from "@/api/types.ts";
import { useCapabilities } from "@/hooks/use-capabilities.ts";

/**
 * Render `children` only when this browser holds `capability`
 * (warren-f53e / pl-b82d step 19).
 *
 * The ONE mechanism the ~20 mutation affordances go through, so a public
 * visitor sees no dispatch / steer / cancel / refresh / delete control at
 * all — absent, not disabled-and-erroring. `capability` names the same
 * `RoutePolicy` the underlying route carries in `ROUTE_TABLE`
 * (`src/server/handlers/index.ts`), so the wrapper and the 403 it prevents
 * agree by construction: `dispatch` for the run / plan-run lifecycle,
 * `admin` for project + registry mutation, `readOperator` for reads a
 * spectator is not served (rendered-agent JSON, `.warren/` config).
 *
 * Defaults to `dispatch` because that is what most call sites need.
 */
export function OperatorOnly({
	capability = "dispatch",
	children,
}: {
	capability?: CapabilityName;
	children: ReactNode;
}): ReactElement | null {
	const caps = useCapabilities();
	if (!caps.can(capability)) return null;
	return <>{children}</>;
}

/**
 * Route-level counterpart of `OperatorOnly`: a whole page that only makes
 * sense for a caller holding `capability`. Bounces to `/runs` — the home
 * surface every capability level can read — instead of rendering a form
 * whose submit is guaranteed to 403.
 *
 * Renders nothing while `/whoami` is in flight rather than redirecting on
 * an unknown answer, so an operator deep-linking to `/runs/new` isn't
 * kicked off their own page by a slow first paint.
 */
export function OperatorRoute({
	capability = "dispatch",
	children,
}: {
	capability?: CapabilityName;
	children: ReactElement;
}): ReactElement | null {
	const caps = useCapabilities();
	if (caps.status === "loading") return null;
	if (!caps.can(capability)) return <Navigate to="/runs" replace />;
	return children;
}
