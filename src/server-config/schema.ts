/**
 * Zod schema for warren's server-level TOML config
 * (pl-9ba1 step 7 / warren-3909; `workers` field added in step 8 /
 * warren-272c).
 *
 * Step 7 landed the loader scaffolding as `z.object({}).strict()` so step
 * 8 could grow the schema by exactly one field on a tested foundation
 * (plan risk #6). Step 8 adds `workers`; the schema stays `.strict()` so
 * any future top-level key still gets rejected with a field-level
 * ValidationError until its own seed lands it.
 *
 * The schema only checks shape — `name` and `url` are non-empty strings.
 * URL shape, name regex, and uniqueness are cross-row / format checks
 * that don't fit Zod cleanly; they live in `workers.ts`'s
 * `validateWorkerEntries`, which the loader calls after `safeParse`.
 *
 * `parseWarrenServerFileConfig` returns a discriminated result instead
 * of throwing. The loader (load.ts) decides which failures become
 * `ValidationError`; tests can exercise the parser in isolation.
 */

import { z } from "zod";

/**
 * One row of the `[[workers]]` array (pl-9ba1 step 8 / warren-272c).
 *
 * `name` is the operator-chosen handle that doubles as the row's primary
 * key in warren's `workers` table (warren-b0a3) and the URL identity for
 * `POST /workers/:name/drain` (warren-0f0c). `url` is the burrow worker's
 * transport target — `unix:///path` or `http(s)://host:port` — parsed
 * into a `Transport` post-schema by `parseWorkerUrl` (workers.ts).
 */
export const WorkerEntrySchema = z
	.object({
		name: z.string().min(1),
		url: z.string().min(1),
	})
	.strict();

export type WorkerEntry = z.infer<typeof WorkerEntrySchema>;

/**
 * `workers` is `optional()` rather than `default([])` so a TOML file with
 * no `[[workers]]` block round-trips back as `{}` rather than
 * `{ workers: [] }`. Both shapes mean the same thing to the boot path —
 * zero workers, fall back to env-driven `BurrowClient.fromEnv`.
 */
export const WarrenServerFileConfigSchema = z
	.object({
		workers: z.array(WorkerEntrySchema).optional(),
	})
	.strict();

export type WarrenServerFileConfig = z.infer<typeof WarrenServerFileConfigSchema>;

export type ParseResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly message: string };

export function parseWarrenServerFileConfig(raw: unknown): ParseResult<WarrenServerFileConfig> {
	// An empty/missing-body file (Bun.TOML.parse on "" returns {}) is the
	// same as no config — operators may keep the file present as a stub
	// or for the documentation comments alone.
	if (raw === undefined || raw === null) {
		return { ok: true, value: {} };
	}
	const parsed = WarrenServerFileConfigSchema.safeParse(raw);
	if (parsed.success) {
		return { ok: true, value: parsed.data };
	}
	return { ok: false, message: parsed.error.issues.map(formatZodIssue).join("; ") };
}

function formatZodIssue(issue: z.core.$ZodIssue): string {
	const path = issue.path.length === 0 ? "<root>" : issue.path.join(".");
	return `${path}: ${issue.message}`;
}
