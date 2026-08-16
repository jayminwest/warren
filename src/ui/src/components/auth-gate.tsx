import type { ReactElement } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { Alert } from "@/components/ui/alert.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { formatError } from "@/lib/format-error.ts";

/**
 * Admits the browser to the app chrome, or sends it to `/login`.
 *
 * The decision comes from `GET /whoami`, not from "is there a token in
 * localStorage" (warren-f53e / pl-b82d step 19). That matters because a
 * public instance (`WARREN_AUTH=public`) admits a credential-less visitor
 * as a legitimate reader — bouncing them to a password box loses most of a
 * demo link's traffic. Under the default `WARREN_AUTH=token` the same
 * request 401s, which is exactly the "go to login" signal the old check
 * approximated. `/login` stays reachable so the operator can still
 * authenticate.
 */
export function AuthGate({ children }: { children: ReactElement }): ReactElement {
	const caps = useCapabilities();
	const location = useLocation();
	if (caps.status === "loading") {
		return (
			<div className="flex min-h-dvh items-center justify-center p-6">
				<Spinner size="lg" label="Loading warren" />
			</div>
		);
	}
	if (caps.status === "unauthenticated") {
		return <Navigate to="/login" replace state={{ from: location }} />;
	}
	if (caps.status === "error") {
		// Not a permission answer — don't silently degrade an operator to a
		// read-only UI over a network blip. Say so instead.
		return (
			<div className="p-6">
				<Alert variant="danger" title="Can't reach warren">
					{formatError(caps.error)}
				</Alert>
			</div>
		);
	}
	return children;
}
