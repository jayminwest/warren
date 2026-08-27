import type { CapabilityName } from "@/api/types.ts";

/**
 * Direction C console navigation (warren-4ed7 / pl-7e38 step 2).
 *
 * The IA is fixed by the canvas index artboard (docs/ui-revamp/README.md):
 * WORKLOADS = 01 Operations / 02 Runs / 03 Plan runs,
 * INFRASTRUCTURE = 04 Projects / 05 Agents / 06 Telemetry, footer =
 * 07 Instance + Documentation. The mono indices are part of the design —
 * do not renumber without a canvas change.
 *
 * Addendum (warren-1c7b): the Event explorer page (warren-24b9) shipped
 * orphaned, so Events was appended to INFRASTRUCTURE as 07 and the footer
 * Instance index moved to 08. A canvas update should ratify this ordering.
 */

export interface ConsoleNavItem {
	/** Mono index rendered before the label ("01"…"08"). */
	readonly index: string;
	readonly label: string;
	readonly to: string;
	/**
	 * Capability the destination's own reads require. Absent = every
	 * caller warren admits can read the page, so the entry always shows.
	 */
	readonly capability?: CapabilityName;
}

export const WORKLOADS_NAV: readonly ConsoleNavItem[] = [
	{ index: "01", label: "Operations", to: "/operations" },
	{ index: "02", label: "Runs", to: "/runs" },
	{ index: "03", label: "Plan runs", to: "/plan-runs" },
];

export const INFRASTRUCTURE_NAV: readonly ConsoleNavItem[] = [
	{ index: "04", label: "Projects", to: "/projects" },
	{ index: "05", label: "Agents", to: "/agents" },
	{ index: "06", label: "Telemetry", to: "/telemetry" },
	{ index: "07", label: "Events", to: "/events" },
];

/** Footer entry: 08 Instance. */
export const INSTANCE_NAV_ITEM: ConsoleNavItem = {
	index: "08",
	label: "Instance",
	to: "/instance",
};

/**
 * First-run setup entry point (warren-a911): rendered in the sidebar
 * only while the instance has no runs AND this caller can act on the
 * checklist (warren-ed11). Index "00" — it sits before everything else.
 */
export const SETUP_NAV_ITEM: ConsoleNavItem = {
	index: "00",
	label: "Setup",
	to: "/setup",
	capability: "admin",
};

/** Docs live in the repo; the console links out to the README. */
export const DOCUMENTATION_URL = "https://github.com/jayminwest/warren#readme";

/**
 * Mobile bottom tab bar entries (warren-4d4a, pl-4ab6). The artboards
 * give the bottom nav its own index set — Dispatch is "03" here even
 * though the sidebar gives 03 to Plan runs (mobile/*.jsx bottom bars).
 * The fifth tab ("·· More") is the drawer trigger, not a route, so it
 * lives in the component rather than this list.
 */
export const MOBILE_BOTTOM_NAV_ITEMS: readonly ConsoleNavItem[] = [
	{ index: "01", label: "Operations", to: "/operations" },
	{ index: "02", label: "Runs", to: "/runs" },
	{ index: "03", label: "Dispatch", to: "/dispatch" },
	{ index: "06", label: "Telemetry", to: "/telemetry" },
];

/** All nav entries, footer included — used by the mobile drawer. */
export const ALL_NAV_SECTIONS: readonly {
	readonly heading: string;
	readonly items: readonly ConsoleNavItem[];
}[] = [
	{ heading: "WORKLOADS", items: WORKLOADS_NAV },
	{ heading: "INFRASTRUCTURE", items: INFRASTRUCTURE_NAV },
];
