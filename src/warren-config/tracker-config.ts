/**
 * Per-project external tracker container config (warren-d3a9, plan
 * pl-a37b Track B): `tracker: { url, tokenEnv }` in `.warren/config.yaml`
 * names a warren-tracker/v1 endpoint (`src/tracker/remote/protocol.ts`)
 * plus the environment variable holding the optional bearer. The
 * credential is read from the operator's environment and NEVER persisted
 * by warren — only its NAME crosses the config boundary (the extension
 * container holds its own tracker credential; blocker B1 stays dissolved).
 */

import { z } from "zod";

export const TrackerConfigSchema = z
	.object({
		url: z.string().url("tracker.url must be an absolute http(s) URL"),
		tokenEnv: z
			.string()
			.min(1, "tracker.tokenEnv must be non-empty if provided")
			.max(128, "tracker.tokenEnv must be at most 128 characters")
			.regex(
				/^[A-Z_][A-Z0-9_]*$/,
				"tracker.tokenEnv must be an environment variable name (UPPER_SNAKE_CASE)",
			)
			.optional(),
	})
	.strict();

export type TrackerConfig = z.infer<typeof TrackerConfigSchema>;
