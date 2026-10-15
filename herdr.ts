/**
 * Herdr client.
 *
 * Two transports, used deliberately:
 *
 * - The `herdr` CLI for actions and queries. It validates arguments and is the
 *   documented authority for command syntax, so it survives herdr upgrades better
 *   than hand-rolled socket payloads.
 * - The Herdr socket API for `events.subscribe`, which the CLI does not expose.
 *   This is what replaces the upstream extension's 1s widget polling.
 */

import { spawnSync } from "node:child_process";
import net from "node:net";

export type AgentStatus = "idle" | "working" | "blocked" | "done" | "unknown";

export interface AgentSessionRef {
	agent: string;
	kind: "id" | "path";
	source: string;
	value: string;
}

export interface HerdrAgent {
	agent: string;
	agent_status: AgentStatus;
	pane_id: string;
	workspace_id: string;
	tab_id?: string;
	name?: string;
	cwd?: string;
	focused?: boolean;
	interactive_ready?: boolean;
	agent_session?: AgentSessionRef;
	tokens?: Record<string, string>;
	state_labels?: Record<string, string>;
	title?: string | null;
	revision?: number;
	state_change_seq?: number;
	completion_seq?: number;
}

export interface HerdrSubscriptionEvent {
	event: string;
	data: Record<string, unknown>;
}

export class HerdrError extends Error {
	readonly code: string | undefined;

	constructor(message: string, code?: string) {
		super(message);
		this.name = "HerdrError";
		this.code = code;
	}
}

export function herdrBin(): string {
	return process.env.HERDR_BIN_PATH || "herdr";
}

export function herdrSocketPath(): string | undefined {
	return process.env.HERDR_SOCKET_PATH || undefined;
}

/** True when this process runs inside a Herdr-managed pane. */
export function isInHerdr(): boolean {
	return process.env.HERDR_ENV === "1" && Boolean(herdrSocketPath());
}

export function callerPaneId(): string | undefined {
	return process.env.HERDR_PANE_ID || undefined;
}

export function callerWorkspaceId(): string | undefined {
	return process.env.HERDR_WORKSPACE_ID || undefined;
}

/**
 * Run the herdr CLI and return its parsed stdout.
 *
 * These calls are synchronous and, in the parent, run from the widget timer, so a
 * hung server must not be able to freeze the Pi TUI. `timeoutMs` bounds that.
 */
function runCli(args: string[], timeoutMs = 120_000): unknown {
	const result = spawnSync(herdrBin(), args, {
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: timeoutMs,
		killSignal: "SIGKILL",
	});
	if (result.error) {
		const killed = (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT" || result.signal === "SIGKILL";
		throw new HerdrError(
			killed ? `herdr ${args[0]} timed out after ${timeoutMs}ms` : `Could not run herdr: ${result.error.message}`,
			killed ? "timeout" : "spawn",
		);
	}
	if (result.status !== 0) {
		const raw = `${result.stderr ?? ""}${result.stdout ?? ""}`.trim();
		let message = raw;
		let code: string | undefined;
		try {
			const parsed = JSON.parse(raw) as { error?: { code?: string; message?: string }; message?: string };
			message = parsed.error?.message ?? parsed.message ?? raw;
			code = parsed.error?.code;
		} catch {
			// Plain-text stderr, keep it as-is.
		}
		throw new HerdrError(message || `herdr ${args[0]} failed with exit code ${result.status}`, code ?? "cli");
	}
	const stdout = (result.stdout ?? "").trim();
	if (!stdout) return undefined;
	try {
		return JSON.parse(stdout);
	} catch {
		return stdout;
	}
}

/**
 * Send one request over the Herdr socket and resolve its `result`.
 *
 * A record with a non-matching id is ignored: `events.subscribe` keeps streaming
 * after its acknowledgement, and other clients may interleave records.
 */
export function herdrRequest<T = unknown>(
	method: string,
	params: Record<string, unknown>,
	timeoutMs = 5000,
): Promise<T> {
	const socketPath = herdrSocketPath();
	if (!socketPath) {
		return Promise.reject(new HerdrError("Not running inside Herdr (HERDR_SOCKET_PATH is unset)", "no_socket"));
	}

	return new Promise<T>((resolve, reject) => {
		const id = `pi-subagent:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
		const socket = net.createConnection(socketPath);
		let buffer = "";
		let settled = false;

		const finish = (callback: () => void): void => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			callback();
		};

		const timer = setTimeout(
			() => finish(() => reject(new HerdrError(`herdr ${method} timed out after ${timeoutMs}ms`, "timeout"))),
			timeoutMs,
		);
		timer.unref?.();

		socket.on("error", (error) =>
			finish(() => reject(new HerdrError(`herdr socket error: ${error.message}`, "socket"))),
		);
		socket.on("connect", () => socket.write(`${JSON.stringify({ id, method, params })}\n`));
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				if (!line.trim()) continue;
				let record: { id?: string; result?: unknown; error?: { code?: string; message?: string } };
				try {
					record = JSON.parse(line) as typeof record;
				} catch {
					continue;
				}
				if (record.id !== id) continue;
				if (record.error) {
					finish(() => reject(new HerdrError(record.error?.message ?? "herdr error", record.error?.code)));
					return;
				}
				finish(() => resolve(record.result as T));
				return;
			}
		});
	});
}

/**
 * Subscribe to Herdr events, reconnecting on socket loss.
 *
 * `subscriptions` is a factory because Herdr requires one entry per pane for
 * `pane.agent_status_changed`, and the set grows as subagents are spawned.
 */
export function herdrSubscribe(
	subscriptions: () => Array<Record<string, unknown>>,
	onEvent: (event: HerdrSubscriptionEvent) => void,
	onError?: (error: Error) => void,
): () => void {
	const socketPath = herdrSocketPath();
	if (!socketPath) return () => {};

	let socket: net.Socket | undefined;
	let buffer = "";
	let closed = false;
	let retry: ReturnType<typeof setTimeout> | undefined;
	let attempt = 0;

	const connect = (): void => {
		if (closed) return;
		socket = net.createConnection(socketPath);
		socket.unref?.();
		socket.on("error", (error) => {
			onError?.(error);
		});
		socket.on("connect", () => {
			attempt = 0;
			buffer = "";
			const id = `pi-subagent:sub:${Date.now()}`;
			socket?.write(`${JSON.stringify({ id, method: "events.subscribe", params: { subscriptions: subscriptions() } })}\n`);
		});
		socket.on("close", () => {
			if (closed) return;
			// Herdr restarts, socket timeouts, and pane churn are all recoverable.
			const delay = Math.min(1000 * 2 ** attempt++, 15000);
			retry = setTimeout(connect, delay);
			retry.unref?.();
		});
		socket.on("data", (chunk) => {
			buffer += chunk.toString("utf8");
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index).replace(/\r$/, "");
				buffer = buffer.slice(index + 1);
				if (!line.trim()) continue;
				let record: { event?: string; data?: Record<string, unknown> };
				try {
					record = JSON.parse(line) as typeof record;
				} catch {
					continue;
				}
				if (typeof record.event !== "string") continue;
				onEvent({ event: record.event, data: record.data ?? {} });
			}
		});
	};

	connect();

	return () => {
		closed = true;
		if (retry) clearTimeout(retry);
		socket?.destroy();
	};
}

// ---------------------------------------------------------------------------
// Higher-level helpers over the CLI
// ---------------------------------------------------------------------------

export function listAgents(): HerdrAgent[] {
	const output = runCli(["agent", "list"], 10_000) as { result?: { agents?: HerdrAgent[] } } | undefined;
	return output?.result?.agents ?? [];
}

/** Live agents keyed by pane id. Absence means the pane is gone or holds no agent. */
export function agentByPane(): Map<string, HerdrAgent> {
	return new Map(listAgents().map((agent) => [agent.pane_id, agent]));
}

export function getAgent(target: string): HerdrAgent | undefined {
	try {
		const output = runCli(["agent", "get", target], 10_000) as { result?: { agent?: HerdrAgent } } | undefined;
		return output?.result?.agent;
	} catch {
		return undefined;
	}
}

export function readAgent(target: string, lines = 120, source = "recent-unwrapped"): string {
	const output = runCli(["agent", "read", target, "--source", source, "--lines", String(lines)]);
	return typeof output === "string" ? output : JSON.stringify(output);
}

export interface CreatedTab {
	tabId: string;
	paneId: string;
}

export function createTab(options: {
	workspaceId?: string;
	label?: string;
	cwd?: string;
	env?: Record<string, string>;
}): CreatedTab {
	const args = ["tab", "create", "--no-focus"];
	if (options.workspaceId) args.push("--workspace", options.workspaceId);
	if (options.label) args.push("--label", options.label);
	if (options.cwd) args.push("--cwd", options.cwd);
	for (const [key, value] of Object.entries(options.env ?? {})) args.push("--env", `${key}=${value}`);

	const output = runCli(args) as
		| { result?: { tab?: { tab_id?: string }; root_pane?: { pane_id?: string } } }
		| undefined;
	const tabId = output?.result?.tab?.tab_id;
	const paneId = output?.result?.root_pane?.pane_id;
	if (!tabId || !paneId) throw new HerdrError("herdr tab create did not return tab and pane identifiers");
	return { tabId, paneId };
}

export function startAgent(options: {
	name: string;
	paneId: string;
	args: string[];
	timeoutMs?: number;
}): HerdrAgent {
	const output = runCli([
		"agent",
		"start",
		options.name,
		"--kind",
		"pi",
		"--pane",
		options.paneId,
		"--timeout",
		String(options.timeoutMs ?? 60000),
		"--",
		...options.args,
	]) as { result?: { agent?: HerdrAgent } } | undefined;
	const agent = output?.result?.agent;
	if (!agent?.pane_id) throw new HerdrError("herdr agent start did not return an agent");
	return agent;
}

export function focusAgent(target: string): void {
	runCli(["agent", "focus", target]);
}

export function closePane(paneId: string): void {
	runCli(["pane", "close", paneId]);
}

export function renameTab(tabId: string, label: string): void {
	runCli(["tab", "rename", tabId, label]);
}

export function reportMetadata(
	paneId: string,
	metadata: {
		source: string;
		agent?: string;
		title?: string;
		tokens?: Record<string, string>;
		stateLabels?: Record<string, string>;
		ttlMs?: number;
	},
): void {
	const args = ["pane", "report-metadata", paneId, "--source", metadata.source];
	if (metadata.agent) args.push("--agent", metadata.agent);
	if (metadata.title) args.push("--title", metadata.title);
	for (const [name, value] of Object.entries(metadata.tokens ?? {})) args.push("--token", `${name}=${value}`);
	for (const [status, text] of Object.entries(metadata.stateLabels ?? {})) {
		args.push("--state-label", `${status}=${text}`);
	}
	if (metadata.ttlMs !== undefined) args.push("--ttl-ms", String(metadata.ttlMs));
	// Display-only and called from the child's tool loop, so bound it tightly.
	runCli(args, 5000);
}

/** Herdr agent names must look like `[a-z][a-z0-9_-]{0,31}`. */
export function sanitizeAgentName(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/-{2,}/g, "-")
		.replace(/^[-_]+|[-_]+$/g, "")
		.slice(0, 32);
	if (!normalized) return "";
	return /^[a-z]/.test(normalized) ? normalized : `s${normalized}`.slice(0, 32);
}

/**
 * Pick a live-unique Herdr agent name.
 *
 * Herdr requires uniqueness among live agents, so a descriptive name is used when
 * free and the always-unique handle is appended otherwise.
 */
export function allocateAgentName(desired: string | undefined, handle: string, taken: Set<string>): string {
	const base = (desired ? sanitizeAgentName(desired) : "") || "sub";
	if (!taken.has(base)) return base;
	const suffixed = `${base.slice(0, 32 - handle.length - 1)}-${handle}`;
	if (!taken.has(suffixed)) return suffixed;
	return `sub-${handle}`.slice(0, 32);
}

export interface DoctorReport {
	inHerdr: boolean;
	socketPath?: string;
	paneId?: string;
	workspaceId?: string;
	cliVersion?: string;
	cliReachable: boolean;
	agents: number;
	integration?: string;
	problems: string[];
}

/** Diagnose whether this environment can host subagents. */
export function doctor(): DoctorReport {
	const report: DoctorReport = {
		inHerdr: isInHerdr(),
		socketPath: herdrSocketPath(),
		paneId: callerPaneId(),
		workspaceId: callerWorkspaceId(),
		cliReachable: false,
		agents: 0,
		problems: [],
	};

	const version = spawnSync(herdrBin(), ["--version"], { encoding: "utf8" });
	if (version.error) {
		report.problems.push(`The herdr binary is not runnable: ${version.error.message}`);
		return report;
	}
	report.cliVersion = (version.stdout ?? "").trim();

	try {
		report.agents = listAgents().length;
		report.cliReachable = true;
	} catch (error) {
		report.problems.push(`Could not talk to the Herdr server: ${error instanceof Error ? error.message : String(error)}`);
	}

	const status = spawnSync(herdrBin(), ["integration", "status"], { encoding: "utf8" });
	if (status.status === 0) {
		const line = (status.stdout ?? "").split("\n").find((entry) => entry.startsWith("pi:"));
		report.integration = line?.trim();
		if (line && !line.startsWith("pi: ok")) {
			report.problems.push(`The pi integration looks stale (${line.trim()}); run: herdr integration install pi`);
		}
	}

	if (!report.inHerdr) {
		report.problems.push("Not running inside Herdr. Subagents need HERDR_ENV=1 and HERDR_SOCKET_PATH.");
	}
	if (!report.paneId) report.problems.push("HERDR_PANE_ID is unset, so the caller pane cannot be resolved.");
	return report;
}
