import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { StatusDot, type Tone } from "@/components/ui/status.tsx";
import { relativeTime } from "@/lib/utils.ts";

/**
 * Services (warren-d903, warren-9474): the API liveness the shell already
 * polls, plus database and event-stream health from the ops overview.
 * The public projection omits the services section, so a spectator sees
 * the API row only. The card sizes to its rows (warren-dac1).
 */

interface ServiceSpec {
	readonly name: string;
	readonly detail: string;
	readonly tone: Tone;
}

function ServiceRow({ name, detail, tone }: ServiceSpec) {
	return (
		<li className="flex h-11 items-center gap-3 px-4">
			<StatusDot tone={tone} />
			<span className="min-w-0 flex-1 truncate text-sm text-(--color-text)">{name}</span>
			<span className="shrink-0 text-sm text-(--color-text-2)">{detail}</span>
		</li>
	);
}

function apiService(health: "ok" | "down" | "unknown"): ServiceSpec {
	if (health === "ok") return { name: "API", detail: "Reachable", tone: "ok" };
	if (health === "down") return { name: "API", detail: "Unreachable", tone: "err" };
	return { name: "API", detail: "Checking", tone: "idle" };
}

export function ServicesPanel({
	overview,
	health,
}: {
	overview: OpsOverviewResponse | undefined;
	health: "ok" | "down" | "unknown";
}) {
	const services = overview?.services;
	const rows: ServiceSpec[] = [apiService(health)];
	if (services !== undefined) {
		rows.push(
			services.dbReachable
				? { name: "Database", detail: "Reachable", tone: "ok" }
				: { name: "Database", detail: "Unreachable", tone: "err" },
			services.lifecycleStream
				? { name: "Live updates", detail: "Connected", tone: "ok" }
				: { name: "Live updates", detail: "Refreshing every minute", tone: "warn" },
		);
	}
	return (
		<Card>
			<CardHeader
				title="Services"
				meta={overview ? `Checked ${relativeTime(overview.generatedAt)}` : undefined}
			/>
			<ul className="divide-y divide-(--color-border)">
				{rows.map((row) => (
					<ServiceRow key={row.name} {...row} />
				))}
			</ul>
		</Card>
	);
}
