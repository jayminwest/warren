import { describe, expect, test } from "bun:test";
import { createRepos, type Repos } from "../../db/repos/index.ts";
import { withDb } from "../../db/testing.ts";
import { RunEventBroker } from "../../runs/events.ts";
import type { PodWarningSignal } from "../../runtime/k8s/pod-event-watcher.ts";
import type { Logger } from "../types.ts";
import { K8S_POD_WARNING_KIND, makePodWarningRunEventSink } from "./k8s-pod-warning-sink.ts";

const silentLogger = {
	info: () => {},
	warn: () => {},
	error: () => {},
	debug: () => {},
} as unknown as Logger;

function signalFor(runId: string, reason = "FailedAttachVolume"): PodWarningSignal {
	return {
		runId,
		reason,
		message: "Multi-Attach error for volume pvc-123",
		podName: "run-abc",
		podPhase: "Pending",
		eventName: "run-abc.1",
		count: 3,
		firstTimestamp: "2026-07-30T17:40:00.000Z",
		lastTimestamp: "2026-07-30T17:57:00.000Z",
	};
}

async function openRun(repos: Repos): Promise<string> {
	await repos.agents.upsert({ name: "refactor-bot", renderedJson: {} });
	const project = await repos.projects.create({
		gitUrl: "https://github.com/x/y.git",
		localPath: "/data/projects/x/y",
		defaultBranch: "main",
	});
	const run = await repos.runs.create({
		agentName: "refactor-bot",
		projectId: project.id,
		renderedAgentJson: {},
		prompt: "x",
		trigger: "manual",
	});
	return run.id;
}

/** Flush the fire-and-forget sink append. */
const flush = (): Promise<void> => new Promise((r) => setTimeout(r, 10));

describe("makePodWarningRunEventSink (warren-32f8)", () => {
	test("appends a structured k8s.pod_warning event and publishes it", async () => {
		const handle = await withDb({ dialect: "sqlite" });
		try {
			const repos = createRepos(handle.db);
			const runId = await openRun(repos);
			const broker = new RunEventBroker();
			const published: string[] = [];
			broker.publish = (id, row) => {
				published.push(`${id}:${row.kind}`);
			};
			const sink = makePodWarningRunEventSink({ repos, broker, logger: silentLogger });
			sink(signalFor(runId));
			await flush();
			const rows = await repos.events.listByRun(runId);
			expect(rows).toHaveLength(1);
			const row = rows[0];
			expect(row?.kind).toBe(K8S_POD_WARNING_KIND);
			expect(row?.stream).toBe("system");
			expect(row?.sandboxEventSeq).toBe(1);
			expect(row?.payloadJson).toEqual({
				reason: "FailedAttachVolume",
				message: "Multi-Attach error for volume pvc-123",
				podName: "run-abc",
				podPhase: "Pending",
				eventName: "run-abc.1",
				count: 3,
				firstTimestamp: "2026-07-30T17:40:00.000Z",
				lastTimestamp: "2026-07-30T17:57:00.000Z",
			});
			expect(published).toEqual([`${runId}:${K8S_POD_WARNING_KIND}`]);
		} finally {
			await handle.close();
		}
	});

	test("advances seq off the run's existing events", async () => {
		const handle = await withDb({ dialect: "sqlite" });
		try {
			const repos = createRepos(handle.db);
			const runId = await openRun(repos);
			await repos.events.append({
				runId,
				sandboxEventSeq: 41,
				ts: new Date().toISOString(),
				kind: "text",
				stream: "stdout",
				payload: {},
			});
			const sink = makePodWarningRunEventSink({ repos, logger: silentLogger });
			sink(signalFor(runId, "FailedScheduling"));
			await flush();
			const rows = await repos.events.listByRun(runId);
			const warning = rows.find((r) => r.kind === K8S_POD_WARNING_KIND);
			expect(warning?.sandboxEventSeq).toBe(42);
			expect(warning?.payloadJson).toMatchObject({ reason: "FailedScheduling" });
		} finally {
			await handle.close();
		}
	});

	test("skips signals for runs the DB does not know", async () => {
		const handle = await withDb({ dialect: "sqlite" });
		try {
			const repos = createRepos(handle.db);
			const sink = makePodWarningRunEventSink({ repos, logger: silentLogger });
			sink(signalFor("run_missing"));
			await flush();
			expect(await repos.events.listByRun("run_missing")).toHaveLength(0);
		} finally {
			await handle.close();
		}
	});
});
