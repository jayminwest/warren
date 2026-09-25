import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUpRight, LogIn, LogOut, Plus, Search } from "lucide-react";
import { Link, NavLink, useNavigate } from "react-router-dom";
import { metaApi, setApiToken } from "@/api/client.ts";
import {
	ALL_NAV_SECTIONS,
	type ConsoleNavItem,
	DOCUMENTATION_URL,
	INSTANCE_NAV_ITEM,
	SETUP_NAV_ITEM,
} from "@/components/console/console-nav.ts";
import type { ConsoleStats } from "@/components/console/use-console-stats.ts";
import { ThemeToggle } from "@/components/theme-toggle.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";
import { WarrenLogo } from "@/components/warren-logo.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The 224px console sidebar (warren-4ed7, polished in warren-a8c9). Brand
 * row, the two primary actions (search and new run), icon nav with live
 * counts, and a footer with the instance entry and the session controls.
 * Colors come only from token variables, so the theme swap is automatic.
 */

function NavCount({ value }: { value: number | null }) {
	if (value === null) return null;
	return <span className="text-xs tabular-nums text-(--color-text-3)">{value}</span>;
}

function NavRow({
	item,
	count,
	live,
	onNavigate,
}: {
	item: ConsoleNavItem;
	count?: number | null;
	/** Pulse a dot beside the count while work is in flight. */
	live?: boolean;
	onNavigate?: () => void;
}) {
	const Icon = item.icon;
	return (
		<NavLink
			to={item.to}
			end={item.end}
			onClick={onNavigate}
			className={({ isActive }) =>
				cn(
					"group flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm transition-colors",
					isActive
						? "bg-(--color-surface-raised) font-medium text-(--color-text)"
						: "text-(--color-text-2) hover:bg-(--color-surface-raised)/60 hover:text-(--color-text)",
				)
			}
		>
			{({ isActive }) => (
				<>
					<Icon
						aria-hidden
						className={cn(
							"size-4 shrink-0",
							isActive
								? "text-(--color-primary)"
								: "text-(--color-text-3) group-hover:text-(--color-text-2)",
						)}
					/>
					<span className="truncate">{item.label}</span>
					<span className="flex-1" />
					{live ? (
						<span
							aria-hidden
							className="size-1.5 rounded-full bg-(--color-info) text-(--color-info) animate-pulse-ring"
						/>
					) : null}
					{count !== undefined ? <NavCount value={count} /> : null}
				</>
			)}
		</NavLink>
	);
}

function SectionHeading({ label }: { label: string }) {
	return <div className="px-2 pt-4 pb-1 text-xs font-medium text-(--color-text-3)">{label}</div>;
}

/** Brand row: mark + instance name + version. */
function BrandRow({ stats, onNavigate }: { stats: ConsoleStats; onNavigate?: () => void }) {
	const version = useQuery({
		queryKey: ["meta", "version"],
		queryFn: ({ signal }) => metaApi.version(signal),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	return (
		<div className="flex h-13 shrink-0 items-center gap-2.5 px-4">
			<Link
				to="/"
				aria-label="Warren home"
				onClick={onNavigate}
				className="flex min-w-0 items-center gap-2.5 rounded-sm focus-visible:outline-2 focus-visible:outline-offset-4"
			>
				<WarrenLogo className="size-5.5 shrink-0" />
				<span className="flex min-w-0 flex-col leading-tight">
					<span className="text-sm font-semibold tracking-tight text-(--color-text)">warren</span>
					{stats.instanceName ? (
						<span className="truncate text-2xs text-(--color-text-3)">{stats.instanceName}</span>
					) : null}
				</span>
			</Link>
			<span className="flex-1" />
			{version.data ? (
				<span className="text-2xs tabular-nums text-(--color-text-3)">v{version.data.version}</span>
			) : null}
		</div>
	);
}

/** Search trigger and the primary "New run" action. */
function ActionRow({ onOpenPalette, onNavigate }: ActionProps) {
	const caps = useCapabilities();
	return (
		<div className="flex shrink-0 flex-col gap-1.5 px-3 pb-1">
			{onOpenPalette ? (
				<button
					type="button"
					onClick={onOpenPalette}
					className="flex h-8 items-center gap-2 rounded-sm border border-(--color-border) bg-(--color-surface) px-2 text-sm text-(--color-text-3) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text-2)"
				>
					<Search aria-hidden className="size-3.5" />
					<span className="flex-1 text-left">Search</span>
					<Kbd>⌘K</Kbd>
				</button>
			) : null}
			{caps.can("dispatch") ? (
				<Link
					to="/dispatch"
					onClick={onNavigate}
					className="flex h-8 items-center gap-2 rounded-sm bg-(--color-primary) px-2 text-sm font-medium text-(--color-primary-ink) transition-opacity hover:opacity-90"
				>
					<Plus aria-hidden className="size-4" />
					<span className="flex-1">New run</span>
					<Kbd className="border-transparent bg-black/15 text-(--color-primary-ink)">C</Kbd>
				</Link>
			) : null}
		</div>
	);
}

interface ActionProps {
	onOpenPalette?: () => void;
	onNavigate?: () => void;
}

/** Footer: Instance, Documentation, identity, session, theme. */
function SidebarFooter({ stats, onNavigate }: { stats: ConsoleStats; onNavigate?: () => void }) {
	const caps = useCapabilities();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const isOperator = caps.can("readOperator");

	const handleLogout = (): void => {
		setApiToken(null);
		// The whole cache was fetched under the operator's bearer — including
		// the /whoami answer the capability layer reads. Drop it all so the
		// next mount re-asks as the credential-less caller (warren-f53e).
		qc.clear();
		navigate("/login", { replace: true });
	};

	return (
		<div className="flex shrink-0 flex-col gap-0.5 border-t border-(--color-border) p-2">
			<NavRow item={INSTANCE_NAV_ITEM} onNavigate={onNavigate} />
			<a
				href={DOCUMENTATION_URL}
				target="_blank"
				rel="noreferrer"
				onClick={onNavigate}
				className="flex h-8 items-center gap-2.5 rounded-sm px-2 text-sm text-(--color-text-2) hover:bg-(--color-surface-raised)/60 hover:text-(--color-text)"
			>
				<ArrowUpRight aria-hidden className="size-4 text-(--color-text-3)" />
				Documentation
			</a>
			<div className="mt-1 flex items-center gap-2 rounded-sm px-2 py-1.5">
				<span
					aria-hidden
					title={stats.health === "ok" ? "Healthy" : stats.health === "down" ? "Unreachable" : ""}
					className={cn(
						"size-1.5 shrink-0 rounded-full",
						stats.health === "ok" && "bg-(--color-success)",
						stats.health === "down" && "bg-(--color-danger)",
						stats.health === "unknown" && "bg-(--color-text-3)",
					)}
				/>
				<span className="flex-1 truncate text-sm text-(--color-text-2)">
					{isOperator ? "Operator" : "Read-only"}
				</span>
				{isOperator ? (
					<button
						type="button"
						onClick={handleLogout}
						title="Log out"
						aria-label="Log out"
						className="rounded-xs p-1 text-(--color-text-3) hover:bg-(--color-surface-raised) hover:text-(--color-text-2)"
					>
						<LogOut className="size-3.5" />
					</button>
				) : (
					// The spectator slot doubles as the way back in to /login on
					// a public instance (warren-f53e).
					<NavLink
						to="/login"
						onClick={onNavigate}
						className="flex items-center gap-1 rounded-xs px-1 text-xs text-(--color-text-3) hover:text-(--color-text-2)"
					>
						<LogIn className="size-3.5" />
						Log in
					</NavLink>
				)}
			</div>
			<ThemeToggle />
		</div>
	);
}

/**
 * The sidebar body, shared by the desktop rail and the mobile drawer.
 */
export function ConsoleSidebarBody({
	stats,
	onNavigate,
	onOpenPalette,
}: {
	stats: ConsoleStats;
	onNavigate?: () => void;
	onOpenPalette?: () => void;
}) {
	const caps = useCapabilities();
	// Same rule the legacy nav carried (warren-f53e): an entry whose
	// destination is readOperator never shows to a caller who would only
	// ever see a 403 there.
	const visible = (item: ConsoleNavItem): boolean =>
		item.capability === undefined || caps.can(item.capability);
	const counts: Record<string, number | null> = {
		"/runs": stats.runsTotal,
		"/plan-runs": stats.planRunsCount,
		"/projects": stats.projectsCount,
		"/agents": stats.agentsCount,
	};
	const isLive = (stats.runningCount ?? 0) > 0;
	return (
		<>
			<BrandRow stats={stats} onNavigate={onNavigate} />
			<ActionRow onOpenPalette={onOpenPalette} onNavigate={onNavigate} />
			<nav aria-label="Console" className="flex min-h-0 flex-col overflow-y-auto px-2 pt-2">
				{ALL_NAV_SECTIONS.map((section) => (
					<div key={section.heading ?? "top"} className="flex flex-col gap-px">
						{section.heading ? <SectionHeading label={section.heading} /> : null}
						{section.items.filter(visible).map((item) => (
							<NavRow
								key={item.to}
								item={item}
								count={counts[item.to]}
								live={item.to === "/operations" && isLive}
								onNavigate={onNavigate}
							/>
						))}
					</div>
				))}
				{/* First-run setup (warren-a911): shown only to a caller who
				    can act on it and only while no run exists (warren-ed11). */}
				{caps.can("admin") && stats.runsTotal === 0 ? (
					<div className="mt-3">
						<NavRow item={SETUP_NAV_ITEM} onNavigate={onNavigate} />
					</div>
				) : null}
			</nav>
			<div className="flex-1" />
			<SidebarFooter stats={stats} onNavigate={onNavigate} />
		</>
	);
}

/** Desktop rail: fixed 224px column, hidden below md (drawer takes over). */
export function ConsoleSidebar({
	stats,
	onOpenPalette,
}: {
	stats: ConsoleStats;
	onOpenPalette: () => void;
}) {
	return (
		<aside className="hidden w-56 shrink-0 flex-col border-r border-(--color-border) bg-(--color-sidebar) md:flex">
			<ConsoleSidebarBody stats={stats} onOpenPalette={onOpenPalette} />
		</aside>
	);
}
