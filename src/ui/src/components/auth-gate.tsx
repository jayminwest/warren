import { useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import type { ReactElement, ReactNode } from "react";
import { Link, Navigate, useLocation } from "react-router-dom";
import { Button } from "@/components/ui/button.tsx";
import { Card } from "@/components/ui/card.tsx";
import { WarrenLogo } from "@/components/warren-logo.tsx";
import { useCapabilities, WHOAMI_QUERY_KEY } from "@/hooks/use-capabilities.ts";
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

/** Full-screen centered card with the warren mark (warren-9474). */
function GateScreen({
	title,
	children,
	actions,
}: {
	title: string;
	children: ReactNode;
	actions: ReactNode;
}) {
	return (
		<div className="flex min-h-dvh items-center justify-center bg-(--color-bg) px-4 py-10">
			<Card className="animate-pop-in w-full max-w-sm self-center">
				<div className="flex flex-col items-center gap-2 px-6 pt-8 pb-6 text-center">
					<WarrenLogo className="size-9 text-(--color-text-2)" />
					<h1 className="pt-1 text-lg font-semibold text-(--color-text)">{title}</h1>
					<div className="flex flex-col gap-3 text-sm text-(--color-text-2)">{children}</div>
				</div>
				<div className="flex flex-col gap-2 border-t border-(--color-border) p-4 sm:flex-row-reverse">
					{actions}
				</div>
			</Card>
		</div>
	);
}

/** Boot splash while `/whoami` answers: the mark, breathing. */
function GateLoading() {
	return (
		<div
			role="status"
			aria-label="Loading warren"
			className="flex min-h-dvh items-center justify-center bg-(--color-bg)"
		>
			<WarrenLogo className="size-10 animate-pulse text-(--color-text-3)" />
		</div>
	);
}

function UnreachableScreen({ error }: { error: unknown }) {
	const qc = useQueryClient();
	const detail = formatError(error);
	return (
		<GateScreen
			title="Can't reach warren"
			actions={
				<>
					<Button
						className="h-11 flex-1 sm:h-8"
						onClick={() => qc.invalidateQueries({ queryKey: WHOAMI_QUERY_KEY })}
					>
						<RefreshCw />
						Try again
					</Button>
					<Button asChild variant="outline" className="h-11 flex-1 sm:h-8">
						<Link to="/login">Use a different token</Link>
					</Button>
				</>
			}
		>
			<p>The server didn't answer. Check your connection, or whether the instance is up.</p>
			{detail ? (
				<p className="rounded-sm bg-(--color-surface-raised) px-2.5 py-2 text-left font-mono text-xs break-words text-(--color-text-3)">
					{detail}
				</p>
			) : null}
		</GateScreen>
	);
}

export function AuthGate({ children }: { children: ReactElement }): ReactElement {
	const caps = useCapabilities();
	const location = useLocation();
	if (caps.status === "loading") return <GateLoading />;
	if (caps.status === "unauthenticated") {
		return <Navigate to="/login" replace state={{ from: location }} />;
	}
	if (caps.status === "error") {
		// Not a permission answer — don't silently degrade an operator to a
		// read-only UI over a network blip. Say so instead.
		return <UnreachableScreen error={caps.error} />;
	}
	return children;
}
