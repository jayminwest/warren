import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, RefreshCw } from "lucide-react";
import { useState } from "react";
import { agentsApi, projectsApi } from "@/api/client.ts";
import type { AgentRow } from "@/api/types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.tsx";
import { EmptyState } from "@/components/ui/empty-state.tsx";
import { Label } from "@/components/ui/label.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { responsiveFormControl } from "@/components/ui/responsive.ts";
import { Spinner } from "@/components/ui/spinner.tsx";
import {
	Table,
	TableBody,
	TableCell,
	TableHead,
	TableHeader,
	TableRow,
} from "@/components/ui/table.tsx";
import {
	compareStrings,
	type Comparator,
	useClientSort,
} from "@/hooks/use-client-sort.ts";
import { SortableTableHead } from "@/components/ui/sortable-table-head.tsx";
import { type AgentSourceTier, classifyAgentSource } from "@/lib/agent-source.ts";
import { formatError } from "@/lib/format-error.ts";
import { formatTimestamp } from "@/lib/utils.ts";

type AgentSortKey = "name" | "source" | "registeredAt" | "lastRefreshed";

const AGENT_COMPARATORS: Record<AgentSortKey, Comparator<AgentRow>> = {
	name: (a, b) => compareStrings(a.name, b.name),
	source: (a, b) =>
		compareStrings(classifyAgentSource(a.source).label, classifyAgentSource(b.source).label),
	registeredAt: (a, b) => compareStrings(a.registeredAt, b.registeredAt),
	lastRefreshed: (a, b) => compareStrings(a.lastRefreshed, b.lastRefreshed),
};

export function AgentsPage() {
	const qc = useQueryClient();
	// R-03 / pl-fef5 step 8: the projectId filter scopes the list to
	// global ∪ that project's tier. Empty string means "global only" (the
	// server rejects `?projectId=`, so the client passes no param in that
	// case — see agentsQuery in api/client.ts).
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
	const refresh = useMutation({
		mutationFn: () => agentsApi.refresh(),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
	});
	// `POST /projects/:id/agents/refresh` — re-scans one project's `.canopy/`.
	// Only available when a project filter is active; invalidates the
	// project-scoped agents query so the new rows surface immediately.
	const refreshProject = useMutation({
		mutationFn: (projectId: string) => agentsApi.refreshProject(projectId),
		onSuccess: () => qc.invalidateQueries({ queryKey: ["agents"] }),
	});
	const [openName, setOpenName] = useState<string | null>(null);
	const { sorted, sort, onSort } = useClientSort(
		agents.data?.agents ?? [],
		AGENT_COMPARATORS,
		{
			initialKey: "name",
			defaultDirections: { registeredAt: "desc", lastRefreshed: "desc" },
		},
	);

	return (
		<div className="space-y-6">
			<PageHeader
				className="items-start"
				title="Agents"
				description={
					<>
						Agents available for dispatch. <code>claude-code</code>,{" "}
						<code>sapling</code>, and <code>pi</code> ship inline; refresh
						re-clones the optional canopy library for custom agents. Pick a
						project to surface its <code>.canopy/</code> tier.
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
					{projectFilter.length > 0 ? (
						<Button
							onClick={() => refreshProject.mutate(projectFilter)}
							disabled={refreshProject.isPending}
							variant="outline"
						>
							<RefreshCw
								className={`h-4 w-4 ${
									refreshProject.isPending ? "animate-spin" : ""
								}`}
							/>
							Refresh project tier
						</Button>
					) : null}
					<Button
						onClick={() => refresh.mutate()}
						disabled={refresh.isPending}
						variant="outline"
					>
						<RefreshCw
							className={`h-4 w-4 ${refresh.isPending ? "animate-spin" : ""}`}
						/>
						Refresh registry
					</Button>
				</div>
				}
			/>

			{refresh.isSuccess ? (
				<Card>
					<CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
						<span className="font-medium">Last refresh:</span>
						<Badge variant="succeeded">
							{refresh.data.registered.length} registered
						</Badge>
						{refresh.data.skipped.length > 0 ? (
							<Badge variant="failed">{refresh.data.skipped.length} skipped</Badge>
						) : null}
						{refresh.data.removed.length > 0 ? (
							<Badge variant="cancelled">
								{refresh.data.removed.length} removed
							</Badge>
						) : null}
						<span className="text-(--color-muted-foreground)">
							{refresh.data.clone.head.slice(0, 12)}
						</span>
					</CardContent>
				</Card>
			) : null}

			{refreshProject.isSuccess ? (
				<Card>
					<CardContent className="flex flex-wrap items-center gap-3 p-4 text-sm">
						<span className="font-medium">Last project refresh:</span>
						<code className="font-mono text-xs">{refreshProject.data.projectId}</code>
						<Badge variant="succeeded">
							{refreshProject.data.registered.length} registered
						</Badge>
						{refreshProject.data.skipped.length > 0 ? (
							<Badge variant="failed">
								{refreshProject.data.skipped.length} skipped
							</Badge>
						) : null}
						{refreshProject.data.removed.length > 0 ? (
							<Badge variant="cancelled">
								{refreshProject.data.removed.length} removed
							</Badge>
						) : null}
					</CardContent>
				</Card>
			) : null}

			{refresh.isError ? (
				<Alert variant="danger" title="Registry refresh failed">
					{formatError(refresh.error)}
				</Alert>
			) : null}

			{refreshProject.isError ? (
				<Alert variant="danger" title="Project tier refresh failed">
					{formatError(refreshProject.error)}
				</Alert>
			) : null}

			<Card>
				<CardHeader>
					<CardTitle>{agents.data?.agents.length ?? 0} registered</CardTitle>
				</CardHeader>
				<CardContent className="p-0">
					{agents.isLoading ? (
						<div className="p-6"><Spinner label="Loading agents" /></div>
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
									Built-in <code>claude-code</code>, <code>sapling</code>, and{" "}
									<code>pi</code> should appear here automatically — if not,
									check <code>warren doctor</code>. To layer a custom canopy
									library on top, set <code>CANOPY_REPO_URL</code> and click{" "}
									<strong>Refresh registry</strong>.
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
									<SortableTableHead columnKey="source" sort={sort} onSort={onSort}>
										Source
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
											setOpenName(
												openName === agentRowKey(a) ? null : agentRowKey(a),
											)
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

/**
 * Project-tier rows can share a `name` with a global row when the
 * filter surfaces both; key open-state on `name + source` so toggling
 * one doesn't expand the other.
 */
function agentRowKey(agent: AgentRow): string {
	return `${agent.source ?? "unknown"}::${agent.name}`;
}

const sourceBadgeVariant: Record<
	AgentSourceTier,
	"default" | "secondary" | "succeeded" | "running" | "queued"
> = {
	builtin: "secondary",
	library: "running",
	project: "succeeded",
	unknown: "default",
};

function AgentDisplayRow({
	agent,
	open,
	onToggle,
}: {
	agent: AgentRow;
	open: boolean;
	onToggle: () => void;
}) {
	const classified = classifyAgentSource(agent.source);
	return (
		<>
			<TableRow className="cursor-pointer" onClick={onToggle}>
				<TableCell>
					{open ? (
						<ChevronDown className="h-4 w-4" />
					) : (
						<ChevronRight className="h-4 w-4" />
					)}
				</TableCell>
				<TableCell className="font-medium">{agent.name}</TableCell>
				<TableCell>
					<Badge
						variant={sourceBadgeVariant[classified.tier]}
						className="font-mono text-xs"
						title={
							classified.projectId !== null
								? `project:${classified.projectId}`
								: undefined
						}
					>
						{classified.label}
					</Badge>
				</TableCell>
				<TableCell className="text-(--color-muted-foreground)">
					{formatTimestamp(agent.registeredAt)}
				</TableCell>
				<TableCell className="text-(--color-muted-foreground)">
					{formatTimestamp(agent.lastRefreshed)}
				</TableCell>
			</TableRow>
			{open ? (
				<TableRow>
					<TableCell colSpan={5} className="bg-(--color-muted)/30 max-w-0">
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

function AgentDefinitionPanel({ agent }: { agent: AgentRow }) {
	const def = readRenderedAgent(agent.renderedJson);
	const [showRaw, setShowRaw] = useState(false);
	const provider = readStringField(def.frontmatter, "provider");
	const model = readStringField(def.frontmatter, "model");
	const tags = readTags(def.frontmatter);
	const sectionEntries = Object.entries(def.sections ?? {});
	const resolvedFrom = (def.resolvedFrom ?? []).filter(
		(s): s is string => typeof s === "string" && s.length > 0,
	);

	return (
		<div className="space-y-4 break-words">
			<dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-4">
				<MetaField label="Name" value={def.name ?? agent.name} mono />
				<MetaField
					label="Version"
					value={typeof def.version === "number" ? String(def.version) : "—"}
					mono
				/>
				<MetaField label="Source" value={agent.source ?? "—"} />
				<MetaField label="Provider" value={provider ?? "—"} mono />
				<MetaField label="Model" value={model ?? "—"} mono />
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
