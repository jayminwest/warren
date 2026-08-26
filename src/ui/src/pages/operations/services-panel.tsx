import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import { cn, relativeTime } from "@/lib/utils.ts";

/**
 * Control-plane services panel (warren-d903). Derived service-health
 * facts from the ops snapshot (db reachable, runtime provider kind,
 * lifecycle-stream wiring) plus the `/healthz` liveness the shell already
 * polls. The public projection omits the services section, so a
 * spectator sees the API-server row only — the liveness probe every
 * capability level can read.
 */

function ServiceRow({ name, detail, ok }: { name: string; detail: string; ok: boolean | null }) {
	return (
		<div className="flex min-h-[43px] flex-1 items-center gap-2 border-b border-(--color-border) px-3 py-1.5 last:border-b-0">
			<span
				className={cn(
					"h-1.5 w-1.5 shrink-0 rounded-full",
					ok === true && "bg-(--color-success)",
					ok === false && "bg-(--color-danger)",
					ok === null && "bg-(--color-text-3)",
				)}
				aria-hidden
			/>
			<span className="flex min-w-0 flex-1 flex-col gap-0.5">
				<span className="text-[11px] leading-3.5 font-medium text-(--color-text)">{name}</span>
				<span className="font-mono text-[9px] leading-[13px] text-(--color-text-3)">{detail}</span>
			</span>
		</div>
	);
}

export function ServicesPanel({
	overview,
	health,
}: {
	overview: OpsOverviewResponse | undefined;
	health: "ok" | "down" | "unknown";
}) {
	const services = overview?.services;
	return (
		<div className="flex min-w-0 flex-[1.8] flex-col overflow-clip rounded-(--radius-md) border border-(--color-border) bg-(--color-surface)">
			<div className="flex h-[39px] shrink-0 items-center gap-2 border-b border-(--color-border) px-3">
				<span className="text-[11px] leading-3.5 font-semibold text-(--color-text)">
					Control-plane services
				</span>
				<span className="flex-1" />
				{overview ? (
					<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
						snapshot {relativeTime(overview.generatedAt)}
					</span>
				) : null}
			</div>
			<div className="flex flex-1 flex-col">
				<ServiceRow
					name="API server"
					detail={health === "unknown" ? "liveness unknown" : "GET /healthz liveness"}
					ok={health === "ok" ? true : health === "down" ? false : null}
				/>
				{services === undefined ? null : (
					<>
						<ServiceRow
							name="Database"
							detail={
								services.dbReachable
									? "aggregate queries reachable"
									: "unreachable — snapshot degraded"
							}
							ok={services.dbReachable}
						/>
						<ServiceRow
							name="Runtime provider"
							detail={`WARREN_RUNTIME=${services.runtime}`}
							ok={null}
						/>
						<ServiceRow
							name="Lifecycle stream"
							detail={
								services.lifecycleStream
									? "GET /events/stream wired at boot"
									: "not wired — fallback polls only"
							}
							ok={services.lifecycleStream ? true : null}
						/>
					</>
				)}
			</div>
		</div>
	);
}
