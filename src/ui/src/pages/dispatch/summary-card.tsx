import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardHeader } from "@/components/ui/card.tsx";
import { StatusBadge, StatusDot } from "@/components/ui/status.tsx";
import type { AdmissionRow, ManifestLine } from "./manifest-view.ts";

/**
 * The "What will happen" rail both dispatch forms share (warren-9474).
 * It restates the draft in operator words before anything is spent, lists
 * the pre-flight checks warren can read, keeps the raw manifest one click
 * away, and carries the submit actions so they sit next to the summary.
 */

export interface SummaryRow {
	readonly icon: LucideIcon;
	readonly label: string;
	readonly value: ReactNode;
	readonly note?: ReactNode;
}

function SummaryRowView({ row }: { row: SummaryRow }) {
	const Icon = row.icon;
	return (
		<div className="flex items-start gap-3">
			<span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--color-surface-raised) text-(--color-text-3)">
				<Icon aria-hidden className="size-3.5" />
			</span>
			<div className="flex min-w-0 flex-col gap-0.5">
				<span className="text-xs text-(--color-text-3)">{row.label}</span>
				<span className="truncate text-sm text-(--color-text)">{row.value}</span>
				{row.note ? <span className="text-xs text-(--color-text-3)">{row.note}</span> : null}
			</div>
		</div>
	);
}

function CheckRow({ row }: { row: AdmissionRow }) {
	return (
		<div className="flex min-h-7 items-center gap-2.5" {...(row.title ? { title: row.title } : {})}>
			<StatusDot tone={row.status === "ok" ? "ok" : "idle"} size="sm" />
			<span className="flex-1 text-sm text-(--color-text-2)">{row.label}</span>
			<span className="text-xs text-(--color-text-3)">{row.value}</span>
		</div>
	);
}

/** The raw manifest as the server would see it — machine text, so mono. */
function ManifestDetails({ lines }: { lines: readonly ManifestLine[] }) {
	return (
		<details className="group border-t border-(--color-border)">
			<summary className="flex h-10 cursor-pointer items-center px-4 text-xs text-(--color-text-3) select-none hover:text-(--color-text-2)">
				<span className="group-open:hidden">Show manifest</span>
				<span className="hidden group-open:inline">Hide manifest</span>
			</summary>
			<div className="overflow-x-auto px-4 pb-4 font-mono text-2xs">
				{lines.map((line) => (
					<div
						key={`${line.indent ? "i" : "r"}:${line.key}`}
						className={line.indent ? "pl-3.5 whitespace-pre" : "whitespace-pre"}
					>
						<span className="text-(--color-text-3)">{line.key}</span>
						{line.value !== undefined ? (
							<span className="text-(--color-text-2)"> {line.value}</span>
						) : null}
					</div>
				))}
			</div>
		</details>
	);
}

export function SummaryCard({
	rows,
	checks,
	manifest,
	valid,
	actions,
}: {
	rows: readonly SummaryRow[];
	checks: readonly AdmissionRow[];
	manifest: readonly ManifestLine[];
	valid: boolean;
	/** Submit + cancel; rendered in the card's footer. */
	actions: ReactNode;
}) {
	return (
		<aside className="w-full shrink-0 lg:sticky lg:top-4 lg:w-80">
			<Card className="w-full">
				<CardHeader
					title="What will happen"
					actions={
						<StatusBadge
							state={valid ? "ready" : "incomplete"}
							tone={valid ? "ok" : "idle"}
							label={valid ? "Ready" : "Incomplete"}
						/>
					}
				/>
				<div className="flex flex-col gap-4 p-4">
					{rows.map((row) => (
						<SummaryRowView key={row.label} row={row} />
					))}
				</div>
				{checks.length > 0 ? (
					<div className="flex flex-col border-t border-(--color-border) px-4 py-2.5">
						{checks.map((row) => (
							<CheckRow key={row.label} row={row} />
						))}
					</div>
				) : null}
				<ManifestDetails lines={manifest} />
				<div className="flex flex-col gap-2 border-t border-(--color-border) p-4">{actions}</div>
			</Card>
		</aside>
	);
}
