import { useQuery } from "@tanstack/react-query";
import { agentsApi } from "@/api/client.ts";
import type { AgentRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp } from "@/lib/utils.ts";

/**
 * Agents — the Direction C agent registry (warren-db84 / pl-7e38 step
 * 11), from `docs/ui-revamp/screens/agents.jsx`.
 *
 * One inventory table over `GET /agents`: the seven boot-seeded
 * builtins with read-only provenance. No summary cards, no mutating
 * affordances — the page is read-only for operators and spectators
 * alike, so it needs no capability gating beyond what the projection
 * already serves: a spectator's rows carry the same hoisted
 * `description` / `provider` / `model` / `source` fields
 * (warren-4f6c) minus the `renderedJson` envelope, which is where the
 * cost-cap cell reads from — it degrades to "—" rather than guessing.
 */

const CELL_MONO = "font-mono text-[10px] leading-3";
const CELL_MONO_MUTED = `${CELL_MONO} text-(--color-text-3)`;

export function AgentsPage() {
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: ({ signal }) => agentsApi.list({}, signal),
	});

	return (
		<div className="flex min-h-full flex-col gap-5 px-3.5 pt-[22px] pb-12 md:px-6">
			<div className="flex items-start gap-4 pb-1">
				<div className="flex min-w-0 flex-1 flex-col gap-[5px]">
					<h1 className="text-xl leading-6 font-semibold tracking-[-0.025em] text-(--color-text)">
						Agents
					</h1>
					<p className="text-[12px] leading-4 text-(--color-text-2)">
						Agents warren can dispatch runs with.
					</p>
				</div>
			</div>

			{agents.isLoading ? (
				<Spinner label="Loading agents" />
			) : agents.isError ? (
				<Alert variant="danger" title="Failed to load agents">
					{formatError(agents.error)}
				</Alert>
			) : agents.data?.agents.length === 0 ? (
				<EmptyState title="No agents" description="No agents in the registry." />
			) : (
				<AgentRegistryTable agents={agents.data?.agents ?? []} />
			)}
		</div>
	);
}

function AgentRegistryTable({ agents }: { agents: readonly AgentRow[] }) {
	return (
		<div className="flex flex-col overflow-hidden rounded-[4px] border border-(--color-border) bg-(--color-surface)">
			{/* Mobile arm: compact registry cards (warren-dea8). */}
			<InventoryCardList>
				{agents.map((agent) => (
					<AgentCard key={agent.name} agent={agent} />
				))}
			</InventoryCardList>
			<div className="hidden md:block">
				<div className="flex h-[31px] shrink-0 items-center gap-2.5 border-b border-b-(--color-border-strong) bg-(--color-thead) px-2.5">
					<ColumnHeader width="w-[220px] sm:w-[280px]">AGENT</ColumnHeader>
					<ColumnHeader width="w-[80px]">SOURCE</ColumnHeader>
					<ColumnHeader width="w-[110px]">PROVIDER</ColumnHeader>
					<ColumnHeader width="w-[170px]">DEFAULT MODEL</ColumnHeader>
					<ColumnHeader width="w-[110px]">COST CAP</ColumnHeader>
					<div className="min-w-0 flex-1 font-sans text-[9px] leading-3 font-semibold tracking-[0.05em] text-(--color-text-3)">
						LAST REFRESHED
					</div>
				</div>
				{agents.map((agent, i) => (
					<AgentRegistryRow key={agent.name} agent={agent} last={i === agents.length - 1} />
				))}
			</div>
		</div>
	);
}

/** Mobile registry card (warren-dea8): name + description, provider /
 *  model / cap figures, refresh note. */
function AgentCard({ agent }: { agent: AgentRow }) {
	const costCap = readCostCap(agent.renderedJson);
	return (
		<InventoryRowCard
			tone="neutral"
			stateLabel={agent.source ?? "builtin"}
			title={agent.name}
			subline={agent.description ?? agent.provider ?? ""}
			figures={
				<>
					<CardFigure value={agent.model ?? "—"} />
					<CardFigureNote value={costCap === null ? "—" : `$${costCap.toFixed(2)} cap`} />
				</>
			}
			meta={`refreshed ${formatTimestamp(agent.lastRefreshed)}`}
		/>
	);
}

function ColumnHeader({ width, children }: { width: string; children: string }) {
	return (
		<div
			className={`${width} shrink-0 font-sans text-[9px] leading-3 font-semibold tracking-[0.05em] text-(--color-text-3)`}
		>
			{children}
		</div>
	);
}

function AgentRegistryRow({ agent, last }: { agent: AgentRow; last: boolean }) {
	const costCap = readCostCap(agent.renderedJson);
	return (
		<div
			className={`flex min-h-[49px] items-center gap-2.5 px-2.5 py-1.5 ${
				last ? "" : "border-b border-b-(--color-border)"
			}`}
		>
			<div className="flex w-[220px] shrink-0 flex-col gap-0.5 sm:w-[280px]">
				<span className={CELL_MONO}>{agent.name}</span>
				{agent.description ? (
					<span className="font-sans text-[9px] leading-3 text-(--color-text-3)">
						{agent.description}
					</span>
				) : null}
			</div>
			<div className="flex w-[80px] shrink-0">
				<span className="flex h-5 items-center rounded-(--radius-xs) border border-(--color-border-strong) px-1.5">
					<span className="font-mono text-[9px] leading-3 text-(--color-text-2)">
						{agent.source ?? "builtin"}
					</span>
				</span>
			</div>
			<div className={`${CELL_MONO} w-[110px] shrink-0 text-(--color-text-2)`}>
				{agent.provider ?? "—"}
			</div>
			<div className={`${CELL_MONO} w-[170px] shrink-0 text-(--color-text-2)`}>
				{agent.model ?? "—"}
			</div>
			<div className={`${CELL_MONO} w-[110px] shrink-0 text-(--color-text-2)`}>
				{costCap === null ? "—" : `$${costCap.toFixed(2)}`}
			</div>
			<div className={`${CELL_MONO_MUTED} min-w-0 flex-1`}>
				{formatTimestamp(agent.lastRefreshed)}
			</div>
		</div>
	);
}

/**
 * The per-agent USD spend cap, declared as `frontmatter.maxCostUsd` in
 * the agent definition (the weakest source in the cap chain — see
 * AGENTS.md). It has no hoisted row field, so it reads from
 * `renderedJson`, which the public projection drops (warren-4f6c): a
 * spectator sees "—" rather than a fabricated number.
 */
function readCostCap(rendered: unknown): number | null {
	if (rendered === null || typeof rendered !== "object") return null;
	const fm = (rendered as { frontmatter?: unknown }).frontmatter;
	if (fm === null || typeof fm !== "object") return null;
	const cap = (fm as Record<string, unknown>).maxCostUsd;
	return typeof cap === "number" && Number.isFinite(cap) && cap > 0 ? cap : null;
}
