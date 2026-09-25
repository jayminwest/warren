import { CHORD_NAV_ITEMS } from "@/components/console/console-nav.ts";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog.tsx";
import { Kbd } from "@/components/ui/kbd.tsx";

/** The `?` shortcut sheet (warren-a8c9). Reads the chords from the nav. */

const GENERAL: readonly { keys: readonly string[]; label: string }[] = [
	{ keys: ["⌘", "K"], label: "Command palette" },
	{ keys: ["/"], label: "Search" },
	{ keys: ["C"], label: "New run" },
	{ keys: ["J", "K"], label: "Move through a list" },
	{ keys: ["↵"], label: "Open the selected row" },
	{ keys: ["⇧", "T"], label: "Switch theme" },
	{ keys: ["?"], label: "This sheet" },
];

function Row({ keys, label }: { keys: readonly string[]; label: string }) {
	return (
		<div className="flex h-8 items-center justify-between gap-4 text-sm">
			<span className="text-(--color-text-2)">{label}</span>
			<span className="flex gap-1">
				{keys.map((k) => (
					<Kbd key={k}>{k}</Kbd>
				))}
			</span>
		</div>
	);
}

export function ShortcutHelp({
	open,
	onOpenChange,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
}) {
	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-xl gap-5 rounded-lg p-5">
				<DialogTitle className="text-base font-semibold">Keyboard shortcuts</DialogTitle>
				<div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
					<div className="flex flex-col">
						<div className="pb-1 text-xs font-medium text-(--color-text-3)">General</div>
						{GENERAL.map((row) => (
							<Row key={row.label} keys={row.keys} label={row.label} />
						))}
					</div>
					<div className="flex flex-col">
						<div className="pb-1 text-xs font-medium text-(--color-text-3)">Go to</div>
						{CHORD_NAV_ITEMS.filter((item) => item.key).map((item) => (
							<Row key={item.to} keys={["G", (item.key ?? "").toUpperCase()]} label={item.label} />
						))}
					</div>
				</div>
			</DialogContent>
		</Dialog>
	);
}
