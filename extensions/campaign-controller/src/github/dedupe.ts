/**
 * Node-id deduplication for upstream observations (warren-33aa).
 *
 * GitHub delivery is at-least-once: a notification wake-up can replay a
 * review, comment, or check the controller has already ingested, and an
 * edit produces a *new* source fact rather than a duplicate. Dedupe on the
 * stable node id keeps ingested events exactly-once; first occurrence
 * wins and later duplicates are counted, never dropped silently.
 */

import type { GithubNoded } from "./types.ts";

export interface DedupedItems<T> {
	/** First occurrence of each node id, in original order. */
	items: T[];
	/** How many entries were dropped as duplicates of an earlier node id. */
	duplicateCount: number;
	/** Node ids that arrived more than once, in first-seen order. */
	duplicateNodeIds: string[];
}

/**
 * Deduplicate items by their stable `nodeId`. Empty node ids are kept as
 * distinct items (they carry no identity to dedupe on).
 */
export function dedupeByNodeId<T extends GithubNoded>(items: readonly T[]): DedupedItems<T> {
	const seen = new Set<string>();
	const duplicateNodeIds: string[] = [];
	const kept: T[] = [];
	let duplicateCount = 0;
	for (const item of items) {
		if (item.nodeId.length === 0) {
			kept.push(item);
			continue;
		}
		if (seen.has(item.nodeId)) {
			duplicateCount += 1;
			if (!duplicateNodeIds.includes(item.nodeId)) {
				duplicateNodeIds.push(item.nodeId);
			}
			continue;
		}
		seen.add(item.nodeId);
		kept.push(item);
	}
	return { items: kept, duplicateCount, duplicateNodeIds };
}

/**
 * Merge an incoming observation batch into an already-ingested id set.
 * Returns only the never-seen items and grows `known` in place, so a poll
 * loop can fold batches into durable state incrementally.
 */
export function filterNewByNodeId<T extends GithubNoded>(
	known: Set<string>,
	incoming: readonly T[],
): T[] {
	const fresh: T[] = [];
	for (const item of incoming) {
		if (item.nodeId.length > 0 && !known.has(item.nodeId)) {
			known.add(item.nodeId);
			fresh.push(item);
		}
	}
	return fresh;
}
