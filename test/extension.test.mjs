// Exercises the extension's parent side, which the CLI never touches.
//
// Two things are covered here:
//   1. The CLI link that makes `pi install` sufficient on its own.
//   2. The widget path: manifest loading, the Herdr join, and widget teardown.
//
// The widget half needs a real Herdr pane and is skipped without one.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = dirname(dirname(fileURLToPath(import.meta.url)));
const cliPath = join(packageDir, "subagent.ts");
const extension = (await import("../index.ts")).default;

let failures = 0;
function check(name, ok, detail = "") {
	console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
	if (!ok) failures++;
}

/** A stand-in for Pi's ExtensionAPI that records what the extension registers. */
function fakePi() {
	const handlers = new Map();
	const commands = new Map();
	return {
		handlers,
		commands,
		on(event, handler) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event).push(handler);
			return () => {};
		},
		registerCommand(name, options) {
			commands.set(name, options);
		},
		events: { emit() {}, on: () => () => {} },
		registerTool() {},
	};
}

/** A stand-in for ExtensionContext, capturing widget writes. */
function fakeCtx(sessionId) {
	const ui = {
		widget: undefined,
		theme: { fg: (_color, text) => text },
		setWidget(_key, value) {
			ui.widget = value;
		},
		notify() {},
	};
	return {
		ui,
		hasUI: true,
		mode: "tui",
		cwd: process.cwd(),
		isIdle: () => true,
		sessionManager: {
			getSessionId: () => sessionId,
			getSessionFile: () => "/tmp/pi-subagent-test-session.jsonl",
		},
	};
}

// ---------------------------------------------------------------------------
// 1. The CLI link
// ---------------------------------------------------------------------------

function loadWithAgentDir(agentDir) {
	process.env.PI_CODING_AGENT_DIR = agentDir;
	delete process.env.PI_SUBAGENT_RUN_DIR;
	const pi = fakePi();
	extension(pi);
	return pi;
}

function linkState(link) {
	try {
		lstatSync(link);
	} catch {
		return { kind: "absent" };
	}
	try {
		return { kind: "resolves", target: realpathSync(link) };
	} catch {
		return { kind: "dangling", raw: readlinkSync(link) };
	}
}

console.log("\n1. CLI link");

{
	const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agentdir-"));
	const link = join(agentDir, "bin", "subagent");
	loadWithAgentDir(agentDir);
	const state = linkState(link);
	check(
		"created when absent",
		state.kind === "resolves" && state.target === realpathSync(cliPath),
		`${state.kind}${state.target ? ` -> ${state.target}` : ""}`,
	);
	loadWithAgentDir(agentDir);
	check("idempotent on a second load", linkState(link).kind === "resolves");
	rmSync(agentDir, { recursive: true, force: true });
}

{
	// A link owned by something else, pointing at a live file, must survive untouched.
	const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agentdir-"));
	const foreignTarget = join(agentDir, "someone-elses-cli");
	writeFileSync(foreignTarget, "#!/bin/sh\n");
	mkdirSync(join(agentDir, "bin"), { recursive: true });
	symlinkSync(foreignTarget, join(agentDir, "bin", "subagent"));
	loadWithAgentDir(agentDir);
	const state = linkState(join(agentDir, "bin", "subagent"));
	check("leaves a foreign live link alone", state.target === realpathSync(foreignTarget), `-> ${state.target}`);

	// A plain file must not be replaced either.
	const agentDir2 = mkdtempSync(join(tmpdir(), "pi-subagent-agentdir-"));
	mkdirSync(join(agentDir2, "bin"), { recursive: true });
	writeFileSync(join(agentDir2, "bin", "subagent"), "not ours\n");
	loadWithAgentDir(agentDir2);
	check(
		"leaves a plain file alone",
		linkState(join(agentDir2, "bin", "subagent")).kind === "dangling" === false,
	);
	rmSync(agentDir, { recursive: true, force: true });
	rmSync(agentDir2, { recursive: true, force: true });
}

{
	// A dangling link is the case this exists to repair.
	const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agentdir-"));
	mkdirSync(join(agentDir, "bin"), { recursive: true });
	symlinkSync(join(agentDir, "gone", "subagent.ts"), join(agentDir, "bin", "subagent"));
	loadWithAgentDir(agentDir);
	const state = linkState(join(agentDir, "bin", "subagent"));
	check("repairs a dangling link", state.kind === "resolves" && state.target === realpathSync(cliPath));
	rmSync(agentDir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 2. The parent widget
// ---------------------------------------------------------------------------

console.log("\n2. Parent widget");

if (process.env.HERDR_ENV !== "1" || !process.env.HERDR_PANE_ID) {
	console.log("  SKIP  not running inside Herdr");
} else {
	const agentDir = mkdtempSync(join(tmpdir(), "pi-subagent-agentdir-"));
	// Point a manifest at this very pane: it is a pane Herdr really reports an agent in,
	// so the join and the widget render are exercised without spawning anything.
	const sessionId = "extension-test-session";
	const handle = "abc123";
	const runDir = join(agentDir, "subagents", handle);
	mkdirSync(runDir, { recursive: true });
	writeFileSync(
		join(runDir, "metadata.json"),
		JSON.stringify({
			version: 2,
			handle,
			name: "widget-probe",
			parentSessionId: sessionId,
			workspaceId: process.env.HERDR_WORKSPACE_ID,
			tabId: "w0:t0",
			paneId: process.env.HERDR_PANE_ID,
			agentName: "widget-probe",
			cwd: process.cwd(),
			provider: "test",
			model: "test",
			thinking: "off",
			childSessionFile: join(runDir, "session.jsonl"),
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
		}),
	);

	const pi = loadWithAgentDir(agentDir);
	const ctx = fakeCtx(sessionId);

	check("registers /subagent", pi.commands.has("subagent"));
	check("registers a resources_discover handler", pi.handlers.has("resources_discover"));

	const skills = pi.handlers.get("resources_discover")?.[0]?.({}, ctx);
	check("contributes the bundled skill", Array.isArray(skills?.skillPaths) && skills.skillPaths.length === 1);

	await pi.handlers.get("session_start")?.[0]?.({}, ctx);
	const widget = ctx.ui.widget;
	check("widget rendered for a live run", Array.isArray(widget), JSON.stringify(widget));
	check(
		"widget names the run and its status",
		Array.isArray(widget) && /widget-probe:(working|idle|done|blocked|unknown)/.test(widget.join("")),
		Array.isArray(widget) ? widget.join("") : "",
	);

	await pi.handlers.get("session_shutdown")?.[0]?.({ reason: "quit" }, ctx);
	check("widget cleared on shutdown", ctx.ui.widget === undefined);

	rmSync(agentDir, { recursive: true, force: true });
}

console.log(`\n${failures === 0 ? "ALL PASS" : `${failures} FAILURE(S)`}`);
process.exit(failures === 0 ? 0 : 1);
