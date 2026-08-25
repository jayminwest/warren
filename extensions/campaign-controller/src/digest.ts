/**
 * Deterministic canonical-JSON digests for campaign manifests and
 * repository policies (plan pl-91b6 step 2, warren-5055).
 *
 * An approval binds a digest over the *canonical* serialization of the
 * manifest, so approval cannot depend on key order, number formatting, or
 * timestamp spelling. Canonical form: recursively key-sorted JSON with no
 * whitespace. Only JSON-safe values (the schemas never admit anything else)
 * reach the digest, and no credential field can appear because unknown keys
 * are rejected upstream of normalization — digests are secret-free by
 * construction.
 */

/** Hex-encoded lowercase sha256, the only digest form the schemas accept. */
export const SHA256_HEX = /^[0-9a-f]{64}$/;

/** Is this a plausible lowercase sha256 hex string? */
export function isSha256Hex(value: string): boolean {
	return SHA256_HEX.test(value);
}

/**
 * Canonical JSON: object keys sorted (recursively), no insignificant
 * whitespace, stable number formatting. Throws on values JSON cannot carry
 * deterministically (undefined, functions, NaN, Infinity, non-integer keys).
 */
export function canonicalJson(value: unknown): string {
	return serialize(value);
}

function serialize(value: unknown): string {
	if (value === null) return "null";
	switch (typeof value) {
		case "boolean":
			return value ? "true" : "false";
		case "number": {
			if (!Number.isFinite(value)) {
				throw new TypeError(`canonicalJson: non-finite number ${String(value)}`);
			}
			return JSON.stringify(value);
		}
		case "string":
			return JSON.stringify(value);
		case "object": {
			if (Array.isArray(value)) {
				return `[${value.map(serialize).join(",")}]`;
			}
			if (value instanceof Date) {
				throw new TypeError("canonicalJson: Date is not canonical; normalize to ISO string first");
			}
			const record = value as Record<string, unknown>;
			const keys = Object.keys(record)
				.filter((k) => record[k] !== undefined)
				.sort();
			return `{${keys.map((k) => `${JSON.stringify(k)}:${serialize(record[k])}`).join(",")}}`;
		}
		default:
			throw new TypeError(`canonicalJson: unsupported value of type ${typeof value}`);
	}
}

/** sha256 over the UTF-8 bytes of `input`, lowercase hex. */
export function sha256Hex(input: string): string {
	const hasher = new Bun.CryptoHasher("sha256");
	hasher.update(input);
	return hasher.digest("hex");
}

/** Canonical-JSON sha256 digest — the form every approval binds. */
export function digestOf(value: unknown): string {
	return sha256Hex(canonicalJson(value));
}
