import type { WriteSink } from "./output.ts";

/**
 * Render an aligned fixed-width table (header + rows) to a sink.
 */
export function renderTable(
	sink: WriteSink,
	header: readonly string[],
	rows: readonly (readonly string[])[],
): void {
	const line = (text: string): void => sink.write(`${text}\n`);
	const widths = columnWidths([header, ...rows]);
	line(formatRow(header, widths));
	for (const row of rows) {
		line(formatRow(row, widths));
	}
}

/**
 * Shared fixed-width table helpers for the CLI's `--output pretty`
 * renderers (`plan status`, `plan list`, `projects`). Extracted in
 * warren-e127 so the pretty dialect lives in one place instead of
 * drifting across commands.
 */

/** Compute the max width of each column across all rows. */
export function columnWidths(rows: readonly (readonly string[])[]): number[] {
	const widths: number[] = [];
	for (const row of rows) {
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i] ?? 0, cell.length);
		});
	}
	return widths;
}

/** Pad each cell to its column width and join with two spaces. */
export function formatRow(row: readonly string[], widths: readonly number[]): string {
	return row
		.map((cell, i) => cell.padEnd(widths[i] ?? cell.length))
		.join("  ")
		.trimEnd();
}
