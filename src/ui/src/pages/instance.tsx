import { useQuery } from "@tanstack/react-query";
import type * as React from "react";
import { instanceApi } from "@/api/client.ts";
import type { InstanceFactsResponse } from "@/api/instance-types.ts";
import { Alert } from "@/components/ui/alert.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { PageHeader } from "@/components/ui/page-header.tsx";
import { Skeleton } from "@/components/ui/skeleton.tsx";
import { useNow } from "@/hooks/use-now.ts";
import { formatError } from "@/lib/format-error.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Instance (warren-e680, migrated in warren-9474) — boot-resolved server
 * configuration, read-only. Nothing here is a setting you change in the
 * console: it resolves from the environment at boot or from a project's
 * `.warren/config.yaml`, so the page is a facts surface, never a form.
 *
 * A public spectator gets the reduced projection; the operator-only
 * facts (database, uptime, admission caps) read "Operator only" rather
 * than a blank. Uptime ticks locally from the last answer, so the page
 * needs no poll.
 */

const RUNTIME_LABELS: Record<InstanceFactsResponse["runtime"], string> = {
	local: "Local sandbox",
	docker: "Docker containers",
	k8s: "Kubernetes pods",
};

const AUTH_LABELS: Record<InstanceFactsResponse["authMode"], string> = {
	token: "Token — every request needs a credential",
	public: "Public — visitors can read without signing in",
};

function formatUptime(seconds: number): string {
	const d = Math.floor(seconds / 86_400);
	const h = Math.floor((seconds % 86_400) / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	if (d > 0) return `${d}d ${h}h ${m}m`;
	if (h > 0) return `${h}h ${m}m`;
	return `${m}m ${Math.floor(seconds % 60)}s`;
}

/** A value slot: the fact, a skeleton while loading, or "Operator only". */
type Fact = React.ReactNode | "loading" | "operator-only";

function FactRow({
	label,
	value,
	hint,
	mono = false,
}: {
	label: string;
	value: Fact;
	/** Where the value comes from — an env var, a file. */
	hint?: string;
	mono?: boolean;
}) {
	let shown: React.ReactNode;
	if (value === "loading") shown = <Skeleton className="w-24" />;
	else if (value === "operator-only")
		shown = <span className="text-(--color-text-3)">Operator only</span>;
	else shown = value;
	return (
		<div className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-baseline sm:gap-6">
			<dt className="shrink-0 text-sm text-(--color-text-2) sm:w-48">{label}</dt>
			<dd className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className={cn("text-sm text-(--color-text)", mono && "font-mono text-xs")}>
					{shown}
				</span>
				{hint ? <span className="font-mono text-xs text-(--color-text-3)">{hint}</span> : null}
			</dd>
		</div>
	);
}

function FactsCard({
	title,
	meta,
	children,
}: {
	title: string;
	meta?: string;
	children: React.ReactNode;
}) {
	return (
		<Card>
			<CardHeader title={title} meta={meta} />
			<dl className="divide-y divide-(--color-border)">{children}</dl>
		</Card>
	);
}

function NotSet() {
	return <span className="text-(--color-text-3)">Not set</span>;
}

/** Loading, spectator-hidden, or the value. */
function operatorFact<T>(
	facts: InstanceFactsResponse | undefined,
	value: T | undefined,
	render: (v: T) => React.ReactNode,
): Fact {
	if (facts === undefined) return "loading";
	return value === undefined ? "operator-only" : render(value);
}

function ServerCard({
	facts,
	uptimeSeconds,
}: {
	facts: InstanceFactsResponse | undefined;
	uptimeSeconds: number | undefined;
}) {
	return (
		<FactsCard title="Server">
			<FactRow
				label="Name"
				value={facts ? (facts.name ?? <NotSet />) : "loading"}
				hint="WARREN_INSTANCE_NAME"
			/>
			<FactRow
				label="Public URL"
				value={facts ? (facts.publicUrl ?? <NotSet />) : "loading"}
				hint="WARREN_BASE_URL"
				mono
			/>
			<FactRow label="Version" value={facts ? `v${facts.version}` : "loading"} />
			<FactRow
				label="Runtime"
				value={facts ? RUNTIME_LABELS[facts.runtime] : "loading"}
				hint="WARREN_RUNTIME"
			/>
			<FactRow
				label="Database"
				value={operatorFact(facts, facts?.dbBackend ?? undefined, (db) =>
					db === "postgres" ? "Postgres" : "SQLite",
				)}
				hint="WARREN_DB_URL"
			/>
			<FactRow
				label="Uptime"
				value={operatorFact(facts, uptimeSeconds, (s) => (
					<span className="tabular-nums">{formatUptime(s)}</span>
				))}
			/>
		</FactsCard>
	);
}

function AccessCard({ facts }: { facts: InstanceFactsResponse | undefined }) {
	// dbBackend is the first operator-only field: its absence marks the
	// reduced spectator projection (warren-2eec).
	const view =
		facts === undefined
			? "loading"
			: facts.dbBackend === undefined
				? "Public view — operator facts hidden"
				: "Operator view — all facts shown";
	return (
		<FactsCard title="Access">
			<FactRow
				label="Authentication"
				value={facts ? AUTH_LABELS[facts.authMode] : "loading"}
				hint="WARREN_AUTH"
			/>
			<FactRow label="This session sees" value={view} />
		</FactsCard>
	);
}

function capValue(n: number | null): string {
	return n === null ? "No limit" : n.toLocaleString();
}

function AdmissionCard({ facts }: { facts: InstanceFactsResponse | undefined }) {
	const admission = facts?.admission;
	let rows: React.ReactNode;
	if (facts !== undefined && admission === null) {
		rows = (
			<p className="px-4 py-3 text-sm text-(--color-text-3)">
				Admission caps apply to Kubernetes pods only; this instance runs on{" "}
				{RUNTIME_LABELS[facts.runtime].toLowerCase()}.
			</p>
		);
	} else {
		rows = (
			<>
				<FactRow
					label="Runs per project"
					value={operatorFact(facts, admission ?? undefined, (a) =>
						capValue(a.maxProjectConcurrency),
					)}
					hint="WARREN_K8S_MAX_PROJECT_CONCURRENCY"
				/>
				<FactRow
					label="Queue depth"
					value={operatorFact(facts, admission ?? undefined, (a) => capValue(a.maxQueueDepth))}
					hint="WARREN_K8S_MAX_QUEUE_DEPTH"
				/>
				<FactRow
					label="Pending pods"
					value={operatorFact(facts, admission ?? undefined, (a) => capValue(a.maxPendingPods))}
					hint="WARREN_K8S_MAX_PENDING_PODS"
				/>
			</>
		);
	}
	return (
		<FactsCard title="Admission" meta="Limits on runs in flight">
			{rows}
		</FactsCard>
	);
}

export function InstancePage() {
	// Shared ["instance", "facts"] key: deduped with the shell's runtime
	// figure. Facts only change on restart, so there is no poll; uptime
	// ticks forward locally from the answer's timestamp.
	const facts = useQuery({
		queryKey: ["instance", "facts"],
		queryFn: ({ signal }) => instanceApi.facts(signal),
		staleTime: 60_000,
	});
	const now = useNow(1000);
	const data = facts.data;
	const uptimeSeconds =
		data && typeof data.uptimeSeconds === "number"
			? data.uptimeSeconds + Math.max(0, Math.floor((now - facts.dataUpdatedAt) / 1000))
			: undefined;

	return (
		<div className="flex min-h-full flex-col gap-5 px-4 pt-5 pb-12 md:px-6">
			<PageHeader
				title="Instance"
				description="How this server is configured. Change these in the environment or a project's .warren/config.yaml, then restart."
			/>
			{facts.isError ? (
				<Alert variant="danger" title="Couldn't load instance facts">
					<div className="flex flex-col items-start gap-2">
						{formatError(facts.error)}
						<Button variant="outline" size="sm" onClick={() => void facts.refetch()}>
							Retry
						</Button>
					</div>
				</Alert>
			) : null}
			<div className="grid max-w-5xl items-start gap-4 lg:grid-cols-2">
				<div className="grid min-w-0 content-start gap-4">
					<ServerCard facts={data} uptimeSeconds={uptimeSeconds} />
					<AccessCard facts={data} />
				</div>
				<AdmissionCard facts={data} />
			</div>
		</div>
	);
}
