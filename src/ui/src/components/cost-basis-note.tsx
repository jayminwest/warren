import type { RunRow } from "@/api/types.ts";
import { Tag } from "@/components/ui/tag.tsx";

/**
 * Cost-basis marker (warren-f3c3, migrated in warren-9474). A run
 * authenticated with a subscription token reports its cost as an
 * API-priced estimate; this tag says so, so the number never reads as a
 * bill. Renders nothing for API-billed runs.
 */
export function CostBasisNote({ run }: { run: RunRow }) {
	if (run.costBasis !== "subscription_estimate") return null;
	return (
		<Tag title="Subscription run: the cost is an estimate at API prices, not a bill">Estimate</Tag>
	);
}
