import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button.tsx";
import { type Theme, useTheme } from "@/hooks/useTheme.ts";

const NEXT: Record<Theme, Theme> = {
	light: "dark",
	dark: "system",
	system: "light",
};

const LABEL: Record<Theme, string> = {
	light: "Light",
	dark: "Dark",
	system: "System",
};

export function ThemeToggle(): React.JSX.Element {
	const { theme, setTheme } = useTheme();
	const next = NEXT[theme];
	const Icon = theme === "light" ? Sun : theme === "dark" ? Moon : Monitor;
	const ariaLabel = `Theme: ${LABEL[theme].toLowerCase()}. Click to switch to ${LABEL[next].toLowerCase()}.`;

	return (
		<Button
			variant="ghost"
			size="sm"
			onClick={() => setTheme(next)}
			className="mt-2 justify-start"
			aria-label={ariaLabel}
			title={ariaLabel}
		>
			<Icon className="h-4 w-4" />
			{LABEL[theme]}
		</Button>
	);
}
