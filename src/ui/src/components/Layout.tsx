import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, FolderGit2, ListChecks, LogOut, Network, Plus } from "lucide-react";
import { useMemo } from "react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { metaApi, projectsApi, setApiToken } from "@/api/client.ts";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { WarrenLogo } from "@/components/WarrenLogo.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

type NavItem = { to: string; label: string; icon: React.ComponentType<{ className?: string }> };

const BASE_NAV_ITEMS: NavItem[] = [
	{ to: "/runs", label: "Runs", icon: Activity },
	{ to: "/plan-runs", label: "Plans", icon: ListChecks },
	{ to: "/projects", label: "Projects", icon: FolderGit2 },
	{ to: "/agents", label: "Agents", icon: Bot },
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
	const navItems = useMemo<NavItem[]>(() => {
		// Byte-identical to pre-Plots order when no project opted in —
		// preserves the CLAUDE.md standalone path (warren-e59a / pl-9d6a
		// step 19).
		if (!anyHasPlot) return BASE_NAV_ITEMS;
		// Plot-enabled deployments lead with Plots, then the existing
		// Runs → Plans → Projects → Agents order: Plots → Runs → Plans
		// → Projects → Agents.
		return [PLOTS_NAV_ITEM, ...BASE_NAV_ITEMS];
	}, [anyHasPlot]);

	const handleLogout = (): void => {
		setApiToken(null);
		navigate("/login", { replace: true });
	};

	return (
		<div className="flex min-h-screen">
			<aside className="hidden w-56 flex-col border-r bg-(--color-muted)/40 p-4 md:flex">
				<div className="mb-6 flex items-baseline gap-2 px-2">
					<WarrenLogo className="h-5 w-5 self-center" />
					<span className="text-base font-semibold">warren</span>
					{version.data ? (
						<span className="text-xs font-mono text-(--color-muted-foreground)">
							v{version.data.version}
						</span>
					) : null}
				</div>
				<nav className="flex flex-1 flex-col gap-1">
					{navItems.map(({ to, label, icon: Icon }) => (
						<NavLink
							key={to}
							to={to}
							className={({ isActive }) =>
								cn(
									"flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
									isActive
										? "bg-(--color-accent) font-medium text-(--color-fg)"
										: "text-(--color-muted-foreground) hover:bg-(--color-accent) hover:text-(--color-fg)",
								)
							}
						>
							<Icon className="h-4 w-4" />
							{label}
						</NavLink>
					))}
					<NavLink
						to="/runs/new"
						className={({ isActive }) =>
							cn(
								"mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors",
								isActive
									? "bg-(--color-primary) text-(--color-primary-foreground)"
									: "border bg-(--color-card) hover:bg-(--color-accent)",
							)
						}
					>
						<Plus className="h-4 w-4" />
						Dispatch run
					</NavLink>
				</nav>
				<ThemeToggle />
				<Button variant="ghost" size="sm" onClick={handleLogout} className="mt-2 justify-start">
					<LogOut className="h-4 w-4" />
					Log out
				</Button>
			</aside>
			<main className="min-w-0 flex-1 p-6 md:p-8">
				<Outlet />
			</main>
		</div>
	);
}
