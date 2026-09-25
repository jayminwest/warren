import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "react-router-dom";
import { projectsApi } from "@/api/client.ts";
import type {
	DefaultsConfig,
	RunTriggerResponse,
	TriggerSummary,
	WarrenConfigResponse,
} from "@/api/types.ts";
import { OperatorOnly } from "@/components/operator-only.tsx";
import { Button, buttonVariants } from "@/components/ui/button.tsx";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import { StatusBadge } from "@/components/ui/status.tsx";
import { formatError } from "@/lib/format-error.ts";
import { relativeTime } from "@/lib/utils.ts";
import { formatCostUsd } from "@/pages/run-detail-format.ts";
import { ListError } from "@/pages/runs/list-error.tsx";

/**
 * The project inspector's main-column panels (warren-8375, migrated to
 * Card in warren-9474): dispatch defaults, triggers and ready plans.
 */

const FILE_META = "font-mono";

/* --------------------------------------------------------------------- */
/* Dispatch defaults                                                      */
/* --------------------------------------------------------------------- */

export function DispatchDefaultsPanel({
	query,
	isLoading,
	error,
	onRetry,
}: {
	query: WarrenConfigResponse | undefined;
	isLoading: boolean;
	error: unknown;
	onRetry?: () => void;
}) {
	return (
		<Card className="self-stretch" aria-label="Dispatch defaults">
			<CardHeader
				title="Dispatch defaults"
				meta={<span className={FILE_META}>{query?.sourceFile ?? ".warren/config.yaml"}</span>}
				actions={<DefaultsBadge query={query} />}
			/>
			<DefaultsBody query={query} isLoading={isLoading} error={error} onRetry={onRetry} />
		</Card>
	);
}

function DefaultsBadge({ query }: { query: WarrenConfigResponse | undefined }) {
	if (query === undefined) return null;
	const n = query.errors?.length ?? 0;
	if (n > 0) return <StatusBadge state="failed" label={`${n} ${n === 1 ? "error" : "errors"}`} />;
	return query.defaults !== null ? <StatusBadge state="succeeded" label="Valid" /> : null;
}

function DefaultsBody({
	query,
	isLoading,
	error,
	onRetry,
}: {
	query: WarrenConfigResponse | undefined;
	isLoading: boolean;
	error: unknown;
	onRetry?: () => void;
}) {
	if (isLoading) return <SkeletonRows rows={3} />;
	if (error !== null && error !== undefined) {
		return <ListError what="the project config" error={error} onRetry={onRetry} />;
	}
	if (query === undefined) return null;
	if (query.defaults === null) {
		return (
			<EmptyRow
				text={
					(query.errors?.length ?? 0) > 0
						? "The config file is missing or failed to load."
						: "No .warren/config.yaml in the repository, so runs use the agent and server defaults."
				}
			/>
		);
	}
	return <DefaultsGrid defaults={query.defaults} />;
}

/** Human label, config key, rendered value, and whether the value is an identifier. */
function defaultsEntries(d: DefaultsConfig): Array<[string, string, string | undefined, boolean]> {
	return [
		["Agent", "defaultRole", d.defaultRole, true],
		["Model", "defaultModel", d.defaultModel, true],
		["Provider", "defaultProvider", d.defaultProvider, true],
		["Branch", "defaultBranch", d.defaultBranch, true],
		["Run branch prefix", "runBranchPrefix", d.runBranchPrefix, true],
		[
			"Cost cap per run",
			"maxCostUsd",
			d.maxCostUsd !== undefined ? formatCostUsd(d.maxCostUsd) : undefined,
			false,
		],
		["Quality gate", "qualityGate", d.qualityGate, true],
		["Prompt", "defaultPrompt", d.defaultPrompt, false],
	];
}

/** Two-column key/value grid over the defaults that are actually set. */
function DefaultsGrid({ defaults }: { defaults: DefaultsConfig }) {
	const set = defaultsEntries(defaults).filter((e) => e[2] !== undefined);
	if (set.length === 0) {
		return <EmptyRow text="The config file is present but sets no defaults." />;
	}
	return (
		<dl className="grid gap-x-8 gap-y-2.5 px-4 py-3.5 md:grid-cols-2">
			{set.map(([label, key, value, mono]) => (
				<div
					key={key}
					className="flex min-w-0 items-baseline justify-between gap-4 md:justify-start"
				>
					<dt className="w-36 shrink-0 text-sm text-(--color-text-3)" title={key}>
						{label}
					</dt>
					<dd
						title={value}
						className={
							mono
								? "min-w-0 truncate font-mono text-xs text-(--color-text)"
								: "min-w-0 truncate text-sm text-(--color-text) tabular-nums"
						}
					>
						{value}
					</dd>
				</div>
			))}
		</dl>
	);
}

/* --------------------------------------------------------------------- */
/* Triggers                                                               */
/* --------------------------------------------------------------------- */

export function TriggersPanel({ projectId }: { projectId: string }) {
	const navigate = useNavigate();
	const qc = useQueryClient();

	const triggers = useQuery({
		queryKey: ["projects", projectId, "triggers"],
		queryFn: ({ signal }) => projectsApi.triggers(projectId, signal),
		enabled: projectId.length > 0,
	});

	const runNow = useMutation({
		mutationFn: (triggerId: string) => projectsApi.runTrigger(projectId, triggerId),
		onSuccess: (data: RunTriggerResponse) => {
			qc.invalidateQueries({ queryKey: ["projects", projectId, "triggers"] });
			qc.invalidateQueries({ queryKey: ["runs"] });
			navigate(`/runs/${encodeURIComponent(data.run.id)}`);
		},
	});

	const list = triggers.data?.triggers ?? [];
	const stateOf = (t: TriggerSummary) => ({
		isRunning: runNow.isPending && runNow.variables === t.id,
		onRunNow: () => runNow.mutate(t.id),
	});

	return (
		<Card className="self-stretch" aria-label="Triggers">
			<CardHeader
				title="Triggers"
				meta={<span className={FILE_META}>.warren/triggers.yaml</span>}
			/>
			{triggers.isLoading ? (
				<SkeletonRows rows={2} />
			) : triggers.isError ? (
				<ListError what="triggers" error={triggers.error} onRetry={() => void triggers.refetch()} />
			) : list.length === 0 ? (
				<EmptyRow text="No scheduled triggers. Add one in .warren/triggers.yaml in the repository." />
			) : (
				<>
					<InventoryCardList>
						{list.map((t) => (
							<TriggerCard key={t.id} trigger={t} {...stateOf(t)} />
						))}
					</InventoryCardList>
					<ul className="hidden divide-y divide-(--color-border) md:block">
						{list.map((t) => (
							<TriggerRow
								key={t.id}
								trigger={t}
								{...stateOf(t)}
								runError={
									runNow.isError && runNow.variables === t.id ? formatError(runNow.error) : null
								}
							/>
						))}
					</ul>
				</>
			)}
		</Card>
	);
}

function promptOf(trigger: TriggerSummary): string {
	return trigger.parseError !== null
		? `Schedule doesn't parse: ${trigger.parseError}`
		: (trigger.prompt ?? "—");
}

function lastFiredOf(trigger: TriggerSummary): string {
	return trigger.lastFiredAt !== null
		? `Fired ${relativeTime(trigger.lastFiredAt)}`
		: "Never fired";
}

function RunNowButton({ isRunning, onRunNow }: { isRunning: boolean; onRunNow: () => void }) {
	// `POST /projects/:id/triggers/:tid/run` is `dispatch`-gated.
	return (
		<OperatorOnly>
			<Button variant="outline" size="sm" onClick={onRunNow} disabled={isRunning}>
				{isRunning ? "Dispatching…" : "Run now"}
			</Button>
		</OperatorOnly>
	);
}

/* The phone arm of one trigger row (warren-89aa). */
function TriggerCard({
	trigger,
	isRunning,
	onRunNow,
}: {
	trigger: TriggerSummary;
	isRunning: boolean;
	onRunNow: () => void;
}) {
	return (
		<InventoryRowCard
			tone={trigger.parseError !== null ? "warning" : "neutral"}
			title={trigger.id}
			subline={`${trigger.cron} · ${trigger.timezone ?? "UTC"}${
				trigger.seed !== undefined ? ` · ${trigger.seed}` : ""
			}`}
			figures={
				<>
					<CardFigure value={trigger.role} />
					<CardFigureNote value={lastFiredOf(trigger)} />
				</>
			}
			meta={promptOf(trigger)}
		>
			<RunNowButton isRunning={isRunning} onRunNow={onRunNow} />
		</InventoryRowCard>
	);
}

function TriggerRow({
	trigger,
	isRunning,
	runError,
	onRunNow,
}: {
	trigger: TriggerSummary;
	isRunning: boolean;
	runError: string | null;
	onRunNow: () => void;
}) {
	return (
		<li className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2.5">
			<div className="flex w-44 shrink-0 flex-col">
				<span className="truncate font-mono text-sm text-(--color-text)">{trigger.id}</span>
				<span className="truncate font-mono text-2xs text-(--color-text-3)">
					{trigger.cron} · {trigger.timezone ?? "UTC"}
				</span>
			</div>
			<span className="w-28 shrink-0 truncate text-sm text-(--color-text-2)">{trigger.role}</span>
			<span
				className={
					trigger.parseError !== null
						? "min-w-0 flex-1 truncate text-sm text-(--color-warning)"
						: "min-w-0 flex-1 truncate text-sm text-(--color-text-3)"
				}
				title={promptOf(trigger)}
			>
				{promptOf(trigger)}
			</span>
			<span
				className="shrink-0 text-xs text-(--color-text-3)"
				title={trigger.lastFiredAt ?? undefined}
			>
				{trigger.lastRunId !== null ? (
					<Link
						to={`/runs/${encodeURIComponent(trigger.lastRunId)}`}
						className="underline-offset-2 hover:text-(--color-text-2) hover:underline"
					>
						{lastFiredOf(trigger)}
					</Link>
				) : (
					lastFiredOf(trigger)
				)}
			</span>
			<RunNowButton isRunning={isRunning} onRunNow={onRunNow} />
			{runError !== null ? (
				<span className="w-full text-xs text-(--color-danger)">Couldn't dispatch: {runError}</span>
			) : null}
		</li>
	);
}

/* --------------------------------------------------------------------- */
/* Ready plans                                                            */
/* --------------------------------------------------------------------- */

function openChildren(n: number): string {
	return `${n} open ${n === 1 ? "child" : "children"}`;
}

function DispatchPlanLink() {
	return (
		<OperatorOnly>
			<Link to="/dispatch/plan" className={buttonVariants({ variant: "outline", size: "sm" })}>
				Dispatch
			</Link>
		</OperatorOnly>
	);
}

export function ReadyPlansPanel({ projectId }: { projectId: string }) {
	const readyPlans = useQuery({
		queryKey: ["ready-plans", projectId],
		queryFn: ({ signal }) => projectsApi.readyPlans(projectId, signal),
		enabled: projectId.length > 0,
		// No stream event covers the tracker, so a slow poll keeps it fresh.
		refetchInterval: 60_000,
	});

	const plans = readyPlans.data?.plans ?? [];

	return (
		<Card className="self-stretch" aria-label="Ready plans">
			<CardHeader title="Ready plans" meta="Approved plans with unblocked work" />
			{readyPlans.isLoading ? (
				<SkeletonRows rows={2} />
			) : readyPlans.isError ? (
				<ListError
					what="ready plans"
					error={readyPlans.error}
					onRetry={() => void readyPlans.refetch()}
				/>
			) : plans.length === 0 ? (
				<EmptyRow text="No approved plans have open work waiting to be dispatched." />
			) : (
				<>
					<InventoryCardList>
						{plans.map((plan) => (
							<InventoryRowCard
								key={plan.id}
								tone="info"
								title={plan.id}
								subline={plan.name ?? plan.status}
								figures={<CardFigureNote value={openChildren(plan.openChildCount)} />}
							>
								<DispatchPlanLink />
							</InventoryRowCard>
						))}
					</InventoryCardList>
					<ul className="hidden divide-y divide-(--color-border) md:block">
						{plans.map((plan) => (
							<li key={plan.id} className="flex items-center gap-4 px-4 py-2.5">
								<span className="w-20 shrink-0 font-mono text-sm text-(--color-text-2)">
									{plan.id}
								</span>
								<span className="min-w-0 flex-1 truncate text-sm text-(--color-text)">
									{plan.name ?? plan.status}
								</span>
								<span className="shrink-0 text-xs text-(--color-text-3) tabular-nums">
									{openChildren(plan.openChildCount)}
								</span>
								<DispatchPlanLink />
							</li>
						))}
					</ul>
				</>
			)}
		</Card>
	);
}

export function EmptyRow({ text }: { text: string }) {
	return <p className="px-4 py-3.5 text-sm text-(--color-text-3)">{text}</p>;
}
