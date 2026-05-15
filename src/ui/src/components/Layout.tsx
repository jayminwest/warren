import { useQuery } from "@tanstack/react-query";
import { Activity, Bot, FolderGit2, LogOut, Plus } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { metaApi, setApiToken } from "@/api/client.ts";
import { ThemeToggle } from "@/components/ThemeToggle.tsx";
import { WarrenLogo } from "@/components/WarrenLogo.tsx";
import { Button } from "@/components/ui/button.tsx";
import { cn } from "@/lib/utils.ts";

const NAV_ITEMS: { to: string; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
	{ to: "/runs", label: "Runs", icon: Activity },
	{ to: "/agents", label: "Agents", icon: Bot },
	{ to: "/projects", label: "Projects", icon: FolderGit2 },
];

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
					{NAV_ITEMS.map(({ to, label, icon: Icon }) => (
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
