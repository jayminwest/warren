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
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { relativeTime } from "@/lib/utils.ts";

/**
 * The project inspector's panels (warren-8375 / pl-7e38 step 10),
 * split from `project-detail.tsx` for the 500-line budget (check:size).
 *
 * Shared chrome: bordered surface cards with a 41px header — title,
 * quiet mono metadata, and a right-aligned mono note. Token variables
 * only, so the light theme swaps automatically.
 */

const PANEL =
	"flex min-w-0 flex-col rounded-[4px] border border-(--color-border) bg-(--color-surface)";
const PANEL_HEAD =
	"flex h-[41px] shrink-0 items-center gap-2.5 border-b border-b-(--color-border) px-3.5";
const PANEL_TITLE = "text-[12px] leading-4 font-semibold text-(--color-text)";
const PANEL_META = "font-mono text-[9px] leading-3 text-(--color-text-3)";
const HEAD_NOTE = "font-mono text-[9px] leading-3 tracking-[0.05em] text-(--color-text-3)";

/* --------------------------------------------------------------------- */
/* Dispatch defaults                                                      */
/* --------------------------------------------------------------------- */

export function DispatchDefaultsPanel({
	query,
	isLoading,
	error,
}: {
	query: WarrenConfigResponse | undefined;
	isLoading: boolean;
	error: unknown;
}) {
	const errors = query?.errors ?? [];
	return (
		<section className={PANEL} aria-label="Dispatch defaults">
			<div className={PANEL_HEAD}>
				<h2 className={PANEL_TITLE}>Dispatch defaults</h2>
				<span className={PANEL_META}>{query?.sourceFile ?? ".warren/config.yaml"}</span>
				<div className="min-w-0 flex-1" />
				{errors.length > 0 ? (
					<span className={`${HEAD_NOTE} text-(--color-danger)`}>{errors.length} ERRORS</span>
				) : (
					<span className={HEAD_NOTE}>VALID</span>
				)}
			</div>
			<div className="px-3.5 py-3">
				<DefaultsBody
					isError={error !== null && error !== undefined}
					error={error}
					query={query}
					isLoading={isLoading}
				/>
			</div>
		</section>
	);
}

function DefaultsBody({
	query,
	isLoading,
	isError,
	error,
}: {
	query: WarrenConfigResponse | undefined;
	isLoading: boolean;
	isError: boolean;
	error: unknown;
}) {
	const defaults = query?.defaults ?? null;
	const errors = query?.errors ?? [];
	if (isLoading) {
		return <Spinner label="Loading dispatch defaults" />;
	}
	if (isError) {
		return (
			<Alert variant="danger" title="Failed to load warren config">
				{formatError(error)}
			</Alert>
		);
	}
	if (query === undefined) return null;
	if (defaults === null) {
		return (
			<EmptyRow
				text={
					errors.length > 0
						? "Not present, or the last load failed â see the error count above."
						: "No .warren/config.yaml in the clone; dispatch uses agent and server defaults."
				}
			/>
		);
	}
	return <DefaultsGrid defaults={defaults} />;
}

/** Two-column key/value grid over the defaults that are actually set. */
function DefaultsGrid({ defaults }: { defaults: DefaultsConfig }) {
	const entries: Array<[string, string | undefined]> = [
		["defaultRole", defaults.defaultRole],
		["defaultModel", defaults.defaultModel],
		["defaultProvider", defaults.defaultProvider],
		["defaultBranch", defaults.defaultBranch],
		["runBranchPrefix", defaults.runBranchPrefix],
		["maxCostUsd", defaults.maxCostUsd?.toFixed(2)],
		["qualityGate", defaults.qualityGate],
		["defaultPrompt", defaults.defaultPrompt],
	];
	const set = entries.filter((entry): entry is [string, string] => entry[1] !== undefined);
	if (set.length === 0) {
		return <EmptyRow text="File is present but sets no overrides." />;
	}
	const midpoint = Math.ceil(set.length / 2);
	return (
		<div className="flex flex-col gap-4 md:flex-row">
			<DefaultsColumn entries={set.slice(0, midpoint)} />
			<DefaultsColumn entries={set.slice(midpoint)} />
		</div>
	);
}

function DefaultsColumn({ entries }: { entries: Array<[string, string]> }) {
	return (
		<dl className="flex min-w-0 flex-1 flex-col gap-2.5">
			{entries.map(([key, value]) => (
				<div key={key} className="flex items-center gap-2.5">
					<dt className="max-md:w-[110px] md:w-[120px] shrink-0 text-[11px] leading-[14px] text-(--color-text-3)">
						{key}
					</dt>
					<dd className="min-w-0 truncate font-mono text-[10px] leading-3 max-md:flex-1 max-md:text-right text-(--color-text-2)">
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

	return (
		<section className={PANEL} aria-label="Triggers">
			<div className={PANEL_HEAD}>
				<h2 className={PANEL_TITLE}>Triggers</h2>
				<span className={PANEL_META}>.warren/triggers.yaml</span>
				<div className="min-w-0 flex-1" />
			</div>
			{triggers.isLoading ? (
				<div className="px-3.5 py-3">
					<Spinner label="Loading triggers" />
				</div>
			) : triggers.isError ? (
				<div className="px-3.5 py-3">
					<Alert variant="danger" title="Failed to load triggers">
						{formatError(triggers.error)}
					</Alert>
				</div>
			) : list.length === 0 ? (
				<EmptyRow text="No triggers configured — edit .warren/triggers.yaml on the project repo to add one." />
			) : (
				<>
					{/* No mobile artboard for project-detail (warren-89aa): the
					 * trigger rows degrade to the shared InventoryRowCard pattern
					 * below md; the table-style rows above md are untouched. */}
					<InventoryCardList>
						{list.map((t) => (
							<TriggerCard
								key={t.id}
								trigger={t}
								isRunning={runNow.isPending && runNow.variables === t.id}
								onRunNow={() => runNow.mutate(t.id)}
							/>
						))}
					</InventoryCardList>
					<div className="hidden md:block">
						{list.map((t, i) => (
							<TriggerRow
								key={t.id}
								trigger={t}
								last={i === list.length - 1}
								isRunning={runNow.isPending && runNow.variables === t.id}
								runError={
									runNow.isError && runNow.variables === t.id ? formatError(runNow.error) : null
								}
								onRunNow={() => runNow.mutate(t.id)}
							/>
						))}
					</div>
				</>
			)}
		</section>
	);
}

/* The mobile arm of one trigger row (warren-89aa): dot-only state
 * (triggers carry no run-state), role + last-fired as the trailing
 * figures, prompt/parse-error as the meta line. */
function TriggerCard({
	trigger,
	isRunning,
	onRunNow,
}: {
	trigger: TriggerSummary;
	isRunning: boolean;
	onRunNow: () => void;
}) {
	const lastFired =
		trigger.lastFiredAt !== null
			? `last fired ${relativeTime(trigger.lastFiredAt)}`
			: "never fired";
	const prompt =
		trigger.parseError !== null
			? `cron parse error: ${trigger.parseError}`
			: (trigger.prompt ?? "—");
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
					<CardFigureNote value={lastFired} />
				</>
			}
			meta={prompt}
		>
			{/* `POST /projects/:id/triggers/:tid/run` is `dispatch`-gated. */}
			<OperatorOnly>
				<Button
					variant="outline"
					size="sm"
					className="h-6 px-2.5 text-[10px]"
					onClick={onRunNow}
					disabled={isRunning}
				>
					{isRunning ? "Dispatching…" : "Run now"}
				</Button>
			</OperatorOnly>
		</InventoryRowCard>
	);
}

function TriggerRow({
	trigger,
	last,
	isRunning,
	runError,
	onRunNow,
}: {
	trigger: TriggerSummary;
	last: boolean;
	isRunning: boolean;
	runError: string | null;
	onRunNow: () => void;
}) {
	return (
		<div
			className={`flex min-h-[49px] flex-wrap items-center gap-3 px-3.5 py-1.5 ${
				last ? "" : "border-b border-b-(--color-border)"
			}`}
		>
			<div className="flex w-[180px] shrink-0 flex-col gap-0.5">
				<span className="font-mono text-[10px] leading-3 text-(--color-text)">{trigger.id}</span>
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
					{trigger.cron} {trigger.timezone ?? "UTC"}
				</span>
			</div>
			<span className="w-[110px] shrink-0 font-mono text-[10px] leading-3 text-(--color-text-2)">
				{trigger.role}
			</span>
			{trigger.seed !== undefined ? (
				<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">{trigger.seed}</span>
			) : null}
			<span className="min-w-0 flex-1 truncate text-[10px] leading-[14px] text-(--color-text-3)">
				{trigger.parseError !== null
					? `cron parse error: ${trigger.parseError}`
					: (trigger.prompt ?? "—")}
			</span>
			<span
				className="shrink-0 font-mono text-[9px] leading-3 text-(--color-text-3)"
				title={trigger.lastFiredAt ?? "never fired"}
			>
				{trigger.lastRunId !== null ? (
					<Link
						to={`/runs/${encodeURIComponent(trigger.lastRunId)}`}
						className="underline-offset-2 hover:underline"
					>
						last fired {relativeTime(trigger.lastFiredAt)}
					</Link>
				) : trigger.lastFiredAt !== null ? (
					`last fired ${relativeTime(trigger.lastFiredAt)}`
				) : (
					"never fired"
				)}
			</span>
			{/* `POST /projects/:id/triggers/:tid/run` is `dispatch`-gated. */}
			<OperatorOnly>
				<Button
					variant="outline"
					size="sm"
					className="h-6 px-2.5 text-[10px]"
					onClick={onRunNow}
					disabled={isRunning}
				>
					{isRunning ? "Dispatching…" : "Run now"}
				</Button>
			</OperatorOnly>
			{runError !== null ? (
				<span className="w-full font-mono text-[9px] leading-3 text-(--color-danger)">
					{runError}
				</span>
			) : null}
		</div>
	);
}

/* --------------------------------------------------------------------- */
/* Ready plans                                                            */
/* --------------------------------------------------------------------- */

export function ReadyPlansPanel({ projectId }: { projectId: string }) {
	const readyPlans = useQuery({
		queryKey: ["ready-plans", projectId],
		queryFn: ({ signal }) => projectsApi.readyPlans(projectId, signal),
		enabled: projectId.length > 0,
		// Matches ReadyPlansView's stream + slow-fallback cadence (warren-f566).
		refetchInterval: 45_000,
	});

	const plans = readyPlans.data?.plans ?? [];

	return (
		<section className={PANEL} aria-label="Ready plans">
			<div className={PANEL_HEAD}>
				<h2 className={PANEL_TITLE}>Ready plans</h2>
				<div className="min-w-0 flex-1" />
				<span className={HEAD_NOTE}>UNBLOCKED ONLY</span>
			</div>
			{readyPlans.isLoading ? (
				<div className="px-3.5 py-3">
					<Spinner label="Loading ready plans" />
				</div>
			) : readyPlans.isError ? (
				<div className="px-3.5 py-3">
					<Alert variant="danger" title="Failed to load ready plans">
						{formatError(readyPlans.error)}
					</Alert>
				</div>
			) : plans.length === 0 ? (
				<EmptyRow text="No approved plans with open, undispatched children right now." />
			) : (
				<>
					{/* Mobile arm (warren-89aa): ready-plan rows degrade to the
					 * shared InventoryRowCard pattern below md. */}
					<InventoryCardList>
						{plans.map((plan) => (
							<InventoryRowCard
								key={plan.id}
								tone="info"
								stateLabel="ready"
								title={plan.id}
								subline={plan.name ?? plan.status}
								figures={
									<CardFigure
										value={`${plan.openChildCount} open child${
											plan.openChildCount === 1 ? "" : "ren"
										}`}
									/>
								}
							>
								<OperatorOnly>
									<Link to="/dispatch/plan" className="shrink-0">
										<Button size="sm">Dispatch plan</Button>
									</Link>
								</OperatorOnly>
							</InventoryRowCard>
						))}
					</InventoryCardList>
					<div className="hidden md:block">
						{plans.map((plan, i) => (
							<div
								key={plan.id}
								className={`flex min-h-[49px] flex-wrap items-center gap-3 px-3.5 py-1.5 ${
									i === plans.length - 1 ? "" : "border-b border-b-(--color-border)"
								}`}
							>
								<span className="w-[70px] shrink-0 font-mono text-[10px] leading-3 text-(--color-primary)">
									{plan.id}
								</span>
								<span className="min-w-0 flex-1 truncate text-[11px] leading-[14px] text-(--color-text-2)">
									{plan.name ?? plan.status}
								</span>
								<span className="shrink-0 font-mono text-[9px] leading-3 text-(--color-text-3)">
									{plan.openChildCount} open child{plan.openChildCount === 1 ? "" : "ren"}
								</span>
								<OperatorOnly>
									<Link to="/dispatch/plan" className="shrink-0">
										<Button size="sm">Dispatch plan</Button>
									</Link>
								</OperatorOnly>
							</div>
						))}
					</div>
				</>
			)}
		</section>
	);
}

export function EmptyRow({ text }: { text: string }) {
	return <p className="px-3.5 py-3 text-[11px] leading-4 text-(--color-text-3)">{text}</p>;
}
