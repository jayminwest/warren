import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo, useState } from "react";
import {
	type RunAnalyticsResponse,
	type RunBehaviorResponse,
	runAnalyticsApi,
} from "@/api/client.ts";
import { useCapabilities } from "@/hooks/use-capabilities.ts";

/**
 * The Telemetry window (warren-7197 / pl-7e38 step 14): the shared
 * date-range + data slice every tab of the consolidated page reads.
 *
 * The range lives in layout state (not the URL): the tab strip is child
 * routes, and a URL param would be dropped by every tab NavLink. The
 * layout route stays mounted across child switches, so useState here
 * survives navigation between the four tabs — the same shape the Paper
 * artboards draw (one range selector above all four tabs).
 */

export const TELEMETRY_RANGE_DAYS = [7, 14, 30, 90] as const;
export type TelemetryRangeDays = (typeof TELEMETRY_RANGE_DAYS)[number];
export const DEFAULT_TELEMETRY_RANGE_DAYS = 14 satisfies TelemetryRangeDays;

export interface TelemetryWindow {
	readonly days: TelemetryRangeDays;
	readonly setDays: (days: TelemetryRangeDays) => void;
	/** ISO instant: the window start (now - days). */
	readonly from: string;
	/** ISO instant: the window end (now). */
	readonly to: string;
	readonly runs: UseQueryResult<RunAnalyticsResponse>;
	/**
	 * `GET /analytics/behavior` is readOperator (directory names are repo
	 * layout, warren-bba5), so the query is disabled for a spectator and
	 * the behavior tab renders its public sections only.
	 */
	readonly behavior: UseQueryResult<RunBehaviorResponse>;
	readonly isOperator: boolean;
}

const TelemetryWindowContext = createContext<TelemetryWindow | null>(null);

export function TelemetryWindowProvider({ children }: { children: ReactNode }) {
	const [days, setDays] = useState<TelemetryRangeDays>(DEFAULT_TELEMETRY_RANGE_DAYS);

	const { from, to } = useMemo(() => {
		const now = Date.now();
		return {
			from: new Date(now - days * 24 * 60 * 60 * 1000).toISOString(),
			to: new Date(now).toISOString(),
		};
	}, [days]);

	const caps = useCapabilities();
	const isOperator = caps.can("readOperator");

	const runs = useQuery({
		queryKey: ["analytics", "runs", { projectId: null, from, to }],
		queryFn: ({ signal }) => runAnalyticsApi.runs({ from, to }, signal),
	});

	const behavior = useQuery({
		queryKey: ["analytics", "behavior", { projectId: null, from, to }],
		queryFn: ({ signal }) => runAnalyticsApi.behavior({ from, to }, signal),
		enabled: isOperator,
	});

	const value = useMemo<TelemetryWindow>(
		() => ({ days, setDays, from, to, runs, behavior, isOperator }),
		[days, from, to, runs, behavior, isOperator],
	);

	return (
		<TelemetryWindowContext.Provider value={value}>{children}</TelemetryWindowContext.Provider>
	);
}

/** Read the shared telemetry window. Must run inside the layout. */
export function useTelemetryWindow(): TelemetryWindow {
	const ctx = useContext(TelemetryWindowContext);
	if (ctx === null) {
		throw new Error("useTelemetryWindow must be used within TelemetryWindowProvider");
	}
	return ctx;
}
