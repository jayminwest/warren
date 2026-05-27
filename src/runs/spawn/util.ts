/**
 * Shared internal helpers for the spawn flow's fire-and-log paths
 * (`plot-append.ts`, `seed-extensions.ts`). Not exported from
 * `./index.ts` — strictly module-private.
 */

export function formatError(err: unknown): string {
	if (err instanceof Error) return err.message;
	return String(err);
}
