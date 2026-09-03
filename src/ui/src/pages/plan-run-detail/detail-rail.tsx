import type { PlanRunDetailResponse, RunRow } from "@/api/types.ts";
import { formatTimestamp } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";

/**
 * The right rail of the walk inspector (warren-2520): the source plan
 * definition, the prompt template every child was dispatched under, and
 * the delivered PRs pulled off the child runs. Read-only on every
 * capability level — the spectator projection carries the same rows.
 */

export function DetailRail({
	detail,
	projectLabel,
	cost,
}: {
	detail: PlanRunDetailResponse;
	projectLabel: string;
	cost: { sum: number; priced: number; total: number };
}) {
	const { planRun, children, runs } = detail;
	const delivered = collectDeliveredPrs(children, runs);
	const ref = refLine(planRun.ref, runs);

	return (
		<aside className="flex w-full shrink-0 flex-col gap-4 lg:w-[336px]">
			<RailCard title="Plan definition" meta="SOURCE PLAN">
				<Facts
					rows={[
						{
							label: "plan",
							value: planRun.planId ?? "issues list",
							accent: planRun.planId !== null,
						},
						{ label: "project", value: projectLabel },
						...(ref !== null ? [{ label: "ref", value: ref }] : []),
						{ label: "agent", value: planRun.agentName },
						{
							label: "model",
							value: planRun.modelOverride ?? "—",
							hint: planRun.modelOverride == null ? "agent default" : undefined,
						},
						...(planRun.providerOverride != null
							? [{ label: "provider", value: planRun.providerOverride }]
							: []),
						{
							label: "per-child cap",
							value: formatCostUsd(planRun.maxCostUsd),
							hint:
								planRun.maxCostUsd == null
									? "no cap declared"
									: cost.priced === 0
										? "no child cost recorded yet"
										: `spent ${formatCostUsd(cost.sum)} across ${cost.priced} of ${cost.total} priced child runs`,
						},
						{ label: "dispatcher", value: planRun.dispatcherHandle ?? "—" },
						{ label: "trigger", value: planRun.trigger },
						{ label: "started", value: formatTimestamp(planRun.startedAt) },
						{ label: "ended", value: formatTimestamp(planRun.endedAt) },
					]}
				/>
			</RailCard>

			{planRun.promptTemplate !== undefined ? (
				<RailCard title="Prompt template" meta={`${children.length} CHILDREN`}>
					<pre className="max-h-[220px] overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] leading-4 text-(--color-text-2)">
						{planRun.promptTemplate}
					</pre>
				</RailCard>
			) : null}

			<RailCard
				title="Delivery"
				meta={`${delivered.length} ${delivered.length === 1 ? "PR" : "PRS"}`}
			>
				{delivered.length === 0 ? (
					<p className="font-mono text-[10px] leading-3 text-(--color-text-3)">
						No PRs yet — nothing has cleared reap.
					</p>
				) : (
					<div className="flex flex-col gap-2.5">
						{delivered.map((pr) => (
							<div key={pr.url} className="flex items-center gap-2.5">
								<a
									href={pr.url}
									target="_blank"
									rel="noreferrer noopener"
									className="min-w-0 truncate font-mono text-[10px] leading-3 text-(--color-primary) underline-offset-2 hover:underline"
								>
									{pr.label}
								</a>
								<div className="min-w-0 flex-1" />
								<span
									className="shrink-0 font-mono text-[9px] leading-3"
									style={{ color: pr.color }}
								>
									{pr.stateLabel}
								</span>
							</div>
						))}
					</div>
				)}
			</RailCard>
		</aside>
	);
}

function RailCard({
	title,
	meta,
	children,
}: {
	title: string;
	meta: string;
	children: React.ReactNode;
}) {
	return (
		<section className="flex flex-col rounded border border-(--color-border) bg-(--color-surface)">
			<header className="flex h-[41px] shrink-0 items-center border-b border-(--color-border) px-3.5">
				<h2 className="text-[12px] leading-4 font-semibold text-(--color-text)">{title}</h2>
				<div className="min-w-0 flex-1" />
				<span className="font-mono text-[9px] leading-3 tracking-[0.05em] text-(--color-text-3)">
					{meta}
				</span>
			</header>
			<div className="flex flex-col gap-2.5 px-3.5 py-3">{children}</div>
		</section>
	);
}

function Facts({
	rows,
}: {
	rows: readonly {
		label: string;
		value: string;
		accent?: boolean;
		hint?: string;
	}[];
}) {
	return (
		<div className="flex flex-col gap-2.5">
			{rows.map((r) => (
				<div key={r.label} className="flex items-baseline gap-2.5">
					<span className="w-[88px] shrink-0 text-[11px] leading-[14px] text-(--color-text-3)">
						{r.label}
					</span>
					<span
						className={`min-w-0 truncate font-mono text-[10px] leading-3 ${
							r.accent ? "text-(--color-primary)" : "text-(--color-text-2)"
						}`}
						title={r.hint ?? (r.value === "—" ? undefined : r.value)}
					>
						{r.value}
					</span>
					{r.hint !== undefined ? (
						<span className="truncate font-mono text-[9px] leading-3 text-(--color-text-3)">
							{r.hint}
						</span>
					) : null}
				</div>
			))}
		</div>
	);
}

interface DeliveredPr {
	url: string;
	label: string;
	stateLabel: string;
	color: string;
}

/**
 * The Delivery card: one entry per child run that reaped a PR, in walk
 * order. Labels carry only facts the merge watcher reported — `merged`,
 * `open`, `closed` — never a fabricated check status.
 */
function collectDeliveredPrs(
	children: PlanRunDetailResponse["children"],
	runs: RunRow[],
): DeliveredPr[] {
	const byId = new Map<string, RunRow>();
	for (const r of runs) byId.set(r.id, r);
	const out: DeliveredPr[] = [];
	for (const c of children) {
		const run = c.runId !== null ? byId.get(c.runId) : undefined;
		const url = run?.prUrl;
		if (url === undefined || url === null) continue;
		out.push({
			url,
			label: prLabel(url),
			stateLabel: prStateLabel(c, run),
			color: c.state === "merged" ? "var(--color-success)" : "var(--color-warning)",
		});
	}
	return out;
}

/** `PR #612` from the forge URL tail; the raw URL when it doesn't parse. */
function prLabel(url: string): string {
	const num = url.match(/\/pull\/(\d+)$/);
	return num === null ? url : `PR #${num[1]}`;
}

/** Merge-watcher facts only: `merged <ts>`, else the forge PR lifecycle. */
function prStateLabel(
	child: PlanRunDetailResponse["children"][number],
	run: RunRow | undefined,
): string {
	if (child.state === "merged") {
		return child.prMergedAt !== null ? `merged ${formatTimestamp(child.prMergedAt)}` : "merged";
	}
	return run?.prState ?? "open";
}

/** `main @ 3f9a1c2`-style ref line from the dispatch ref + a child's base pin. */
function refLine(ref: string | null, runs: readonly RunRow[]): string | null {
	const base = runs.find((r) => r.baseCommit !== null)?.baseCommit;
	if (base !== undefined && base !== null) {
		const short = base.length > 7 ? base.slice(0, 7) : base;
		return `${ref ?? "default"} @ ${short}`;
	}
	return ref;
}
