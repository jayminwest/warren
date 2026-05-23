import * as DialogPrimitive from "@radix-ui/react-dialog";
import { useQuery } from "@tanstack/react-query";
import {
	Activity,
	Bot,
	DollarSign,
	FolderGit2,
	ListChecks,
	LogOut,
	Menu,
	Network,
	Plus,
	X,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { NavLink, Outlet, useLocation, useNavigate } from "react-router-dom";
import { metaApi, plotsApi, projectsApi, setApiToken } from "@/api/client.ts";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { WarrenLogo } from "@/components/WarrenLogo.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

type NavItem = {
	to: string;
	label: string;
	icon: React.ComponentType<{ className?: string }>;
	/** Optional small counter rendered to the right of the label. */
	badge?: number;
};

const BASE_NAV_ITEMS: NavItem[] = [
	{ to: "/runs", label: "Runs", icon: Activity },
	{ to: "/plan-runs", label: "Plans", icon: ListChecks },
	{ to: "/projects", label: "Projects", icon: FolderGit2 },
	{ to: "/agents", label: "Agents", icon: Bot },
	// Cost analytics (warren-cf63 / pl-b0c0 step 6) lives at the bottom
	// of the sidebar — it's an operator-facing analytics view, not a
	// daily-driver page, so it stays out of the lead-eight positions.
	{ to: "/cost-analytics", label: "Cost", icon: DollarSign },
];

const PLOTS_NAV_ITEM: NavItem = { to: "/plots", label: "Plots", icon: Network };

export function Layout() {
	const navigate = useNavigate();

	// Version is auth-exempt and stable for the life of the server
	// process — fetch once, cache forever (warren-6ea5).
	const version = useQuery({
		queryKey: ["meta", "version"],
		queryFn: ({ signal }) => metaApi.version(signal),
		staleTime: Infinity,
		retry: false,
	});

	// Gate the Plots sidebar entry on at least one project having
	// `.plot/` provisioned. The projects list is the canonical source
	// for `hasPlot` (warren-4e20); reuse the same query key as the
	// Plots page so tanstack-query dedupes the fetch.
	const projects = useQuery({
		queryKey: ["projects"],
		queryFn: ({ signal }) => projectsApi.list(signal),
		staleTime: 5000,
	});
	const anyHasPlot = useMemo(
		() => (projects.data?.projects ?? []).some((p) => p.hasPlot),
		[projects.data],
	);

	// Needs-you sidebar badge (warren-f0e2 / pl-0344 step 13). Polls
	// the cheap `{count}` endpoint every 10s only when the deployment
	// has at least one `.plot/`-enabled project; non-Plot deployments
	// pay nothing. Errors collapse to undefined — the badge silently
	// hides rather than disrupting the sidebar layout.
	const needsAttention = useQuery({
		queryKey: ["plots", "needs-attention-count"],
		queryFn: ({ signal }) => plotsApi.needsAttentionCount(signal),
		enabled: anyHasPlot,
		refetchInterval: 10000,
		staleTime: 5000,
	});
	const needsAttentionBadge =
		needsAttention.data !== undefined && needsAttention.data.count > 0
			? needsAttention.data.count
			: undefined;

	const navItems = useMemo<NavItem[]>(() => {
		// Byte-identical to pre-Plots order when no project opted in —
		// preserves the CLAUDE.md standalone path (warren-e59a / pl-9d6a
		// step 19).
		if (!anyHasPlot) return BASE_NAV_ITEMS;
		// Plot-enabled deployments lead with Plots, then the existing
		// Runs → Plans → Projects → Agents order: Plots → Runs → Plans
		// → Projects → Agents.
		const plotsItem: NavItem =
			needsAttentionBadge !== undefined
				? { ...PLOTS_NAV_ITEM, badge: needsAttentionBadge }
				: PLOTS_NAV_ITEM;
		return [plotsItem, ...BASE_NAV_ITEMS];
	}, [anyHasPlot, needsAttentionBadge]);

	const handleLogout = (): void => {
		setApiToken(null);
		navigate("/login", { replace: true });
	};

	// Mobile drawer state (warren-fb3c / pl-4ed6 step 1). Drawer is
	// rendered only on viewports < md via Tailwind's `md:hidden`; the
	// desktop sidebar uses `hidden md:flex` so the two never co-exist
	// visually. We still close the drawer on route changes so a resize
	// from mobile → desktop while the drawer is open doesn't leave a
	// stale `open` flag (the overlay is `md:hidden` so it disappears
	// either way, but resetting state keeps it predictable).
	const [mobileNavOpen, setMobileNavOpen] = useState(false);
	const location = useLocation();
	useEffect(() => {
		setMobileNavOpen(false);
	}, [location.pathname]);

	const renderNavLinks = (onNavigate?: () => void) => (
		<>
			{navItems.map(({ to, label, icon: Icon, badge }) => (
				<NavLink
					key={to}
					to={to}
					onClick={onNavigate}
					className={({ isActive }) =>
						cn(
							"flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
							isActive
								? "bg-(--color-accent) font-medium text-(--color-fg)"
								: "text-(--color-muted-foreground) hover:bg-(--color-accent) hover:text-(--color-fg)",
						)
					}
				>
					<Icon className="h-4 w-4" />
					<span className="flex-1">{label}</span>
					{badge !== undefined ? (
						<span
							aria-label={`${badge} need${badge === 1 ? "" : "s"} your attention`}
							className="ml-auto rounded-full bg-(--color-primary) px-1.5 py-0.5 text-xs font-mono text-(--color-primary-foreground)"
						>
							{badge > 99 ? "99+" : badge}
						</span>
					) : null}
				</NavLink>
			))}
			<NavLink
				to="/runs/new"
				onClick={onNavigate}
				className={({ isActive }) =>
					cn(
						"mt-2 flex min-h-11 items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
						isActive
							? "bg-(--color-primary) text-(--color-primary-foreground)"
							: "border bg-(--color-card) hover:bg-(--color-accent)",
					)
				}
			>
				<Plus className="h-4 w-4" />
				Dispatch run
			</NavLink>
		</>
	);

	const brand = (
		<div className="flex items-baseline gap-2 px-2">
			<WarrenLogo className="h-5 w-5 self-center" />
			<span className="text-base font-semibold">warren</span>
			{version.data ? (
				<span className="text-xs font-mono text-(--color-muted-foreground)">
					v{version.data.version}
				</span>
			) : null}
		</div>
	);

	return (
		<div className="flex min-h-screen flex-col md:flex-row">
			{/* Mobile top header — visible only < md. */}
			<header className="sticky top-0 z-40 flex items-center justify-between gap-2 border-b bg-(--color-card) px-4 py-2 md:hidden">
				{brand}
				<Button
					variant="ghost"
					size="sm"
					aria-label="Open navigation menu"
					aria-expanded={mobileNavOpen}
					onClick={() => setMobileNavOpen(true)}
					className="h-11 w-11 p-0"
				>
					<Menu className="h-5 w-5" />
				</Button>
			</header>

			{/* Desktop sidebar — visible only >= md. */}
			<aside className="hidden w-56 flex-col border-r bg-(--color-muted)/40 p-4 md:flex">
				<div className="mb-6">{brand}</div>
				<nav className="flex flex-1 flex-col gap-1">{renderNavLinks()}</nav>
				<ThemeToggle />
				<Button variant="ghost" size="sm" onClick={handleLogout} className="mt-2 justify-start">
					<LogOut className="h-4 w-4" />
					Log out
				</Button>
			</aside>

			{/* Mobile slide-over drawer. Radix Dialog gives focus trap +
			    Esc + overlay-click close for free. We position the content
			    as a left-anchored panel and hide the whole tree on md+ so
			    desktop never instantiates portal nodes. */}
			<DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
				<DialogPrimitive.Portal>
					<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm md:hidden" />
					<DialogPrimitive.Content
						aria-label="Navigation"
						className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r bg-(--color-card) p-4 shadow-lg md:hidden"
					>
						<DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
						<div className="mb-6 flex items-center justify-between">
							{brand}
							<DialogPrimitive.Close asChild>
								<Button
									variant="ghost"
									size="sm"
									aria-label="Close navigation menu"
									className="h-11 w-11 p-0"
								>
									<X className="h-5 w-5" />
								</Button>
							</DialogPrimitive.Close>
						</div>
						<nav className="flex flex-1 flex-col gap-1">
							{renderNavLinks(() => setMobileNavOpen(false))}
						</nav>
						<ThemeToggle />
						<Button
							variant="ghost"
							size="sm"
							onClick={handleLogout}
							className="mt-2 justify-start"
						>
							<LogOut className="h-4 w-4" />
							Log out
						</Button>
					</DialogPrimitive.Content>
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>

			<main className="min-w-0 flex-1 p-4 sm:p-6 md:p-8">
				<Outlet />
			</main>
		</div>
	);
}
