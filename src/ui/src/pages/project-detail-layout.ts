/**
 * Project detail layout decisions (warren-cd42, warren-b754).
 *
 * warren-cd42: with no operator panels rendering, the main column
 * would be an empty flex-1 block eating two thirds of the row, so the
 * page skipped it and the side rail filled the row.
 * warren-b754: the warren-config and ready-plans reads went
 * `readPublic`, so the main column renders for spectators too — the
 * rail is back to the fixed-width variant for every audience and the
 * spectator variant is gone.
 */

export function mainColumnClasses(): string {
	return "flex min-w-0 flex-1 flex-col gap-4";
}

export function sideRailClasses(): string {
	return "flex w-full shrink-0 flex-col gap-4 lg:w-[336px]";
}
