/**
 * Tiny extractor for the agent's `burrow_config` section (SPEC §4.2).
 *
 * The body is TOML. The only field warren currently forwards onto
 * `POST /burrows` (HttpBurrowUpInput, burrow §15.6) is `[sandbox].network`
 * — the rest (`[toolchain].bun`, `[sandbox].allowed_domains`) lives in
 * the burrow profile and isn't exposed via the HTTP route.
 *
 * Adding a TOML parser dependency just to read a single string field
 * would be heavy. A line-by-line state machine is sufficient and stays
 * deterministic on the small, hand-authored inputs these configs are.
 * If burrow ever grows the surface, swap to `smol-toml` (already in the
 * burrow-cli dep tree).
 *
 * Unknown sections, comments, blank lines, and unrecognized keys are
 * ignored — burrow_config is a forward-compatible doc, so we should not
 * fail loudly on extra content.
 */

import { NETWORK_POLICIES, type NetworkPolicy } from "@os-eco/burrow-cli";
import { RunSpawnError } from "./errors.ts";

export interface ParsedBurrowConfig {
	readonly network?: NetworkPolicy;
}

/**
 * Parse the body of an agent's `burrow_config` section. Returns an empty
 * config if the body is missing/empty. Throws `RunSpawnError` for a
 * recognized key with an unrecognized value (e.g. `network = "wide-open"`).
 */
export function parseBurrowConfig(body: string | undefined): ParsedBurrowConfig {
	if (body === undefined || body.trim() === "") return {};

	let currentSection: string | null = null;
	let network: NetworkPolicy | undefined;

	for (const rawLine of body.split("\n")) {
		const line = stripComment(rawLine).trim();
		if (line === "") continue;

		if (line.startsWith("[") && line.endsWith("]")) {
			currentSection = line.slice(1, -1).trim();
			continue;
		}

		if (currentSection !== "sandbox") continue;

		const eq = line.indexOf("=");
		if (eq === -1) continue;
		const key = line.slice(0, eq).trim();
		const value = line.slice(eq + 1).trim();

		if (key === "network") {
			const unquoted = unquote(value);
			if (unquoted === undefined) {
				throw new RunSpawnError(
					`burrow_config: [sandbox].network must be a quoted string, got ${value}`,
				);
			}
			if (!isNetworkPolicy(unquoted)) {
				throw new RunSpawnError(
					`burrow_config: [sandbox].network must be one of ${NETWORK_POLICIES.join(", ")}, got "${unquoted}"`,
				);
			}
			network = unquoted;
		}
	}

	return network !== undefined ? { network } : {};
}

function stripComment(line: string): string {
	let inString = false;
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === '"') inString = !inString;
		else if (ch === "#" && !inString) return line.slice(0, i);
	}
	return line;
}

function unquote(value: string): string | undefined {
	if (value.length < 2) return undefined;
	if (value.startsWith('"') && value.endsWith('"')) return value.slice(1, -1);
	if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
	return undefined;
}

function isNetworkPolicy(value: string): value is NetworkPolicy {
	return (NETWORK_POLICIES as readonly string[]).includes(value);
}
