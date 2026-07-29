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

/**
 * Copy-level counterpart of `OperatorOnly`: return `hint` only for a caller
 * holding `capability`, `undefined` otherwise (warren-b67b).
 *
 * The empty states were written for operators, so they instruct the reader
 * to use the very control `OperatorOnly` removed — "Dispatch one above."
 * points at nothing for a public visitor, which makes every empty list on
 * `app.warren.run` a dead end. The `EmptyState` title already says
 * "nothing here" on its own, so a spectator loses the instruction line
 * rather than gaining a second, redundant one.
 *
 * A hook, not a wrapper component, because `EmptyState.description` is a
 * slot: `<OperatorOnly>` inside it renders nothing but the description row
 * still gets its `gap-2`, so a spectator pays 8px for an empty div.
 * Returning `undefined` drops the row entirely.
 *
 * Call it unconditionally at the top of the component like any other hook —
 * the empty branch it feeds renders conditionally, the hook must not.
 * Defaults to `dispatch` to match `OperatorOnly`; pass the capability that
 * gates the control the copy points at.
 */
export function useOperatorHint(
	hint: ReactNode,
	capability: CapabilityName = "dispatch",
): ReactNode {
	const caps = useCapabilities();
	return caps.can(capability) ? hint : undefined;
}
