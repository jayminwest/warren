/**
 * Structural UI test for the Workspace detail Shape tab (pl-0008 step 7 /
 * warren-3de4).
 *
 * The warren UI package (src/ui) intentionally ships without a React test
 * harness (no jsdom, no @testing-library, mx-a86ce6), so the Shape tab's
 * acceptance criteria are pinned at the source level: it resolves the Plot's
 * active conversation via `conversationsApi.list({plot})`, reuses the shared
 * ConversationSplitView surface (chat + dynamic intent + send-off), exposes
 * the Re-wake control, and renders a Start-conversation affordance when the
 * Plot has no conversation yet.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_PATH = join(import.meta.dir, "..", "ui", "src", "pages", "WorkspaceDetail.tsx");
const SOURCE = readFileSync(PAGE_PATH, "utf8");

describe("WorkspaceDetail Shape tab (warren-3de4)", () => {
	test("resolves the Plot's conversation via conversationsApi.list({plot})", () => {
		expect(SOURCE).toMatch(/conversationsApi\.list\(\{\s*plot:\s*plot\.id\s*\}/);
		// active conversation wins, else fall back to the latest row.
		expect(SOURCE).toMatch(/find\(\(c\)\s*=>\s*c\.status === "active"\)/);
	});

	test("reuses the shared ConversationSplitView surface", () => {
		expect(SOURCE).toContain("ConversationSplitView");
		expect(SOURCE).toMatch(/conversationId=\{conversation\.id\}/);
	});

	test("exposes Re-wake and the operator-gated Dispatch plan controls", () => {
		expect(SOURCE).toContain("RewakeButton");
		expect(SOURCE).toContain("DispatchPlanButton");
	});

	test("renders a Start-conversation affordance when no conversation exists", () => {
		expect(SOURCE).toContain("NewConversationButton");
		expect(SOURCE).toMatch(/conversation === undefined/);
	});
});
