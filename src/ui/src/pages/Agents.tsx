import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useState } from "react";
import { agentsApi, projectsApi } from "@/api/client.ts";
import type { AgentRow } from "@/api/types.ts";
import { OperatorOnly } from "@/components/OperatorOnly.tsx";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { responsiveFormControl } from "@/components/ui/responsive.ts";
import { SortableTableHead } from "@/components/ui/sortable-table-head.tsx";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import { type Comparator, compareStrings, useClientSort } from "@/hooks/use-client-sort.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp } from "@/lib/utils.ts";

type AgentSortKey = "name" | "registeredAt" | "lastRefreshed";

const AGENT_COMPARATORS: Record<AgentSortKey, Comparator<AgentRow>> = {
	name: (a, b) => compareStrings(a.name, b.name),
	registeredAt: (a, b) => compareStrings(a.registeredAt, b.registeredAt),
	lastRefreshed: (a, b) => compareStrings(a.lastRefreshed, b.lastRefreshed),
};

export function AgentsPage() {
	// The projectId filter scopes the list to global ∪ that project. Empty
	// string means "global only" (the server rejects `?projectId=`, so the
	// client passes no param in that case — see agentsQuery in
	// api/client.ts).
	const [projectFilter, setProjectFilter] = useState("");
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
	});
	const agents = useQuery({
		queryKey: ["agents", { projectId: projectFilter }],
		queryFn: ({ signal }) =>
			agentsApi.list(projectFilter.length > 0 ? { projectId: projectFilter } : {}, signal),
	});
	const [openName, setOpenName] = useState<string | null>(null);
	const { sorted, sort, onSort } = useClientSort(agents.data?.agents ?? [], AGENT_COMPARATORS, {
		initialKey: "name",
		defaultDirections: { registeredAt: "desc", lastRefreshed: "desc" },
	});

	return (
		<div className="space-y-6">
			<PageHeader
				className="items-start"
				title="Agents"
				description={
					<>
						Agents available for dispatch. <code>claude-code</code>, <code>sapling</code>, and{" "}
						<code>pi</code> ship inline. Pick a project to scope the list.
					</>
				}
				actions={
					<div className="flex flex-wrap items-end gap-2">
						<div className="space-y-1.5">
							<Label htmlFor="agent-project-filter" className="text-xs">
								Project
							</Label>
							<select
								id="agent-project-filter"
								value={projectFilter}
								onChange={(e) => setProjectFilter(e.target.value)}
								className={`flex min-w-[14rem] rounded-md border bg-(--color-card) px-3 py-1 shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-ring) ${responsiveFormControl}`}
							>
								<option value="">Global only</option>
								{projects.data?.projects.map((p) => (
									<option key={p.id} value={p.id}>
										{p.gitUrl} ({p.id})
									</option>
								))}
							</select>
						</div>
					</div>
				}
			/>

			<Card>
				<CardHeader>
					<CardTitle>{agents.data?.agents.length ?? 0} registered</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{agents.isLoading ? (
						<div className="p-6">
							<Spinner label="Loading agents" />
						</div>
					) : agents.isError ? (
						<div className="p-6">
							<Alert variant="danger" title="Failed to load agents">
								{formatError(agents.error)}
							</Alert>
						</div>
					) : agents.data?.agents.length === 0 ? (
						<EmptyState
							title="No agents registered"
							description={
								<>
									Built-in <code>claude-code</code>, <code>sapling</code>, and <code>pi</code>{" "}
									should appear here automatically — if not, check <code>warren doctor</code>.
								</>
							}
						/>
					) : (
						<Table>
							<TableHeader>
								<TableRow>
									<TableHead className="w-8" />
									<SortableTableHead columnKey="name" sort={sort} onSort={onSort}>
										Name
									</SortableTableHead>
									<SortableTableHead columnKey="registeredAt" sort={sort} onSort={onSort}>
										Registered
									</SortableTableHead>
									<SortableTableHead columnKey="lastRefreshed" sort={sort} onSort={onSort}>
										Last refreshed
									</SortableTableHead>
								</TableRow>
							</TableHeader>
							<TableBody>
								{sorted.map((a) => (
									<AgentDisplayRow
										key={agentRowKey(a)}
										agent={a}
										open={openName === agentRowKey(a)}
										onToggle={() =>
											setOpenName(openName === agentRowKey(a) ? null : agentRowKey(a))
										}
									/>
								))}
							</TableBody>
						</Table>
					)}
				</CardContent>
			</Card>
		</div>
	);
}

/** Key open-state on `name` so toggling one row doesn't expand another. */
function agentRowKey(agent: AgentRow): string {
	return agent.name;
}

function AgentDisplayRow({
	agent,
	open,
	onToggle,
}: {
	agent: AgentRow;
	open: boolean;
	onToggle: () => void;
}) {
	return (
		<>
			<TableRow className="cursor-pointer" onClick={onToggle}>
				<TableCell>
					{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
				</TableCell>
				<TableCell className="font-medium">{agent.name}</TableCell>
				<TableCell className="text-(--color-muted-foreground)">
					{formatTimestamp(agent.registeredAt)}
				</TableCell>
				<TableCell className="text-(--color-muted-foreground)">
					{formatTimestamp(agent.lastRefreshed)}
				</TableCell>
			</TableRow>
			{open ? (
				<TableRow>
					<TableCell colSpan={4} className="bg-(--color-muted)/30 max-w-0">
						<AgentDefinitionPanel agent={agent} />
					</TableCell>
				</TableRow>
			) : null}
		</>
	);
}

interface RenderedAgent {
	name?: string;
	version?: number;
	sections?: Record<string, unknown>;
	resolvedFrom?: unknown[];
	frontmatter?: Record<string, unknown>;
}

function readRenderedAgent(raw: unknown): RenderedAgent {
	if (typeof raw !== "object" || raw === null) return {};
	return raw as RenderedAgent;
}

function readStringField(obj: Record<string, unknown> | undefined, key: string): string | null {
	if (!obj) return null;
	const v = obj[key];
	return typeof v === "string" && v.length > 0 ? v : null;
}

function readTags(frontmatter: Record<string, unknown> | undefined): string[] {
	if (!frontmatter) return [];
	const v = frontmatter.tags;
	if (!Array.isArray(v)) return [];
	return v.filter((t): t is string => typeof t === "string" && t.length > 0);
}

/**
 * Expanded-row detail for one agent.
 *
 * The header `<dl>` reads the flat row fields (`description` / `provider` /
 * `model`), which survive the public projection, so it renders identically
 * for both audiences. Everything below it is derived from `renderedJson` —
 * the system prompt, the resolved source paths, the raw envelope —
 * which warren drops for a `readPublic`-only caller (warren-4f6c). Rather
 * than render that half as an empty "No sections." shell, it is gated on
 * `readOperator` (warren-f53e / pl-b82d step 19).
 */
function AgentDefinitionPanel({ agent }: { agent: AgentRow }) {
	const def = readRenderedAgent(agent.renderedJson);
	const tags = readTags(def.frontmatter);
	// Prefer the flat row field; fall back to frontmatter so an older
	// warren that predates the hoist still fills the cell.
	const provider = agent.provider ?? readStringField(def.frontmatter, "provider");
	const model = agent.model ?? readStringField(def.frontmatter, "model");

	return (
		<div className="space-y-4 break-words">
			<dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
				<MetaField label="Name" value={def.name ?? agent.name} mono />
				<MetaField label="Provider" value={provider ?? "—"} mono />
				<MetaField label="Model" value={model ?? "—"} mono />
				{agent.description ? (
					<div className="col-span-2">
						<dt className="text-(--color-muted-foreground)">Description</dt>
						<dd className="mt-1">{agent.description}</dd>
					</div>
				) : null}
				<div>
					<dt className="text-(--color-muted-foreground)">Tags</dt>
					<dd className="mt-1 flex flex-wrap gap-1">
						{tags.length === 0 ? (
							<span className="text-(--color-muted-foreground)">—</span>
						) : (
							tags.map((t) => (
								<Badge key={t} variant="secondary">
									{t}
								</Badge>
							))
						)}
					</dd>
				</div>
			</dl>

			<OperatorOnly capability="readOperator">
				<AgentDefinitionInternals agent={agent} def={def} />
			</OperatorOnly>
		</div>
	);
}

/** The `renderedJson`-derived half of the panel. Operator-only. */
function AgentDefinitionInternals({ agent, def }: { agent: AgentRow; def: RenderedAgent }) {
	const [showRaw, setShowRaw] = useState(false);
	const sectionEntries = Object.entries(def.sections ?? {});
	const resolvedFrom = (def.resolvedFrom ?? []).filter(
		(s): s is string => typeof s === "string" && s.length > 0,
	);

	return (
		<div className="space-y-4">
			{typeof def.version === "number" ? (
				<div className="text-xs text-(--color-muted-foreground)">
					<span className="font-medium">Version:</span>{" "}
					<span className="font-mono">{def.version}</span>
				</div>
			) : null}

			{resolvedFrom.length > 0 ? (
				<div className="text-xs text-(--color-muted-foreground)">
					<span className="font-medium">Resolved from:</span>{" "}
					<span className="font-mono break-all">{resolvedFrom.join(" → ")}</span>
				</div>
			) : null}

			{sectionEntries.length === 0 ? (
				<p className="text-xs text-(--color-muted-foreground)">No sections.</p>
			) : (
				<div className="space-y-2">
					{sectionEntries.map(([name, body]) => (
						<details
							key={name}
							open={name === "system"}
							className="group rounded-md border border-(--color-border) bg-(--color-card)"
						>
							<summary className="flex cursor-pointer items-center gap-1 px-3 py-2 text-xs font-medium select-none [&::-webkit-details-marker]:hidden">
								<ChevronRight className="h-3 w-3 transition-transform group-open:rotate-90" />
								{sectionLabel(name)}
							</summary>
							<pre className="max-h-[420px] overflow-auto px-3 pt-0 pb-3 font-mono text-xs whitespace-pre-wrap break-words">
								{typeof body === "string" ? body : JSON.stringify(body, null, 2)}
							</pre>
						</details>
					))}
				</div>
			)}

			<div>
				<Button
					variant="outline"
					size="sm"
					onClick={() => setShowRaw((v) => !v)}
					className="h-7 text-xs"
				>
					{showRaw ? "Hide raw JSON" : "View raw JSON"}
				</Button>
				{showRaw ? (
					<pre className="mt-2 max-h-[420px] overflow-auto rounded-md bg-(--color-card) p-3 text-xs whitespace-pre-wrap break-words">
						{JSON.stringify(agent.renderedJson, null, 2)}
					</pre>
				) : null}
			</div>
		</div>
	);
}

function MetaField({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
	return (
		<div>
			<dt className="text-(--color-muted-foreground)">{label}</dt>
			<dd className={`mt-1 ${mono ? "font-mono" : ""} break-all`}>{value}</dd>
		</div>
	);
}

function sectionLabel(name: string): string {
	if (name === "system") return "System prompt";
	return name;
}
