import { useQuery } from "@tanstack/react-query";
import { Bot } from "lucide-react";
import { agentsApi } from "@/api/client.ts";
import type { AgentRow } from "@/api/types.ts";
import { Card } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import {
	CardFigure,
	CardFigureNote,
	InventoryCardList,
	InventoryRowCard,
} from "@/components/ui/inventory-card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { SkeletonRows } from "@/components/ui/skeleton.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { Tag } from "@/components/ui/tag.tsx";
import { formatTimestamp, relativeTime } from "@/lib/utils.ts";
import { ListError } from "@/pages/runs/list-error.tsx";

/**
 * Agents — the agent registry (warren-db84, migrated in warren-9474).
 *
 * One inventory table over `GET /agents`: the boot-seeded builtins with
 * read-only provenance. The page is read-only for operators and
 * spectators alike: a spectator's rows carry the same hoisted
 * `description` / `provider` / `model` / `source` fields (warren-4f6c)
 * minus the `renderedJson` envelope, which is where the cost-cap cell
 * reads from — it degrades to "—" rather than guessing.
 */

export function AgentsPage() {
	const agents = useQuery({
		queryKey: ["agents"],
		queryFn: ({ signal }) => agentsApi.list({}, signal),
	});
	const rows = agents.data?.agents ?? [];

	return (
		<div className="flex min-h-full flex-col gap-5 px-4 pt-6 pb-12 md:px-6">
			<PageHeader title="Agents" description="The agents warren can dispatch runs with." />
			<Card className="self-stretch" aria-label="Agent registry">
				{agents.isLoading ? (
					<SkeletonRows rows={6} />
				) : agents.isError ? (
					<ListError what="agents" error={agents.error} onRetry={() => void agents.refetch()} />
				) : rows.length === 0 ? (
					<EmptyState
						compact
						icon={Bot}
						title="No agents yet"
						description="Agents appear here once warren has loaded its registry."
					/>
				) : (
					<AgentRegistry agents={rows} />
				)}
			</Card>
		</div>
	);
}

function formatCap(cap: number | null, suffix = ""): string {
	return cap === null ? "—" : `$${cap.toFixed(2)}${suffix}`;
}

function AgentRegistry({ agents }: { agents: readonly AgentRow[] }) {
	return (
		<>
			{/* Phone arm: compact registry cards (warren-dea8). */}
			<InventoryCardList>
				{agents.map((agent) => (
					<AgentCard key={agent.name} agent={agent} />
				))}
			</InventoryCardList>
			<div className="hidden md:block">
				<Table className="min-w-[48rem]">
					<TableHeader>
						<TableRow>
							<TableHead>Agent</TableHead>
							<TableHead>Source</TableHead>
							<TableHead>Provider</TableHead>
							<TableHead>Default model</TableHead>
							<TableHead className="text-right">Cost cap</TableHead>
							<TableHead className="text-right">Last refreshed</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{agents.map((agent) => (
							<AgentRegistryRow key={agent.name} agent={agent} />
						))}
					</TableBody>
				</Table>
			</div>
		</>
	);
}

/** Phone registry card (warren-dea8): name + description, model / cap
 *  figures, refresh note. */
function AgentCard({ agent }: { agent: AgentRow }) {
	const costCap = readCostCap(agent.renderedJson);
	return (
		<InventoryRowCard
			tone="neutral"
			stateLabel={agent.source === "library" ? "Library" : "Built in"}
			title={agent.name}
			subline={agent.description ?? agent.provider ?? ""}
			figures={
				<>
					<CardFigure value={agent.model ?? "—"} />
					<CardFigureNote value={formatCap(costCap, " cap")} />
				</>
			}
			meta={`Refreshed ${relativeTime(agent.lastRefreshed)}`}
		/>
	);
}

function AgentRegistryRow({ agent }: { agent: AgentRow }) {
	const costCap = readCostCap(agent.renderedJson);
	return (
		<TableRow>
			<TableCell className="max-w-md">
				<div className="flex min-w-0 flex-col gap-0.5">
					<span className="font-mono text-sm text-(--color-text)">{agent.name}</span>
					{agent.description ? (
						<span className="text-xs text-(--color-text-3)">{agent.description}</span>
					) : null}
				</div>
			</TableCell>
			<TableCell>
				<Tag>{agent.source === "library" ? "Library" : "Built in"}</Tag>
			</TableCell>
			<TableCell className="text-(--color-text-2)">{agent.provider ?? "—"}</TableCell>
			<TableCell className="font-mono text-xs text-(--color-text-2)">
				{agent.model ?? "—"}
			</TableCell>
			<TableCell className="text-right text-(--color-text-2) tabular-nums">
				{formatCap(costCap)}
			</TableCell>
			<TableCell
				className="text-right text-(--color-text-3) tabular-nums"
				title={formatTimestamp(agent.lastRefreshed)}
			>
				{relativeTime(agent.lastRefreshed)}
			</TableCell>
		</TableRow>
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
