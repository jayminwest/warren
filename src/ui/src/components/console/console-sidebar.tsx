import { useQuery, useQueryClient } from "@tanstack/react-query";
import { LogIn, LogOut } from "lucide-react";
import { NavLink, useNavigate } from "react-router-dom";
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
import { WarrenLogo } from "@/components/warren-logo.tsx";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";

/**
 * The fixed 224px Direction C sidebar (warren-4ed7). Structure follows
 * docs/ui-revamp/screens/operations.jsx; colors come only from the token
 * variables so the light/dark swap is automatic.
 */

/** Mono right-aligned count, "—" while unknown (never a fabricated number). */
function NavCount({ value }: { value: number | null }) {
	return (
		<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">
			{value === null ? "—" : value}
		</span>
	);
}

function NavRow({
	item,
	count,
	onNavigate,
}: {
	item: ConsoleNavItem;
	count?: number | null;
	onNavigate?: () => void;
}) {
	return (
		<NavLink
			to={item.to}
			onClick={onNavigate}
			className={({ isActive }) =>
				cn(
					"flex h-[34px] items-center gap-2.5 rounded-(--radius-sm) px-[9px]",
					isActive
						? "bg-(--color-surface-raised) text-(--color-text)"
						: "text-(--color-text-2) hover:bg-(--color-surface-raised)",
				)
			}
		>
			{({ isActive }) => (
				<>
					<span
						className={cn(
							"w-max shrink-0 text-center font-mono text-[11px] leading-[14px]",
							isActive ? "text-(--color-primary)" : "text-(--color-text-3)",
						)}
					>
						{item.index}
					</span>
					<span
						className={cn(
							"text-[12px] leading-4",
							isActive ? "text-(--color-text)" : "text-(--color-text-2)",
						)}
					>
						{item.label}
					</span>
					<span className="flex-1" />
					{count !== undefined ? <NavCount value={count} /> : null}
				</>
			)}
		</NavLink>
	);
}

function SectionHeading({ label }: { label: string }) {
	return (
		<div className="px-[9px] pb-1.5 pt-4">
			<span className="text-[10px] font-semibold leading-3 tracking-[0.08em] text-(--color-text-3)">
				{label}
			</span>
		</div>
	);
}

function HealthDot({ health }: { health: ConsoleStats["health"] }) {
	return (
		<span
			className={cn(
				"h-1.5 w-1.5 shrink-0 rounded-full",
				health === "ok" && "bg-(--color-success)",
				health === "down" && "bg-(--color-danger)",
				health === "unknown" && "bg-(--color-text-3)",
			)}
			aria-hidden
		/>
	);
}

/** Environment/instance card under the brand row. */
function InstanceCard({ stats }: { stats: ConsoleStats }) {
	const caps = useCapabilities();
	// The canvas shows deployment facts (env, runtime, region) the current
	// API does not serve; the shell shows the caller's access mode instead —
	// real data now, the full card lands with the ops overview (warren-d903).
	const isOperator = caps.can("readOperator");
	return (
		<div className="mt-3 flex shrink-0 items-center gap-2 rounded-(--radius-md) border border-(--color-border) bg-(--color-surface) py-[9px] pr-2.5 pl-2.5">
			<span className="flex w-2 shrink-0 items-center">
				<HealthDot health={stats.health} />
			</span>
			<div className="flex min-w-0 flex-1 flex-col gap-[3px]">
				<span className="text-[12px] leading-4 font-medium text-(--color-text)">
					{isOperator ? "operator" : "read-only"}
				</span>
				<span className="truncate font-mono text-[10px] leading-3 text-(--color-text-3)">
					{isOperator ? "read-write session" : "spectator projection"}
				</span>
			</div>
		</div>
	);
}

/** Brand row: mark + name + version. */
function BrandRow() {
	const version = useQuery({
		queryKey: ["meta", "version"],
		queryFn: ({ signal }) => metaApi.version(signal),
		staleTime: Number.POSITIVE_INFINITY,
		retry: false,
	});
	return (
		<div className="flex h-[58px] shrink-0 items-center gap-2.5 border-b border-(--color-border) px-4">
			<WarrenLogo className="h-[22px] w-[22px] shrink-0" />
			<span className="text-[13px] leading-4 font-semibold tracking-[-0.02em] text-(--color-text)">
				warren
			</span>
			<span className="flex-1" />
			{version.data ? (
				<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">
					v{version.data.version}
				</span>
			) : null}
		</div>
	);
}

/** Footer: 07 Instance, Documentation, identity row, theme, session. */
function SidebarFooter({ onNavigate }: { onNavigate?: () => void }) {
	const caps = useCapabilities();
	const qc = useQueryClient();
	const navigate = useNavigate();
	const identity = caps.status === "ready" ? caps.identity : null;
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
		<div className="flex shrink-0 flex-col gap-0.5 border-t border-(--color-border) p-[9px]">
			<NavRow item={INSTANCE_NAV_ITEM} onNavigate={onNavigate} />
			<a
				href={DOCUMENTATION_URL}
				target="_blank"
				rel="noreferrer"
				onClick={onNavigate}
				className="flex h-8 items-center gap-2.5 rounded-(--radius-sm) px-[9px] text-[11px] leading-[14px] text-(--color-text-3) hover:text-(--color-text-2)"
			>
				<span className="w-max shrink-0 text-center font-mono text-[11px] leading-[14px]">↗</span>
				Documentation
			</a>
			<div className="flex h-8 items-center gap-2.5 px-[9px]">
				<span className="w-max shrink-0 text-center font-mono text-[10px] leading-3 text-(--color-text-3)">
					··
				</span>
				<span className="font-mono text-[10px] leading-3 text-(--color-text-3)">
					{identity === "operator" ? "operator@warren" : "spectator"}
				</span>
			</div>
			{/* Session + theme controls. The spectator slot doubles as the way
			    back in to /login on a public instance (warren-f53e). */}
			<div className="mt-1 flex flex-col">
				{isOperator ? (
					<button
						type="button"
						onClick={handleLogout}
						className="flex h-8 items-center gap-2 px-1 text-[11px] text-(--color-text-3) hover:text-(--color-text-2)"
					>
						<LogOut className="h-3.5 w-3.5" />
						Log out
					</button>
				) : (
					<NavLink
						to="/login"
						onClick={onNavigate}
						className="flex h-8 items-center gap-2 px-1 text-[11px] text-(--color-text-3) hover:text-(--color-text-2)"
					>
						<LogIn className="h-3.5 w-3.5" />
						Log in
					</NavLink>
				)}
				<ThemeToggle />
			</div>
		</div>
	);
}

/**
 * The sidebar body, shared by the desktop rail and the mobile drawer.
 * `counts` maps a nav `to` path to its sidebar count figure.
 */
export function ConsoleSidebarBody({
	stats,
	onNavigate,
}: {
	stats: ConsoleStats;
	onNavigate?: () => void;
}) {
	const caps = useCapabilities();
	// Same rule the legacy nav carried (warren-f53e): an entry whose
	// destination is readOperator never shows to a caller who would only
	// ever see a 403 there. Every Direction C entry is public-projection
	// readable today, so this filters nothing — it holds the seam for the
	// page issues that land gated destinations.
	const visible = (item: ConsoleNavItem): boolean =>
		item.capability === undefined || caps.can(item.capability);
	const counts: Record<string, number | null> = {
		"/operations": stats.runningCount,
		"/runs": stats.runsTotal,
		"/plan-runs": stats.planRunsCount,
		"/projects": stats.projectsCount,
		"/agents": stats.agentsCount,
	};
	return (
		<>
			<BrandRow />
			<InstanceCard stats={stats} />
			<nav className="flex flex-col px-[9px] pt-1.5">
				{ALL_NAV_SECTIONS.map((section) => (
					<div key={section.heading} className="flex flex-col">
						<SectionHeading label={section.heading} />
						{section.items.filter(visible).map((item) => (
							<NavRow key={item.to} item={item} count={counts[item.to]} onNavigate={onNavigate} />
						))}
					</div>
				))}
				{/* First-run setup (warren-a911): the manual entry point
				    back to the checklist, shown only to a caller who can
				    act on it and only while no run exists — once one
				    dispatches, the checklist is done and the entry
				    retires (warren-ed11). */}
				{caps.can("admin") && stats.runsTotal === 0 ? (
					<NavRow item={SETUP_NAV_ITEM} onNavigate={onNavigate} />
				) : null}
			</nav>
			<div className="flex-1" />
			<SidebarFooter onNavigate={onNavigate} />
		</>
	);
}

/** Desktop rail: fixed 224px column, hidden below md (drawer takes over). */
export function ConsoleSidebar({ stats }: { stats: ConsoleStats }) {
	return (
		<aside className="hidden w-56 shrink-0 flex-col border-r border-(--color-border) bg-(--color-sidebar) md:flex">
			<ConsoleSidebarBody stats={stats} />
		</aside>
	);
}
