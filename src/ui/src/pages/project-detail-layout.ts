/**
 * Project detail layout decisions (warren-cd42). Extracted from
 * `project-detail.tsx` so the spectator-layout contract is testable
 * without mounting the page.
 *
 * Spectator layout: with no operator panels rendering, the main
 * column would be an empty flex-1 block eating two thirds of the row,
 * so the page skips it entirely and the side rail loses its
 * fixed-width, no-shrink treatment.
 */

export function mainColumnClasses(): string {
	return "flex min-w-0 flex-1 flex-col gap-4";
}

export function sideRailClasses(isOperator: boolean): string {
	return isOperator
		? "flex w-full shrink-0 flex-col gap-4 lg:w-[336px]"
		: "flex w-full flex-col gap-4";
}
