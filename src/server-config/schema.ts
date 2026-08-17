/**
 * Zod schema for warren's server-level TOML config
 * (pl-9ba1 step 7 / warren-3909).
 *
 * The schema is an empty `.strict()` object today: the `[[workers]]`
 * block that once lived here was retired with the K8s migration
 * (warren-288f; multi-worker pooling is gone, warren's self-host backend
 * is the in-process local engine).
 * `.strict()` means any top-level key in a `warren.toml` — including a
 * stray `[[workers]]` — is rejected with a field-level ValidationError
 * until its own seed grows the schema.
 *
 * `parseWarrenServerFileConfig` returns a discriminated result instead
 * of throwing. The loader (load.ts) decides which failures become
 * `ValidationError`; tests can exercise the parser in isolation.
 */

import { z } from "zod";

export const WarrenServerFileConfigSchema = z.object({}).strict();

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
