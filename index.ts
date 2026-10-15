/**
 * Pi extension for Herdr-backed subagents.
 *
 * One file, two roles, selected by `PI_SUBAGENT_RUN_DIR`:
 *
 * - Parent: renders the subagent widget, serves `/subagent`, and reconciles
 *   manifests with the live Herdr session.
 * - Child: acts as the control bridge, draining the inbox into user messages and
 *   publishing token/cost metrics back to Herdr.
 *
 * Unlike the tmux design this is forked from, the parent never owns the child's
 * lifetime. Panes belong to the Herdr server, so quitting Pi leaves subagents
 * running and resuming the session re-adopts them.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DynamicBorder, type ExtensionAPI, type ExtensionContext, keyHint } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text, type TUI } from "@earendil-works/pi-tui";
import {
	agentByPane,
	focusAgent,
	herdrSubscribe,
	isInHerdr,
	reportMetadata,
	type HerdrAgent,
	type HerdrSubscriptionEvent,
} from "./herdr.ts";
import {
	getAgentDir,
	inboxDir,
	listManifests,
	removeRunDir,
	runDisplayName,
	siblingEntry,
	type InboxMessage,
	type RunManifest,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));
const CHILD_ENV = "PI_SUBAGENT_RUN_DIR";
const METRICS_SOURCE = "pi-subagent";

/**
 * Publish the bundled CLI as `subagent` on Pi's bin directory.
 *
 * Pi installs a package's extension but not its `bin` entries, and `~/.pi/agent/bin` is the
 * directory Pi puts on PATH for exactly this purpose. Without a link the bundled skill would
 * describe commands that cannot be run. This is why a plain `pi install` is the whole
 * installation.
 *
 * Deliberately conservative:
 * - Idempotent, so loading this extension repeatedly changes nothing.
 * - An entry that resolves to something else is left alone. A project-local install and a
 *   global install must not fight over the same name, and a user's own link outranks ours.
 * - A dangling link is ours to repair, because pointing at a package that has since moved is
 *   the one failure mode this exists to fix.
 * - Any failure is swallowed. A convenience for the CLI must never stop the extension itself
 *   from loading.
 */
function ensureCliOnPath(): void {
	try {
		// Compiled when published, TypeScript in a development checkout.
		const cli = siblingEntry(packageDir, "subagent");
		if (!cli) return;
		const link = join(getAgentDir(), "bin", "subagent");

		let entryExists = true;
		try {
			lstatSync(link);
		} catch {
			entryExists = false;
		}

		if (entryExists) {
			let resolved: string | undefined;
			try {
				// Throws for a dangling link, which is precisely the case worth repairing.
				resolved = realpathSync(link);
			} catch {
				resolved = undefined;
			}
			if (resolved === undefined) unlinkSync(link);
			else if (resolved === realpathSync(cli)) return;
			else return; // A live entry owned by someone else.
		}

		mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
		symlinkSync(cli, link);
	} catch {
		// Ignored on purpose; see above.
	}
}

function isInboxMessage(value: unknown): value is InboxMessage {
	if (typeof value !== "object" || value === null) return false;
	const message = value as Record<string, unknown>;
	return typeof message.message === "string" && (message.delivery === "auto" || message.delivery === "followUp");
}

function compact(value: number): string {
	if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
	if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
	return String(value);
}

function statusColor(status: string): "warning" | "success" | "error" | "muted" {
	switch (status) {
		case "working":
			return "warning";
		case "blocked":
			return "error";
		case "idle":
		case "done":
			return "success";
		default:
			return "muted";
	}
}

/**
 * Report blocking UI prompts to Herdr.
 *
 * Herdr's Pi integration listens for `herdr:blocked` on Pi's event bus, but nothing in
 * Pi or in that integration emits it, so a Pi pane sitting on a dialog keeps reading as
 * `working`. Herdr also skips its own screen detection for Pi
 * (`screen_detection_skip_reason: full_lifecycle_hook_authority`), so the reported state is
 * the only signal there is. The integration file is managed by Herdr and must not be edited,
 * so the emit lives here instead.
 *
 * This is what makes `blocked` work at all: without it, neither the parent widget nor
 * `subagent wait` can tell that a child is stalled waiting for the user.
 */
function installBlockedBridge(pi: ExtensionAPI): void {
	const report = (data: { active: boolean; label?: string }): void => {
		if (!isInHerdr()) return;
		try {
			pi.events.emit("herdr:blocked", data);
		} catch {
			// The event bus is best-effort; never let reporting break a prompt.
		}
	};
	// `ui_prompt_start`/`end` fire once per outermost prompt, so the pairs are balanced.
	pi.on("ui_prompt_start", (event) => report({ active: true, label: event.title ?? event.kind }));
	pi.on("ui_prompt_end", () => report({ active: false }));
}

export default function subagentExtension(pi: ExtensionAPI) {
	const runDir = process.env[CHILD_ENV];
	ensureCliOnPath();
	installBlockedBridge(pi);

	// =========================================================================
	// Parent
	// =========================================================================
	if (!runDir) {
		pi.on("resources_discover", () => ({ skillPaths: [join(packageDir, "skills")] }));

	let widgetTimer: ReturnType<typeof setInterval> | undefined;
	let widgetContext: ExtensionContext | undefined;
	let unsubscribe: (() => void) | undefined;
	let subscribedKey = "";
	const announcedBlocked = new Set<string>();

	/** `45s`, `2m`, `1h04m` — compact enough for a status line. */
	function formatElapsed(ms: number): string {
		const seconds = Math.max(0, Math.floor(ms / 1000));
		if (seconds < 60) return `${seconds}s`;
		const minutes = Math.floor(seconds / 60);
		if (minutes < 60) return `${minutes}m`;
		const hours = Math.floor(minutes / 60);
		return `${hours}h${String(minutes % 60).padStart(2, "0")}m`;
	}

		const liveRuns = (ctx: ExtensionContext, agents: Map<string, HerdrAgent>): Array<{ manifest: RunManifest; agent: HerdrAgent }> => {
			const runs: Array<{ manifest: RunManifest; agent: HerdrAgent }> = [];
			for (const manifest of listManifests(ctx.sessionManager.getSessionId())) {
				const agent = agents.get(manifest.paneId);
				if (agent) runs.push({ manifest, agent });
			}
			return runs;
		};

		const refreshWidget = (): void => {
			const ctx = widgetContext;
			if (!ctx) return;
			let runs: Array<{ manifest: RunManifest; agent: HerdrAgent }>;
			try {
				runs = liveRuns(ctx, agentByPane());
			} catch {
				// A transient Herdr or filesystem failure must not take down the TUI, and must not
				// be rendered as "no subagents". Keep whatever is on screen and retry next tick.
				return;
			}
			if (runs.length === 0) {
				ctx.ui.setWidget("subagents", undefined);
				return;
			}

			// Forget a run once it stops being blocked, so a later stall notifies again.
			const blockedNow = new Set(
				runs.filter((entry) => entry.agent.agent_status === "blocked").map((entry) => entry.manifest.paneId),
			);
			for (const paneId of announcedBlocked) {
				if (!blockedNow.has(paneId)) announcedBlocked.delete(paneId);
			}

			const visible = runs.slice(0, 5).map(({ manifest, agent }) => {
				const status = agent.agent_status;
				const color = statusColor(status);
				const parts: string[] = [manifest.name ?? manifest.handle];

				// The elapsed time carries the status colour while a run is healthy, so the common
				// case stays short and only an exception needs a word. It is measured from the
				// manifest, which records when this turn's prompt was dispatched.
				if (status === "working") {
					const startedAt = Date.parse(manifest.lastPromptAt ?? manifest.createdAt);
					if (Number.isFinite(startedAt)) {
						parts.push(ctx.ui.theme.fg(color, formatElapsed(Date.now() - startedAt)));
					}
				} else {
					const word = status === "blocked" ? ctx.ui.theme.bold("BLOCKED") : status;
					parts.push(ctx.ui.theme.fg(color, word));
				}

				const metrics: string[] = [];
				if (agent.tokens?.ctx) metrics.push(agent.tokens.ctx);
				if (agent.tokens?.cost) metrics.push(`$${agent.tokens.cost}`);
				if (metrics.length > 0) parts.push(ctx.ui.theme.fg("dim", metrics.join(" ")));

				return parts.join(" ");
			});
			if (runs.length > visible.length) {
				visible.push(ctx.ui.theme.fg("muted", `+${runs.length - visible.length}`));
			}
			ctx.ui.setWidget(
				"subagents",
				[ctx.ui.theme.fg("dim", "subagents ") + visible.join(ctx.ui.theme.fg("dim", "  │  "))],
				{ placement: "belowEditor" },
			);
		};

		/** Herdr needs one subscription entry per pane, so the set is rebuilt when it changes. */
		const syncSubscription = (ctx: ExtensionContext): void => {
			let paneIds: string[];
			try {
				paneIds = listManifests(ctx.sessionManager.getSessionId())
					.map((manifest) => manifest.paneId)
					.sort();
			} catch {
				// Leave the current subscription in place; the next tick will retry.
				return;
			}
			const key = paneIds.join(",");
			if (key === subscribedKey) return;
			subscribedKey = key;
			unsubscribe?.();
			unsubscribe = undefined;
			if (paneIds.length === 0 || !isInHerdr()) return;

			unsubscribe = herdrSubscribe(
				() => [
					...paneIds.map((paneId) => ({ type: "pane.agent_status_changed", pane_id: paneId })),
					{ type: "pane.exited" },
					{ type: "pane.closed" },
				],
				(event: HerdrSubscriptionEvent) => {
					refreshWidget();
					if (event.event !== "pane.agent_status_changed") return;
					const paneId = event.data.pane_id;
					const status = event.data.agent_status;
					if (typeof paneId !== "string" || status !== "blocked") return;
					// A blocked child is stalled on an approval prompt. It is the one state
					// tmux could never report, so surface it loudly but only once per streak.
					if (announcedBlocked.has(paneId)) return;
					announcedBlocked.add(paneId);
					const manifest = listManifests(ctx.sessionManager.getSessionId()).find(
						(entry) => entry.paneId === paneId,
					);
					widgetContext?.ui.notify(
						`${manifest ? runDisplayName(manifest) : paneId} is blocked and needs input in Herdr`,
						"error",
					);
				},
				() => {
					// Socket churn is recoverable; the poll below keeps the widget fresh.
				},
			);
		};

		pi.registerCommand("subagent", {
			description: "Focus a subagent's Herdr pane",
			handler: async (args, ctx) => {
				const requested = args.trim();
				const runs = listManifests(ctx.sessionManager.getSessionId());
				if (runs.length === 0) {
					ctx.ui.notify("No subagents were spawned by this session", "info");
					return;
				}

				let target = requested ? runs.find((run) => run.handle === requested) : undefined;
				if (!requested && ctx.mode === "tui") {
					let agents: Map<string, HerdrAgent>;
					try {
						agents = agentByPane();
					} catch (error) {
						ctx.ui.notify(
							`Could not read subagent status: ${error instanceof Error ? error.message : String(error)}`,
							"error",
						);
						return;
					}
					const items: SelectItem[] = runs.map((run) => {
						const agent = agents.get(run.paneId);
						const status = agent?.agent_status ?? "gone";
						const metrics = [
							agent?.tokens?.ctx ? agent.tokens.ctx : "",
							agent?.tokens?.cost ? `$${agent.tokens.cost}` : "",
						]
							.filter(Boolean)
							.join(" ");
						return {
							value: run.handle,
							label: `${run.name ?? run.handle}  ${status.padEnd(8)}  ${run.provider}/${run.model}${metrics ? `  ${metrics}` : ""}`,
						};
					});

					let tui: TUI | undefined;
					const selected = await ctx.ui.custom<string | undefined>((customTui, theme, _keybindings, done) => {
						tui = customTui;
						const list = new SelectList(items, Math.min(items.length, 10), {
							selectedPrefix: (text) => theme.fg("accent", text),
							selectedText: (text) => theme.fg("accent", text),
							description: (text) => theme.fg("muted", text),
							scrollInfo: (text) => theme.fg("dim", text),
							noMatch: (text) => theme.fg("warning", text),
						});
						list.onSelect = (item) => done(item.value);
						list.onCancel = () => done(undefined);

						const container = new Container();
						container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));
						container.addChild(new Text(theme.fg("accent", theme.bold("Focus subagent pane")), 1, 0));
						container.addChild(list);
						container.addChild(
							new Text(
								theme.fg("dim", `${keyHint("tui.select.confirm", "focus")}  ${keyHint("tui.select.cancel", "cancel")}`),
								1,
								0,
							),
						);
						container.addChild(new DynamicBorder((text: string) => theme.fg("accent", text)));

						return {
							render: (width) => container.render(width),
							invalidate: () => container.invalidate(),
							handleInput: (data) => {
								list.handleInput(data);
								customTui.requestRender();
							},
						};
					});
					if (!selected || !tui) return;
					target = runs.find((run) => run.handle === selected);
				}

				if (!target) {
					ctx.ui.notify(requested ? `Unknown subagent: ${requested}` : "No subagent selected", "error");
					return;
				}
				try {
					focusAgent(target.paneId);
				} catch (error) {
					ctx.ui.notify(
						`Could not focus ${target.handle}: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
			},
		});

		pi.on("session_start", (_event, ctx) => {
			// Herdr panes outlive this session, so re-adopt whatever is still alive and drop
			// manifests whose pane is gone. This replaces upstream's suspend-on-quit and
			// relaunch-on-resume machinery.
			//
			// Only prune when the live panes could actually be enumerated: a failed listing must
			// never be read as "nothing is running", which would delete every live manifest.
			try {
				const agents = agentByPane();
				for (const manifest of listManifests(ctx.sessionManager.getSessionId())) {
					if (agents.has(manifest.paneId)) continue;
					removeRunDir(manifest.handle);
				}
			} catch {
				// Herdr unreachable, or the runs directory unreadable. Leave everything alone.
			}

			if (!ctx.hasUI) return;
			widgetContext = ctx;
			refreshWidget();
			widgetTimer = setInterval(() => {
				refreshWidget();
				if (widgetContext) syncSubscription(widgetContext);
			}, 1000);
			widgetTimer.unref();
		});

		pi.on("session_shutdown", (_event, ctx) => {
			if (widgetTimer) clearInterval(widgetTimer);
			widgetTimer = undefined;
			widgetContext = undefined;
			subscribedKey = "";
			announcedBlocked.clear();
			unsubscribe?.();
			unsubscribe = undefined;
			ctx.ui.setWidget("subagents", undefined);
			// Deliberately no teardown: subagents keep running in their Herdr panes.
		});
		return;
	}

	// =========================================================================
	// Child — control bridge
	// =========================================================================
	let currentContext: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let processing = false;
	let toolCalls = 0;
	let costTotal = 0;
	let lastReportAt = 0;

	const reportMetrics = (): void => {
		const ctx = currentContext;
		if (!ctx || !isInHerdr()) return;
		const now = Date.now();
		if (now - lastReportAt < 1000) return;
		lastReportAt = now;

		const usage = ctx.getContextUsage();
		const tokens: Record<string, string> = {};
		if (usage?.tokens != null) {
			tokens.ctx = usage.percent != null ? `${compact(usage.tokens)}/${Math.round(usage.percent)}%` : compact(usage.tokens);
		}
		if (toolCalls > 0) tokens.tools = String(toolCalls);
		if (costTotal > 0) tokens.cost = costTotal.toFixed(2);
		if (Object.keys(tokens).length === 0) return;

		try {
			reportMetadata(process.env.HERDR_PANE_ID ?? "", { source: METRICS_SOURCE, agent: "pi", tokens });
		} catch {
			// Metrics are decorative; never let them break a run.
		}
	};

	const processInbox = async (): Promise<void> => {
		if (processing || !currentContext) return;
		const queueDir = inboxDir(runDir);
		if (!existsSync(queueDir)) return;
		processing = true;
		try {
			for (const name of readdirSync(queueDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort()) {
				const path = join(queueDir, name);
				let payload: InboxMessage;
				try {
					const value: unknown = JSON.parse(readFileSync(path, "utf8"));
					if (!isInboxMessage(value)) throw new Error("Invalid inbox message");
					payload = value;
				} catch {
					unlinkSync(path);
					continue;
				}

				try {
					if (currentContext.isIdle()) {
						pi.sendUserMessage(payload.message);
					} else {
						pi.sendUserMessage(payload.message, {
							deliverAs: payload.delivery === "followUp" ? "followUp" : "steer",
						});
					}
					unlinkSync(path);
				} catch {
					// Leave the message queued and retry on the next tick.
					return;
				}
			}
		} finally {
			processing = false;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		if (!timer) {
			timer = setInterval(() => void processInbox(), 300);
			timer.unref();
		}
		void processInbox();
		reportMetrics();
	});

	pi.on("tool_execution_start", () => {
		toolCalls++;
		// Throttled internally, so a tool-heavy turn still keeps the parent widget current.
		reportMetrics();
	});

	pi.on("turn_end", (event) => {
		const message = event.message as { usage?: { cost?: { total?: number } } } | undefined;
		const total = message?.usage?.cost?.total;
		if (typeof total === "number" && Number.isFinite(total)) costTotal += total;
		reportMetrics();
	});

	pi.on("agent_settled", (_event, ctx) => {
		currentContext = ctx;
		reportMetrics();
	});

	pi.on("session_shutdown", (event) => {
		currentContext = undefined;
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
		if (event.reason === "quit") {
			// Clearing our own metrics stops a closed run's numbers from lingering in Herdr.
			try {
				reportMetadata(process.env.HERDR_PANE_ID ?? "", {
					source: METRICS_SOURCE,
					agent: "pi",
					tokens: { ctx: "exited" },
				});
			} catch {
				// Ignore.
			}
		}
	});
}
