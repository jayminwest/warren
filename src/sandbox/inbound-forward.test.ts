/**
 * Unit tests for the warren-owned inbound TCP forwarder seam
 * (warren-4bf3, lifted from burrow's inbound-forward tests). We never bind
 * a real TCP socket here — the production listener / relay spawner are
 * swapped for synchronous fakes so the test asserts the wiring (relay argv
 * shape, stop() cascade, macOS no-op posture) rather than kernel-level
 * behaviour. The end-to-end Linux test belongs in an integration suite
 * that can actually `nsenter` into a live netns.
 */

import { describe, expect, test } from "bun:test";
import type { Subprocess } from "bun";
import {
	type ListenerSocket,
	type RelayProcess,
	type RelaySpawner,
	startInboundForward,
	type TcpListener,
} from "./inbound-forward.ts";

function makeFakeRelay(): { proc: RelayProcess; exit: (code: number) => void } {
	let exitResolve!: (code: number) => void;
	const exited = new Promise<number>((res) => {
		exitResolve = res;
	});
	const writes: Uint8Array[] = [];
	const stdin = {
		write: (chunk: Uint8Array): number => {
			writes.push(chunk);
			return chunk.length;
		},
		end: async (): Promise<void> => undefined,
		flush: async (): Promise<void> => undefined,
	};
	let pushStdout: (c: Uint8Array | null) => void = () => {};
	const stdout = new ReadableStream<Uint8Array>({
		start(controller) {
			pushStdout = (chunk) => {
				if (chunk === null) controller.close();
				else controller.enqueue(chunk);
			};
		},
	});
	let killed = false;
	const proc = {
		pid: 999,
		stdin: stdin as unknown as Subprocess<"pipe", "pipe", "ignore">["stdin"],
		stdout: stdout as unknown as Subprocess<"pipe", "pipe", "ignore">["stdout"],
		stderr: null as unknown as Subprocess<"pipe", "pipe", "ignore">["stderr"],
		exited,
		exitCode: null,
		kill: () => {
			killed = true;
			exitResolve(143);
		},
	} as unknown as RelayProcess;
	(proc as unknown as { __writes: Uint8Array[]; __killed: () => boolean }).__writes = writes;
	(proc as unknown as { __killed: () => boolean }).__killed = () => killed;
	(proc as unknown as { __pushStdout: (c: Uint8Array | null) => void }).__pushStdout = (c) =>
		pushStdout(c);
	return {
		proc,
		exit: (code: number) => exitResolve(code),
	};
}

function makeFakeListener(): {
	listen: TcpListener;
	connect: () => ListenerSocket;
	stopped: () => boolean;
	closeActiveCalls: number[];
} {
	let onConnect: ((socket: ListenerSocket) => void) | null = null;
	let stopped = false;
	const closeActiveCalls: number[] = [];
	const listen: TcpListener = (_port, cb) => {
		onConnect = cb;
		return {
			stop: (closeActive?: boolean) => {
				stopped = true;
				closeActiveCalls.push(closeActive === true ? 1 : 0);
			},
		};
	};
	return {
		listen,
		connect: () => {
			if (!onConnect) throw new Error("listener never invoked");
			let dataHandler: ((c: Uint8Array) => void) | undefined;
			let closeHandler: (() => void) | undefined;
			const writes: Uint8Array[] = [];
			let ended = false;
			let terminated = false;
			const socket: ListenerSocket = {
				onData: (h) => {
					dataHandler = h;
				},
				onClose: (h) => {
					closeHandler = h;
				},
				write: (data) => {
					writes.push(data);
				},
				end: () => {
					ended = true;
				},
				terminate: () => {
					terminated = true;
				},
			};
			(socket as unknown as { __writes: Uint8Array[] }).__writes = writes;
			(socket as unknown as { __ended: () => boolean }).__ended = () => ended;
			(socket as unknown as { __terminated: () => boolean }).__terminated = () => terminated;
			(socket as unknown as { __push: (c: Uint8Array) => void }).__push = (c) => dataHandler?.(c);
			(socket as unknown as { __closeClient: () => void }).__closeClient = () => closeHandler?.();
			onConnect(socket);
			return socket;
		},
		stopped: () => stopped,
		closeActiveCalls,
	};
}

describe("startInboundForward", () => {
	test("treats the macOS path as a no-op (hostPortBound=false)", async () => {
		const handle = await startInboundForward(
			{ hostPort: 32100, sandboxPort: 3000, sandboxPid: 1234 },
			{ plat: "darwin" },
		);
		expect(handle.hostPortBound).toBe(false);
		expect(handle.hostPort).toBe(32100);
		expect(handle.sandboxPort).toBe(3000);
		await handle.stop();
	});

	test("spawns nsenter+nc relays with the sandbox PID and target port on linux", async () => {
		const relays: ReturnType<typeof makeFakeRelay>[] = [];
		const capturedArgv: string[][] = [];
		const spawnRelay: RelaySpawner = (argv) => {
			capturedArgv.push([...argv]);
			const r = makeFakeRelay();
			relays.push(r);
			return r.proc;
		};
		const fake = makeFakeListener();
		const handle = await startInboundForward(
			{ hostPort: 32100, sandboxPort: 3000, sandboxPid: 4242 },
			{ plat: "linux", spawnRelay, listen: fake.listen },
		);
		expect(handle.hostPortBound).toBe(true);

		const socket = fake.connect();
		expect(capturedArgv.length).toBe(1);
		expect(capturedArgv[0]).toEqual([
			"nsenter",
			"--net=/proc/4242/ns/net",
			"--",
			"nc",
			"127.0.0.1",
			"3000",
		]);
		(socket as unknown as { __push: (c: Uint8Array) => void }).__push(
			new TextEncoder().encode("GET / HTTP/1.1\r\n\r\n"),
		);
		const relay = relays[0];
		if (!relay) throw new Error("relay not spawned");
		const writes = (relay.proc as unknown as { __writes: Uint8Array[] }).__writes;
		expect(writes.length).toBe(1);
		const firstWrite = writes[0];
		if (!firstWrite) throw new Error("missing write");
		expect(new TextDecoder().decode(firstWrite)).toBe("GET / HTTP/1.1\r\n\r\n");

		await handle.stop();
		expect(fake.stopped()).toBe(true);
		expect(fake.closeActiveCalls).toEqual([1]);
		expect((relay.proc as unknown as { __killed: () => boolean }).__killed()).toBe(true);
	});

	test("stop() kills all in-flight relays", async () => {
		const relays: ReturnType<typeof makeFakeRelay>[] = [];
		const spawnRelay: RelaySpawner = (_argv) => {
			const r = makeFakeRelay();
			relays.push(r);
			return r.proc;
		};
		const fake = makeFakeListener();
		const handle = await startInboundForward(
			{ hostPort: 32101, sandboxPort: 3000, sandboxPid: 4242 },
			{ plat: "linux", spawnRelay, listen: fake.listen },
		);
		fake.connect();
		fake.connect();
		await handle.stop();
		for (const r of relays) {
			expect((r.proc as unknown as { __killed: () => boolean }).__killed()).toBe(true);
		}
	});

	test("relay spawn failure terminates the host socket", async () => {
		const spawnRelay: RelaySpawner = (_argv) => {
			throw new Error("nsenter not installed");
		};
		const fake = makeFakeListener();
		const handle = await startInboundForward(
			{ hostPort: 32102, sandboxPort: 3000, sandboxPid: 4242 },
			{ plat: "linux", spawnRelay, listen: fake.listen },
		);
		const socket = fake.connect();
		expect((socket as unknown as { __terminated: () => boolean }).__terminated()).toBe(true);
		await handle.stop();
	});
});
