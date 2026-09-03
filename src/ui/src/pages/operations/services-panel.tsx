import type { OpsOverviewResponse } from "@/api/ops-types.ts";
import { cn, relativeTime } from "@/lib/utils.ts";

/**
 * Services panel (warren-d903). Derived service-health facts from the
 * ops snapshot (db reachable, lifecycle-stream wiring) plus the
 * `/healthz` liveness the shell already polls. The public projection
 * omits the services section, so a spectator sees the API row only.
 */

function ServiceRow({ name, detail, ok }: { name: string; detail: string; ok: boolean | null }) {
	return (
		<div className="flex min-h-[43px] items-center gap-2 border-b border-(--color-border) px-3 py-1.5 last:border-b-0">
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
				<span className="text-[11px] leading-3.5 font-semibold text-(--color-text)">Services</span>
				<span className="flex-1" />
				{overview ? (
					<span className="font-mono text-[9px] leading-3 text-(--color-text-3)">
						snapshot {relativeTime(overview.generatedAt)}
					</span>
				) : null}
			</div>
			<div className="flex flex-1 flex-col">
				<ServiceRow
					name="API"
					detail={
						health === "unknown" ? "state unknown" : health === "ok" ? "reachable" : "unreachable"
					}
					ok={health === "ok" ? true : health === "down" ? false : null}
				/>
				{services === undefined ? null : (
					<>
						<ServiceRow
							name="Database"
							detail={services.dbReachable ? "reachable" : "unreachable"}
							ok={services.dbReachable}
						/>
						<ServiceRow
							name="Event stream"
							detail={services.lifecycleStream ? "connected" : "polling"}
							ok={services.lifecycleStream ? true : null}
						/>
					</>
				)}
			</div>
		</div>
	);
}
