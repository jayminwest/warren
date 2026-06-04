/**
 * Public library entry. V1 keeps this thin — only the version constant ships,
 * which the publish workflow grep-checks against package.json. The HTTP-mirroring
 * `Client` class is deferred to V2 (SPEC §8.3).
 */

export const VERSION = "0.7.11";
