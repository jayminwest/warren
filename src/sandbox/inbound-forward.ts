/**
 * Per-sandbox inbound TCP forwarder (warren-4bf3, plan pl-3007 phase 3).
 * Lifted from burrow's `src/provider/local/inbound-forward.ts`; warren-owned
 * so the preview sidecar seam no longer depends on the burrow daemon.
 *
 * On Linux, a sibling listener on `127.0.0.1:hostPort` pipes every accepted
 * connection into the sandbox's network namespace via `nsenter
 * --net=/proc/<sandbox-pid>/ns/net -- nc 127.0.0.1 <sandboxPort>`. The
 * forwarder lives outside the netns; per-connection `nsenter -t <pid> -n`
 * spawns a relay that joins it. Same userspace-proxy posture the
 * restricted-network outbound proxy uses (mx-d6a44f) — Bun-native, no
 * `socat` runtime dep.
 *
 * On macOS, Seatbelt doesn't isolate the network namespace; the sidecar
 * process binds directly on host loopback at `sandboxPort`. Starting a
 * forwarder is a no-op — the caller treats the forward as implicit and
 * the platform layer returns `hostPortBound: false` without spawning
 * anything (warren acceptance scenario 20: macOS skip per warren
 * `mx-1d31f0`).
 */

import type { Subprocess } from "bun";

export interface ForwardSpec {
	hostPort: number;
	sandboxPort: number;
	/** PID of a live sandbox process whose netns the forwarder will join. */
	sandboxPid: number;
}

export interface ForwardHandle {
	readonly hostPort: number;
	readonly sandboxPort: number;
	/** True when an active forwarder is bound; false on macOS no-op. */
	readonly hostPortBound: boolean;
	stop(): Promise<void>;
}

export type RelayProcess = Subprocess<"pipe", "pipe", "ignore">;

export interface StartForwardOptions {
	plat?: NodeJS.Platform;
	/** Test seam: override the per-connection relay spawner. */
	spawnRelay?: RelaySpawner;
	/** Test seam: override the host listener factory. */
	listen?: TcpListener;
	/** Binary used to enter the sandbox netns (default `nsenter`). */
	nsenterBin?: string;
	/** Binary used as the netns-side relay (default `nc`). */
	netcatBin?: string;
}

export type RelaySpawner = (argv: string[]) => RelayProcess;

/**
 * Listener factory seam. Implementations bind `127.0.0.1:hostPort` and
 * invoke `onConnect(adapter)` for each accepted client. The adapter
 * pumps `onData` for inbound bytes, `write` to send back, and `close`
 * when the client tears down. Returning a `stop()` lets the forwarder
 * unbind the port on sandbox / sidecar teardown.
 */
export type TcpListener = (
	hostPort: number,
	onConnect: (adapter: ListenerSocket) => void,
) => TcpServer;

export interface TcpServer {
	stop(closeActive?: boolean): void | Promise<void>;
}

export interface ListenerSocket {
	/** Bytes from the host-side client (the request body). */
	onData(handler: (chunk: Uint8Array) => void): void;
	/** Host-side client closed cleanly. */
	onClose(handler: () => void): void;
	/** Write bytes back to the host-side client. */
	write(data: Uint8Array): void;
	/** Half-close write side. */
	end(): void;
	/** Hard reset. */
	terminate(): void;
}

const DEFAULT_NSENTER = "nsenter";
const DEFAULT_NETCAT = "nc";

export async function startInboundForward(
	spec: ForwardSpec,
	options: StartForwardOptions = {},
): Promise<ForwardHandle> {
	const plat = options.plat ?? process.platform;
	if (plat === "darwin") {
		return darwinNoopForward(spec);
	}
	if (plat !== "linux") {
		throw new Error(`inbound-forward: unsupported platform ${plat}`);
	}
	return linuxForward(spec, options);
}

function darwinNoopForward(spec: ForwardSpec): ForwardHandle {
	return {
		hostPort: spec.hostPort,
		sandboxPort: spec.sandboxPort,
		hostPortBound: false,
		stop: async () => {},
	};
}

async function linuxForward(
	spec: ForwardSpec,
	options: StartForwardOptions,
): Promise<ForwardHandle> {
	const nsenter = options.nsenterBin ?? DEFAULT_NSENTER;
	const netcat = options.netcatBin ?? DEFAULT_NETCAT;
	const spawnRelay = options.spawnRelay ?? defaultSpawnRelay;
	const listenImpl = options.listen ?? defaultListen;

	const relays = new Set<RelayProcess>();
	const relayArgv = [
		nsenter,
		`--net=/proc/${spec.sandboxPid}/ns/net`,
		"--",
		netcat,
		"127.0.0.1",
		String(spec.sandboxPort),
	];

	const server = listenImpl(spec.hostPort, (socket) => {
		let relay: RelayProcess;
		try {
			relay = spawnRelay(relayArgv);
		} catch {
			socket.terminate();
			return;
		}
		relays.add(relay);

		// host → sandbox: stream the socket's reads into the relay's stdin.
		socket.onData((chunk) => {
			const stdin = relay.stdin;
			if (stdin && typeof stdin !== "number") stdin.write(chunk);
		});
		socket.onClose(() => {
			const stdin = relay.stdin;
			if (stdin && typeof stdin !== "number") {
				const ended = stdin.end();
				if (ended && typeof ended === "object" && "catch" in ended) {
					(ended as Promise<unknown>).catch(() => undefined);
				}
			}
		});

		// sandbox → host: pump the relay's stdout back to the host socket.
		pumpStdoutToSocket(relay, socket).catch(() => socket.terminate());

		relay.exited
			.catch(() => undefined)
			.finally(() => {
				relays.delete(relay);
				socket.end();
			});
	});

	return {
		hostPort: spec.hostPort,
		sandboxPort: spec.sandboxPort,
		hostPortBound: true,
		stop: async () => {
			for (const relay of relays) {
				try {
					relay.kill();
				} catch {
					// already exited
				}
			}
			relays.clear();
			await server.stop(true);
		},
	};
}

async function pumpStdoutToSocket(relay: RelayProcess, socket: ListenerSocket): Promise<void> {
	const stdout = relay.stdout;
	if (!stdout) return;
	const reader = stdout.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (value && value.length > 0) socket.write(value);
		}
	} finally {
		try {
			reader.releaseLock();
		} catch {
			// already released
		}
	}
}

const defaultSpawnRelay: RelaySpawner = (argv) =>
	Bun.spawn(argv, {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "ignore",
	}) as RelayProcess;

const defaultListen: TcpListener = (hostPort, onConnect) => {
	type SocketHandlers = { data?: (c: Uint8Array) => void; close?: () => void };
	const handlersBySocket = new WeakMap<object, SocketHandlers>();
	const server = Bun.listen({
		hostname: "127.0.0.1",
		port: hostPort,
		socket: {
			open(socket) {
				const handlers: SocketHandlers = {};
				handlersBySocket.set(socket, handlers);
				onConnect({
					onData: (h) => {
						handlers.data = h;
					},
					onClose: (h) => {
						handlers.close = h;
					},
					write: (data) => {
						socket.write(data);
					},
					end: () => {
						socket.end();
					},
					terminate: () => {
						socket.terminate();
					},
				});
			},
			data(socket, data) {
				handlersBySocket.get(socket)?.data?.(data);
			},
			close(socket) {
				const handlers = handlersBySocket.get(socket);
				handlersBySocket.delete(socket);
				handlers?.close?.();
			},
			error(socket) {
				const handlers = handlersBySocket.get(socket);
				handlersBySocket.delete(socket);
				handlers?.close?.();
			},
		},
	});
	return {
		stop: (closeActive?: boolean) => server.stop(closeActive ?? false),
	};
};
