import { describe, expect, test } from "bun:test";
import {
	inferRepoSlug,
	isHealAlertSource,
	normalizeAlert,
	normalizeGrafanaAlert,
	normalizeSentryAlert,
} from "./alert.ts";

describe("normalizeSentryAlert", () => {
	test("pulls fingerprint, title, culprit, detail, links, and repo", () => {
		const alert = normalizeSentryAlert({
			data: {
				issue: { id: "issue-99", web_url: "https://sentry.io/issues/99" },
				event: {
					title: "TypeError: undefined is not a function",
					culprit: "src/runs/reap.ts in finalize",
					message: "TypeError at finalize()",
					event_id: "evt-1",
				},
			},
			repository: "https://github.com/jayminwest/warren.git",
			url: "https://sentry.io/org/x/",
		});
		expect(alert.source).toBe("sentry");
		expect(alert.fingerprint).toBe("issue-99");
		expect(alert.title).toBe("TypeError: undefined is not a function");
		expect(alert.culprit).toBe("src/runs/reap.ts in finalize");
		expect(alert.detail).toBe("TypeError at finalize()");
		expect(alert.repo).toBe("jayminwest/warren");
		expect(alert.links).toContain("https://sentry.io/issues/99");
	});

	test("falls back through event_id then title for the fingerprint", () => {
		expect(normalizeSentryAlert({ event: { event_id: "evt-7", title: "boom" } }).fingerprint).toBe(
			"evt-7",
		);
		expect(normalizeSentryAlert({ event: { title: "only-a-title" } }).fingerprint).toBe(
			"sentry:only-a-title",
		);
	});

	test("tolerates an empty payload without throwing", () => {
		const alert = normalizeSentryAlert({});
		expect(alert.title).toBe("alert");
		expect(alert.culprit).toBeNull();
		expect(alert.repo).toBeNull();
		expect(alert.links).toEqual([]);
	});
});

describe("normalizeGrafanaAlert", () => {
	test("keys off the first firing alert's fingerprint + labels", () => {
		const alert = normalizeGrafanaAlert({
			alerts: [
				{
					fingerprint: "abcd1234",
					labels: {
						alertname: "HighErrorRate",
						service: "warren-api",
						repository: "jayminwest/warren",
					},
					annotations: { description: "5xx rate above 2%" },
					generatorURL: "https://grafana.net/d/1",
				},
			],
		});
		expect(alert.source).toBe("grafana");
		expect(alert.fingerprint).toBe("abcd1234");
		expect(alert.title).toBe("HighErrorRate");
		expect(alert.culprit).toBe("warren-api");
		expect(alert.detail).toBe("5xx rate above 2%");
		expect(alert.repo).toBe("jayminwest/warren");
		expect(alert.links).toContain("https://grafana.net/d/1");
	});

	test("falls back to a title-derived fingerprint when no key is present", () => {
		expect(normalizeGrafanaAlert({ title: "DiskFull" }).fingerprint).toBe("grafana:DiskFull");
	});
});

describe("normalizeAlert", () => {
	test("dispatches by source", () => {
		expect(normalizeAlert("sentry", { event: { title: "x" } }).source).toBe("sentry");
		expect(normalizeAlert("grafana", { title: "y" }).source).toBe("grafana");
	});
});

describe("inferRepoSlug", () => {
	test("parses github URLs and bare owner/repo", () => {
		expect(inferRepoSlug("https://github.com/a/b.git")).toBe("a/b");
		expect(inferRepoSlug("git@github.com:a/b.git")).toBe("a/b");
		expect(inferRepoSlug("a/b")).toBe("a/b");
		expect(inferRepoSlug("not a repo")).toBeNull();
		expect(inferRepoSlug(null)).toBeNull();
	});
});

describe("isHealAlertSource", () => {
	test("accepts only sentry / grafana", () => {
		expect(isHealAlertSource("sentry")).toBe(true);
		expect(isHealAlertSource("grafana")).toBe(true);
		expect(isHealAlertSource("datadog")).toBe(false);
		expect(isHealAlertSource(null)).toBe(false);
	});
});
