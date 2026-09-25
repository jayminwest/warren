import {
	Activity,
	Bot,
	FolderGit2,
	Gauge,
	Home,
	Layers,
	type LucideIcon,
	Play,
	Rocket,
	Server,
	SquareActivity,
} from "lucide-react";
import type { CapabilityName } from "@/api/types.ts";

/**
 * Console navigation (warren-a8c9, plan pl-fae9). Every page stays
 * top-level. Home is the index route; Operations, Telemetry, Events and
 * Instance keep their own entries. Icons replace the old mono indices.
 * `key` is the second letter of the `G <key>` jump chord — the shortcut
 * help and the command palette both read it from here.
 */

export interface ConsoleNavItem {
	readonly label: string;
	readonly to: string;
	readonly icon: LucideIcon;
	/** Second key of the `G <key>` navigation chord. */
	readonly key?: string;
	/** Match only the exact path (the index route). */
	readonly end?: boolean;
	/**
	 * Capability the destination's own reads require. Absent = every
	 * caller warren admits can read the page, so the entry always shows.
	 */
	readonly capability?: CapabilityName;
}

export const HOME_NAV_ITEM: ConsoleNavItem = {
	label: "Home",
	to: "/",
	icon: Home,
	key: "h",
	end: true,
};

export const WORKLOADS_NAV: readonly ConsoleNavItem[] = [
	{ label: "Operations", to: "/operations", icon: Gauge, key: "o" },
	{ label: "Runs", to: "/runs", icon: Play, key: "r" },
	{ label: "Plan runs", to: "/plan-runs", icon: Layers, key: "p" },
];

export const INFRASTRUCTURE_NAV: readonly ConsoleNavItem[] = [
	{ label: "Projects", to: "/projects", icon: FolderGit2, key: "j" },
	{ label: "Agents", to: "/agents", icon: Bot, key: "a" },
	{ label: "Telemetry", to: "/telemetry", icon: SquareActivity, key: "t" },
	{ label: "Events", to: "/events", icon: Activity, key: "e" },
];

/** Footer entry. */
export const INSTANCE_NAV_ITEM: ConsoleNavItem = {
	label: "Instance",
	to: "/instance",
	icon: Server,
	key: "i",
};

/**
 * First-run setup entry point (warren-a911): rendered in the sidebar
 * only while the instance has no runs AND this caller can act on the
 * checklist (warren-ed11).
 */
export const SETUP_NAV_ITEM: ConsoleNavItem = {
	label: "Setup",
	to: "/setup",
	icon: Rocket,
	capability: "admin",
};

/** Docs live in the repo; the console links out to the README. */
export const DOCUMENTATION_URL = "https://github.com/jayminwest/warren#readme";

/**
 * Mobile bottom tab bar entries (warren-4d4a). The fifth tab ("More") is
 * the drawer trigger, not a route, so it lives in the component.
 */
export const MOBILE_BOTTOM_NAV_ITEMS: readonly ConsoleNavItem[] = [
	HOME_NAV_ITEM,
	{ label: "Runs", to: "/runs", icon: Play },
	{ label: "Dispatch", to: "/dispatch", icon: Rocket, capability: "dispatch" },
	{ label: "Operations", to: "/operations", icon: Gauge },
];

/** Sidebar sections, in order. A null heading renders no label. */
export const ALL_NAV_SECTIONS: readonly {
	readonly heading: string | null;
	readonly items: readonly ConsoleNavItem[];
}[] = [
	{ heading: null, items: [HOME_NAV_ITEM] },
	{ heading: "Workloads", items: WORKLOADS_NAV },
	{ heading: "Infrastructure", items: INFRASTRUCTURE_NAV },
];

/** Every chord-reachable destination, for the key handler and help. */
export const CHORD_NAV_ITEMS: readonly ConsoleNavItem[] = [
	HOME_NAV_ITEM,
	...WORKLOADS_NAV,
	...INFRASTRUCTURE_NAV,
	INSTANCE_NAV_ITEM,
];
