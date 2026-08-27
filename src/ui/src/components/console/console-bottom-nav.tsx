import { NavLink } from "react-router-dom";
import { MOBILE_BOTTOM_NAV_ITEMS } from "@/components/console/console-nav.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Mobile bottom tab bar (warren-4d4a, pl-4ab6): the mock's 54px bar that
 * ends every phone artboard (docs/ui-revamp/screens/mobile/operations.jsx).
 * Five equal flex-1 tabs, each a centered two-line column with a 2px TOP
 * border — primary when active, transparent otherwise. The fifth tab
 * ("·· More") is not a route: it opens the existing mobile drawer.
 *
 * Numbering: the artboards label the bottom nav's Dispatch "03" even
 * though the sidebar gives 03 to Plan runs — the mobile bar follows the
 * artboards and the sidebar indices stay canvas-fixed (see console-nav.ts).
 * Phone only; mounted below md in the console shell.
 */

interface ConsoleBottomNavProps {
	readonly onOpenMore: () => void;
}

function tabClass(isActive: boolean): string {
	return cn(
		"flex flex-1 basis-0 flex-col items-center justify-center gap-[3px] border-t-2",
		isActive ? "border-t-(--color-primary)" : "border-t-transparent",
	);
}

export function ConsoleBottomNav({ onOpenMore }: ConsoleBottomNavProps) {
	return (
		<nav
			aria-label="Primary"
			className="flex h-[54px] shrink-0 border-t border-(--color-border) bg-(--color-sidebar) pb-[env(safe-area-inset-bottom)] md:hidden"
		>
			{MOBILE_BOTTOM_NAV_ITEMS.map((item) => (
				<NavLink key={item.to} to={item.to} className={({ isActive }) => tabClass(isActive)}>
					{({ isActive }) => (
						<>
							<span
								className={cn(
									"font-mono text-[9px] leading-[11px]",
									isActive ? "text-(--color-primary)" : "text-(--color-text-3)",
								)}
							>
								{item.index}
							</span>
							<span
								className={cn(
									"text-[10px] leading-3",
									isActive ? "font-medium text-(--color-text)" : "text-(--color-text-3)",
								)}
							>
								{item.label}
							</span>
						</>
					)}
				</NavLink>
			))}
			<button type="button" onClick={onOpenMore} className={tabClass(false)}>
				<span className="font-mono text-[9px] leading-[11px] text-(--color-text-3)">··</span>
				<span className="text-[10px] leading-3 text-(--color-text-3)">More</span>
			</button>
		</nav>
	);
}
