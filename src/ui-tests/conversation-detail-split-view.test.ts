/**
 * Structural UI test for the Leveret conversation split-view page
 * (warren-01c8).
 *
 * The warren UI package (src/ui) intentionally ships without a React
 * test harness (no jsdom, no @testing-library, mx-a86ce6). Acceptance
 * criteria for the split-view page are therefore pinned at the source
 * level: a future regression (dropping the dynamic intent renderer for
 * hardcoded goal/non-goals fields, breaking the conversation send path,
 * or un-gating the 'Send to planner' button) would visibly break these
 * assertions.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const PAGE_PATH = join(import.meta.dir, "..", "ui", "src", "pages", "ConversationDetail.tsx");
const SOURCE = readFileSync(PAGE_PATH, "utf8");

const SEND_OFF_PATH = join(
	import.meta.dir,
	"..",
	"ui",
	"src",
	"pages",
	"conversation-detail",
	"send-off-button.tsx",
);
const SEND_OFF_SOURCE = readFileSync(SEND_OFF_PATH, "utf8");

const APP_PATH = join(import.meta.dir, "..", "ui", "src", "App.tsx");
const APP_SOURCE = readFileSync(APP_PATH, "utf8");

const CHAT_PATH = join(import.meta.dir, "..", "ui", "src", "components", "Chat.tsx");
const CHAT_SOURCE = readFileSync(CHAT_PATH, "utf8");

describe("ConversationDetail split-view (warren-01c8)", () => {
	test("registers the /leveret/:id route in App.tsx", () => {
		expect(APP_SOURCE).toContain("ConversationDetailPage");
		expect(APP_SOURCE).toMatch(/path="\/leveret\/:id"\s+element=\{<ConversationDetailPage\s*\/>\}/);
	});

	test("LEFT pane reuses Chat with a conversation send-message override", () => {
		// The chat must NOT spawn a fresh turn run — operator turns ride
		// POST /conversations/:id/messages (persist + steer the long-lived
		// anchoring run). Regression guard: reverting to runsApi.sendMessage
		// would silently break conversation persistence.
		expect(SOURCE).toContain("<Chat");
		expect(SOURCE).toMatch(/sendMessage=\{[\s\S]*?conversationsApi\.postMessage\(/);
		expect(SOURCE).toMatch(/runId=\{row\.anchoringRunId\}/);
	});

	test("Chat exposes the sendMessage override prop", () => {
		expect(CHAT_SOURCE).toMatch(/readonly sendMessage\?: \(message: string\) => Promise<void>/);
		expect(CHAT_SOURCE).toMatch(/if \(sendMessage\)/);
	});

	test("RIGHT pane renders intent DYNAMICALLY from the plot JSON shape", () => {
		// §0.0.A: no hardcoded goal/non_goals/constraints/success_criteria
		// field names — the renderer iterates the intent object's entries.
		expect(SOURCE).toMatch(/Object\.entries\(intent\)/);
		expect(SOURCE).not.toMatch(/intent\.goal\b/);
		expect(SOURCE).not.toMatch(/intent\.non_goals\b/);
		expect(SOURCE).not.toMatch(/intent\.success_criteria\b/);
	});

	test("RIGHT pane is live-updating (polls the plot query)", () => {
		expect(SOURCE).toMatch(/queryKey: \["plot", plotId\]/);
		expect(SOURCE).toMatch(/refetchInterval:/);
	});

	test("RIGHT pane is editable via POST /plots/:id/intent", () => {
		expect(SOURCE).toMatch(/plotsApi\.editIntent\(/);
		expect(SOURCE).toContain("Edit intent");
		expect(SOURCE).toContain("Save intent");
	});

	test("top-bar 'Send to planner' is gated on non-empty intent", () => {
		expect(SOURCE).toContain("SendOffButton");
		expect(SOURCE).toMatch(/intentNonEmpty=\{intentIsNonEmpty\(baseFields\)\}/);

		expect(SEND_OFF_SOURCE).toContain("Send to planner");
		expect(SEND_OFF_SOURCE).toMatch(/disabled=\{!intentNonEmpty/);
	});

	test("frozen (done/archived) plots disable intent editing", () => {
		expect(SOURCE).toMatch(/FROZEN_STATUSES[\s\S]*?"done"[\s\S]*?"archived"/);
	});
});
