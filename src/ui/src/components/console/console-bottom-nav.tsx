import { Menu } from "lucide-react";
import { NavLink } from "react-router-dom";
import { type ConsoleNavItem, MOBILE_BOTTOM_NAV_ITEMS } from "@/components/console/console-nav.ts";
import { useCapabilities } from "@/hooks/use-capabilities.ts";
import { cn } from "@/lib/utils.ts";

/**
 * Mobile bottom tab bar (warren-4d4a, polished in warren-a8c9): icon over
 * label, with a 2px top rule on the active tab. The last tab ("More") is
 * not a route: it opens the drawer. Phone only; mounted below md.
 */

interface ConsoleBottomNavProps {
	readonly onOpenMore: () => void;
}

function tabClass(isActive: boolean): string {
	return cn(
		"flex flex-1 basis-0 flex-col items-center justify-center gap-1 border-t-2 text-2xs transition-colors",
		isActive
			? "border-t-(--color-primary) font-medium text-(--color-text)"
			: "border-t-transparent text-(--color-text-3)",
	);
}

export function ConsoleBottomNav({ onOpenMore }: ConsoleBottomNavProps) {
	const caps = useCapabilities();
	const visible = (item: ConsoleNavItem): boolean =>
		item.capability === undefined || caps.can(item.capability);
	return (
		<nav
			aria-label="Primary"
			className="flex h-14 shrink-0 border-t border-(--color-border) bg-(--color-sidebar) pb-[env(safe-area-inset-bottom)] md:hidden"
		>
			{MOBILE_BOTTOM_NAV_ITEMS.filter(visible).map((item) => {
				const Icon = item.icon;
				return (
					<NavLink
						key={item.to}
						to={item.to}
						end={item.end}
						className={({ isActive }) => tabClass(isActive)}
					>
						{({ isActive }) => (
							<>
								<Icon
									aria-hidden
									className={cn("size-4.5", isActive && "text-(--color-primary)")}
								/>
								{item.label}
							</>
						)}
					</NavLink>
				);
			})}
			<button type="button" onClick={onOpenMore} className={tabClass(false)}>
				<Menu aria-hidden className="size-4.5" />
				More
			</button>
		</nav>
	);
}
