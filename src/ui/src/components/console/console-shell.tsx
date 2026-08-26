import * as DialogPrimitive from "@radix-ui/react-dialog";
import { Menu, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Outlet, useLocation } from "react-router-dom";
import { ConsoleSidebar, ConsoleSidebarBody } from "@/components/console/console-sidebar.tsx";
import { ConsoleTopbar } from "@/components/console/console-topbar.tsx";
import { useConsoleStats } from "@/components/console/use-console-stats.ts";
import { ErrorBoundary } from "@/components/error-boundary.tsx";
import { Button } from "@/components/ui/button.tsx";

/**
 * The Direction C operator-console shell (warren-4ed7, pl-7e38 step 2):
 * fixed 224px sidebar + 42px status strip, with the routed page below.
 * Every later page issue mounts inside this shell via the Outlet.
 *
 * Below md the sidebar collapses into a drawer (the full responsive pass
 * is warren-dea8); the status strip stays, with the wider-only figures
 * hidden on narrow viewports.
 */
export function ConsoleShell() {
	const stats = useConsoleStats();
	const location = useLocation();
	const [mobileNavOpen, setMobileNavOpen] = useState(false);

	// Close the drawer on route change so a mobile → desktop resize never
	// leaves a stale open flag (same pattern the legacy layout used).
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname is the trigger, not a read
	useEffect(() => {
		setMobileNavOpen(false);
	}, [location.pathname]);

	return (
		<div className="flex h-dvh flex-col md:flex-row">
			<ConsoleSidebar stats={stats} />

			{/* Mobile header + main column. */}
			<div className="flex min-h-0 min-w-0 flex-1 flex-col">
				{/* Mobile top strip — visible only < md. */}
				<header className="flex h-[42px] shrink-0 items-center gap-3 border-b border-(--color-border) md:hidden">
					<Button
						variant="ghost"
						size="sm"
						aria-label="Open navigation menu"
						aria-expanded={mobileNavOpen}
						onClick={() => setMobileNavOpen(true)}
						className="h-8 w-8 p-0"
					>
						<Menu className="h-4 w-4" />
					</Button>
					<ConsoleTopbar stats={stats} />
				</header>

				{/* Desktop status strip. */}
				<div className="hidden md:flex">
					<ConsoleTopbar stats={stats} />
				</div>

				<main className="min-h-0 min-w-0 flex-1 overflow-y-auto">
					{/* Boundary sits INSIDE the chrome so a page-level throw costs
					    the page, not the shell (warren-1f12). */}
					<ErrorBoundary resetKey={location.pathname}>
						<Outlet />
					</ErrorBoundary>
				</main>
			</div>

			{/* Mobile slide-over drawer: same sidebar body as the desktop rail. */}
			<DialogPrimitive.Root open={mobileNavOpen} onOpenChange={setMobileNavOpen}>
				<DialogPrimitive.Portal>
					<DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm md:hidden" />
					<DialogPrimitive.Content
						aria-label="Navigation"
						className="fixed inset-y-0 left-0 z-50 flex w-72 max-w-[85vw] flex-col border-r border-(--color-border) bg-(--color-sidebar) shadow-lg md:hidden"
					>
						<DialogPrimitive.Title className="sr-only">Navigation</DialogPrimitive.Title>
						<div className="relative">
							<ConsoleSidebarBody stats={stats} onNavigate={() => setMobileNavOpen(false)} />
						</div>
						<DialogPrimitive.Close asChild>
							<Button
								variant="ghost"
								size="sm"
								aria-label="Close navigation menu"
								className="absolute top-2 right-2 h-8 w-8 p-0"
							>
								<X className="h-4 w-4" />
							</Button>
						</DialogPrimitive.Close>
					</DialogPrimitive.Content>
				</DialogPrimitive.Portal>
			</DialogPrimitive.Root>
		</div>
	);
}
