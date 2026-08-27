import type { RunRow } from "@/api/types.ts";

/**
 * Cost-basis marker (warren-f3c3 / pl-26f3 step 5). A run whose anthropic
 * credential was `CLAUDE_CODE_OAUTH_TOKEN` (subscription auth) renders its
 * `costUsd` as an API-priced ESTIMATE — this pill is the honesty marker so
 * the number never reads as a bill. Renders nothing for `api` runs.
 */
export function CostBasisNote({ run }: { run: RunRow }) {
	if (run.costBasis !== "subscription_estimate") return null;
	return (
		<span
			title="Subscription-authenticated run: cost is an API-priced estimate of the same usage, not a bill"
			className="rounded-(--radius-sm) border border-(--color-border) bg-(--color-surface) px-1 py-px font-mono text-[9px] leading-3 text-(--color-text-3)"
		>
			est. (subscription)
		</span>
	);
}
