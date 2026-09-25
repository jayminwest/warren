import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { formatError } from "@/lib/format-error.ts";

/**
 * A list that failed to load (warren-9474): say what failed, show the
 * server's reason, and offer a retry. Page-local to the list pages
 * (runs, plan runs, projects, agents) until it is promoted to
 * components/ui.
 */
export function ListError({
	what,
	error,
	onRetry,
}: {
	/** The thing that failed to load, e.g. "runs". */
	what: string;
	error: unknown;
	onRetry?: () => void;
}) {
	return (
		<EmptyState
			compact
			icon={AlertTriangle}
			title={`Couldn't load ${what}`}
			description={formatError(error) || "The server did not answer."}
			action={
				onRetry ? (
					<Button variant="outline" size="sm" onClick={onRetry}>
						Try again
					</Button>
				) : undefined
			}
		/>
	);
}
