import type * as React from "react";
import type { PlanRunDetailResponse, RunRow } from "@/api/types.ts";
import { Card, CardBody, CardHeader } from "@/components/ui/card.tsx";
import { PrChip } from "@/components/ui/status.tsx";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { formatTrigger } from "../run-detail/run-detail-format.ts";
import { Fact, FactCard } from "../run-detail/side-panels.tsx";

/**
 * The right rail of the plan run inspector (warren-2520, migrated in
 * warren-9474): what the walk was dispatched with, what it has spent, the
 * PRs the children delivered, and the prompt template every child ran
 * under. Read-only at every capability level — the spectator projection
 * carries the same rows, minus the redacted fields.
 */

type CostSummary = { sum: number; priced: number; total: number };

function Hint({ children }: { children: React.ReactNode }) {
	return <span className="text-(--color-text-3)"> · {children}</span>;
}

function capHint(cap: number | null | undefined, cost: CostSummary): string {
	if (cap == null) return "No cap";
	if (cost.priced === 0) return "Nothing spent yet";
	return `${formatCostUsd(cost.sum)} spent across ${cost.priced} of ${cost.total} runs`;
}

/** `main @ 3f9a1c2` from the dispatch ref plus a child's base pin. */
function refLine(ref: string | null, runs: readonly RunRow[]): string | null {
	const base = runs.find((r) => r.baseCommit !== null)?.baseCommit;
	if (base != null) return `${ref ?? "default"} @ ${base.slice(0, 7)}`;
	return ref;
}

function DefinitionCard({
	detail,
	projectLabel,
	cost,
}: {
	detail: PlanRunDetailResponse;
	projectLabel: string;
	cost: CostSummary;
}) {
	const { planRun, runs } = detail;
	const ref = refLine(planRun.ref, runs);
	return (
		<FactCard title="Plan definition">
			<Fact label="Plan" mono={planRun.planId !== null}>
				{planRun.planId ?? "Issue list"}
			</Fact>
			<Fact label="Project">{projectLabel}</Fact>
			{ref !== null ? (
				<Fact label="Ref" mono>
					{ref}
				</Fact>
			) : null}
			<Fact label="Agent">{planRun.agentName}</Fact>
			<Fact label="Model">{planRun.modelOverride ?? "Agent default"}</Fact>
			{planRun.providerOverride != null ? (
				<Fact label="Provider">{planRun.providerOverride}</Fact>
			) : null}
			<Fact label="Per-child cap">
				{planRun.maxCostUsd != null ? formatCostUsd(planRun.maxCostUsd) : "None"}
				{planRun.maxCostUsd != null ? <Hint>{capHint(planRun.maxCostUsd, cost)}</Hint> : null}
			</Fact>
			<Fact label="Trigger">{formatTrigger(planRun.trigger)}</Fact>
			{planRun.dispatcherHandle !== undefined ? (
				<Fact label="Dispatched by">{planRun.dispatcherHandle}</Fact>
			) : null}
			<Fact label="Started">{formatTimestamp(planRun.startedAt)}</Fact>
			{planRun.endedAt !== null ? (
				<Fact label="Ended">{formatTimestamp(planRun.endedAt)}</Fact>
			) : null}
		</FactCard>
	);
}

interface DeliveredPr {
	url: string;
	seedId: string;
	lifecycle: string | null;
	note: string | null;
}

/**
 * One entry per child run that opened a PR, in walk order. Only facts the
 * merge watcher reported — merged (with when), or the forge lifecycle.
 */
function collectDeliveredPrs(
	children: PlanRunDetailResponse["children"],
	runs: RunRow[],
): DeliveredPr[] {
	const byId = new Map(runs.map((r) => [r.id, r]));
	const out: DeliveredPr[] = [];
	for (const c of children) {
		const run = c.runId !== null ? byId.get(c.runId) : undefined;
		const url = run?.prUrl;
		if (url == null) continue;
		const merged = c.state === "merged";
		out.push({
			url,
			seedId: c.seedId,
			lifecycle: merged ? "merged" : (run?.prState ?? null),
			note: merged && c.prMergedAt !== null ? relativeTime(c.prMergedAt) : null,
		});
	}
	return out;
}

function DeliveryCard({ detail }: { detail: PlanRunDetailResponse }) {
	const delivered = collectDeliveredPrs(detail.children, detail.runs);
	return (
		<Card className="self-stretch">
			<CardHeader
				title="Delivery"
				meta={`${delivered.length} ${delivered.length === 1 ? "pull request" : "pull requests"}`}
			/>
			<CardBody className="py-3">
				{delivered.length === 0 ? (
					<p className="text-sm text-(--color-text-3)">
						No pull requests yet. Each child's PR appears here once its run finishes.
					</p>
				) : (
					<ul className="flex flex-col gap-2">
						{delivered.map((pr) => (
							<li key={pr.url} className="flex items-center gap-2.5">
								<PrChip url={pr.url} lifecycle={pr.lifecycle} />
								<span className="min-w-0 flex-1 truncate font-mono text-xs text-(--color-text-2)">
									{pr.seedId}
								</span>
								{pr.note !== null ? (
									<span className="shrink-0 text-xs text-(--color-text-3)">{pr.note}</span>
								) : null}
							</li>
						))}
					</ul>
				)}
			</CardBody>
		</Card>
	);
}

export function DetailRail({
	detail,
	projectLabel,
	cost,
}: {
	detail: PlanRunDetailResponse;
	projectLabel: string;
	cost: CostSummary;
}) {
	const template = detail.planRun.promptTemplate;
	return (
		<aside className="flex w-full shrink-0 flex-col gap-4 lg:w-84">
			<DefinitionCard detail={detail} projectLabel={projectLabel} cost={cost} />
			<DeliveryCard detail={detail} />
			{template !== undefined ? (
				<Card className="self-stretch">
					<CardHeader title="Prompt template" meta="Rendered once per child" />
					<CardBody>
						<p className="max-h-56 overflow-auto text-sm break-words whitespace-pre-wrap text-(--color-text-2)">
							{template}
						</p>
					</CardBody>
				</Card>
			) : null}
		</aside>
	);
}
