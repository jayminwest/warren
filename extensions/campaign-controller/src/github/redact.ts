/**
 * Credential redaction helpers (warren-33aa, plan pl-91b6 risk 5).
 *
 * Nothing the client or fake server exposes — error text, JSON error
 * shapes, recorded requests — may ever carry the bearer token. These
 * helpers are the single chokepoint: headers get the Authorization entry
 * replaced wholesale, and free text gets every occurrence of the secret
 * substring scrubbed.
 */

/** Header key under which the credential travels. */
export const AUTHORIZATION_HEADER = "authorization";

/** The replacement value for a redacted credential. */
export const REDACTED = "[REDACTED]";

/** Return a copy of `headers` with the credential entry replaced. */
export function redactHeaders(
	headers: Record<string, string>,
	secret?: string,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		out[key.toLowerCase()] =
			key.toLowerCase() === AUTHORIZATION_HEADER ? REDACTED : redactText(value, secret);
	}
	return out;
}

/** Replace every occurrence of `secret` in `text` with the redaction marker. */
export function redactText(text: string, secret?: string): string {
	if (!secret || secret.length === 0) {
		return text;
	}
	return text.split(secret).join(REDACTED);
}

/** Deep-scrub every string in an arbitrary JSON-able value. */
export function redactValue<T>(value: T, secret?: string): T {
	if (!secret || secret.length === 0) {
		return value;
	}
	if (typeof value === "string") {
		return redactText(value, secret) as unknown as T;
	}
	if (Array.isArray(value)) {
		return value.map((item) => redactValue(item, secret)) as unknown as T;
	}
	if (value !== null && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
			out[key] = key.toLowerCase() === AUTHORIZATION_HEADER ? REDACTED : redactValue(entry, secret);
		}
		return out as unknown as T;
	}
	return value;
}
