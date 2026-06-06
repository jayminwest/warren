/**
 * Prefixed ID generators (SPEC §7).
 *
 * Each ID is a stable two-part string: a domain prefix and a 12-char
 * lowercase base32 suffix (~60 bits of entropy). Prefixes are reserved per
 * kind so a stray ID can be classified at a glance.
 *
 * ```
 * prj_xxxxxxxxxxxx  project
 * run_xxxxxxxxxxxx  run
 * ```
 *
 * Agents are keyed by their canopy prompt name, not a generated ID. The
 * `sched_` prefix is reserved for V2 (cron + webhook scheduling).
 */

const BASE32_ALPHABET = "0123456789abcdefghjkmnpqrstvwxyz";
const SUFFIX_LEN = 12;

const PREFIXES = {
	project: "prj",
	run: "run",
	planRun: "plnr",
	conversation: "conv",
	message: "msg",
} as const;

export type IdKind = keyof typeof PREFIXES;

export function generateId(kind: IdKind): string {
	return `${PREFIXES[kind]}_${randomSuffix()}`;
}

export function isId(kind: IdKind, value: unknown): value is string {
	if (typeof value !== "string") return false;
	const prefix = `${PREFIXES[kind]}_`;
	if (!value.startsWith(prefix)) return false;
	const suffix = value.slice(prefix.length);
	if (suffix.length !== SUFFIX_LEN) return false;
	for (const ch of suffix) {
		if (!BASE32_ALPHABET.includes(ch)) return false;
	}
	return true;
}

function randomSuffix(): string {
	const bytes = new Uint8Array(SUFFIX_LEN);
	crypto.getRandomValues(bytes);
	let out = "";
	for (const byte of bytes) {
		const idx = byte % BASE32_ALPHABET.length;
		out += BASE32_ALPHABET[idx];
	}
	return out;
}
