#!/usr/bin/env node

/**
 * `subagent` — control CLI for Herdr-backed Pi subagents.
 *
 * Runs inside the parent session's bash tool. It reads the caller's Herdr pane
 * from the environment, so every subagent is created as a sibling tab in the
 * Herdr session the parent already lives in.
 */

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	agentByPane,
	allocateAgentName,
	callerWorkspaceId,
	closePane,
	createTab,
	doctor,
	focusAgent,
	getAgent,
	isInHerdr,
	listAgents,
	readAgent,
	renameTab,
	reportMetadata,
	sanitizeAgentName,
	startAgent,
	type HerdrAgent,
} from "./herdr.ts";
import {
	assistantText,
	countAssistantMessages,
	getAgentDir,
	getRunsDir,
	inboxDir,
	isSettled,
	listManifests,
	readLatestAssistant,
	readManifest,
	removeRunDir,
	runDirForHandle,
	runDisplayName,
	runLabel,
	isValidRunName,
	pendingInboxCount,
	updateManifest,
	writeManifest,
	type InboxMessage,
	type RunManifest,
	type RunView,
} from "./shared.ts";

const packageDir = dirname(fileURLToPath(import.meta.url));

const VALID_THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
const SOURCE = "pi-subagent";
/** Env var the child reads to switch into control-bridge mode. */
export const CHILD_ENV = "PI_SUBAGENT_RUN_DIR";
/** Marks the child so it can refuse to spawn nested subagents. */
export const NESTED_GUARD_ENV = "PI_SUBAGENT_CHILD";

function fail(message: string): never {
	throw new Error(message);
}

function usage(): never {
	fail(`Usage:
  subagent spawn [--name <name>] [--provider <provider>] [--model <model>] [--thinking <level>]
    [--cwd <dir>] [--tools <names>] [--no-extensions] [--no-skills]
    [--no-prompt-templates] [--no-context-files] (--prompt <text> | --file <path>)...
  subagent list
  subagent status <handle>
  subagent read <handle> [--lines <n>]
  subagent rename <handle> <name>
  subagent send <handle> [--follow-up] <message>
  subagent wait <handle> [--timeout <seconds>]
  subagent focus <handle>
  subagent stop <handle>
  subagent prune
  subagent doctor`);
}

function valueAfter(args: string[], index: number, option: string): string {
	const value = args[index + 1];
	if (!value || value.startsWith("--")) fail(`${option} requires a value`);
	return value;
}

function normalizeRunName(value: string): string {
	const name = value.trim();
	if (!isValidRunName(name)) fail("Subagent name must be a single line of 1 to 64 characters");
	return name;
}

/**
 * Resolve a CLI target.
 *
 * Handles are the stable identifiers and always win; names are a convenience, so
 * they are only accepted when they identify exactly one run.
 */
function resolveManifest(target: string): RunManifest | undefined {
	if (/^[a-z0-9]+$/.test(target)) {
		const byHandle = readManifest(runDirForHandle(target));
		if (byHandle) return byHandle;
	}
	const byName = listManifests().filter((manifest) => manifest.name === target);
	if (byName.length > 1) {
		fail(`Name "${target}" is ambiguous; use a handle: ${byName.map((manifest) => manifest.handle).join(", ")}`);
	}
	return byName[0];
}

function getManifest(target: string): RunManifest {
	const manifest = resolveManifest(target);
	if (!manifest) fail(`Unknown subagent: ${target}`);
	return manifest;
}

function generateHandle(): string {
	mkdirSync(getRunsDir(), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 100; attempt++) {
		const handle = randomBytes(3).toString("hex");
		if (!existsSync(runDirForHandle(handle))) return handle;
	}
	fail("Could not allocate a unique subagent handle");
}

function requireHerdr(): void {
	if (isInHerdr()) return;
	fail(
		"Subagents require Herdr. Start Pi inside a Herdr pane (HERDR_ENV=1, HERDR_SOCKET_PATH, HERDR_PANE_ID) and try again.",
	);
}

// ---------------------------------------------------------------------------
// spawn
// ---------------------------------------------------------------------------

function spawnSubagent(args: string[]): void {
	if (process.env[NESTED_GUARD_ENV]) fail("Nested subagents are disabled");
	requireHerdr();

	let name: string | undefined;
	let provider = process.env.PI_PROVIDER;
	let model = process.env.PI_MODEL;
	let thinking = process.env.PI_REASONING_LEVEL || "medium";
	let cwd = process.cwd();
	let tools: string | undefined;
	let noExtensions = false;
	let noSkills = false;
	let noPromptTemplates = false;
	let noContextFiles = false;
	const prompts: string[] = [];
	const files: string[] = [];

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		switch (arg) {
			case "--name":
				name = normalizeRunName(valueAfter(args, i, arg));
				i++;
				break;
			case "--provider":
				provider = valueAfter(args, i, arg);
				i++;
				break;
			case "--model":
				model = valueAfter(args, i, arg);
				i++;
				break;
			case "--thinking":
				thinking = valueAfter(args, i, arg);
				i++;
				break;
			case "--cwd":
				cwd = resolve(valueAfter(args, i, arg));
				i++;
				break;
			case "--tools":
				tools = valueAfter(args, i, arg);
				i++;
				break;
			case "--no-extensions":
				noExtensions = true;
				break;
			case "--no-skills":
				noSkills = true;
				break;
			case "--no-prompt-templates":
				noPromptTemplates = true;
				break;
			case "--no-context-files":
				noContextFiles = true;
				break;
			case "--prompt":
				prompts.push(valueAfter(args, i, arg));
				i++;
				break;
			case "--file": {
				const file = resolve(valueAfter(args, i, arg));
				if (!existsSync(file)) fail(`File not found: ${file}`);
				files.push(file);
				i++;
				break;
			}
			default:
				fail(`Unknown spawn argument: ${arg}`);
		}
	}

	if (!provider) fail("No provider specified and PI_PROVIDER is not set");
	if (!model) fail("No model specified and PI_MODEL is not set");
	if (!VALID_THINKING_LEVELS.has(thinking)) fail(`Invalid thinking level: ${thinking}`);
	if (tools !== undefined && !tools.split(",").some((entry) => entry.trim()))
		fail("--tools requires at least one tool name");
	if (prompts.length === 0 && files.length === 0) fail("spawn requires at least one --prompt or --file");
	if (!existsSync(cwd)) fail(`Working directory not found: ${cwd}`);

	const handle = generateHandle();
	const runDir = runDirForHandle(handle);
	const sessionFile = join(runDir, "session.jsonl");
	mkdirSync(inboxDir(runDir), { recursive: true, mode: 0o700 });
	writeFileSync(sessionFile, "", { mode: 0o600 });

	const launchArgs: string[] = [];
	if (tools) launchArgs.push("--tools", tools);
	if (noExtensions) {
		// `--no-extensions` disables discovery, which would also remove this extension's
		// control bridge and Herdr's pi integration. Both are load-bearing, so inject them
		// explicitly: without the bridge the child never sees its task, and without the
		// integration Herdr cannot classify its state.
		launchArgs.push("--no-extensions", "--extension", join(packageDir, "index.ts"));
		const herdrBridge = join(getAgentDir(), "extensions", "herdr-agent-state.ts");
		if (existsSync(herdrBridge)) launchArgs.push("--extension", herdrBridge);
	}
	if (noSkills) launchArgs.push("--no-skills");
	if (noPromptTemplates) launchArgs.push("--no-prompt-templates");
	if (noContextFiles) launchArgs.push("--no-context-files");

	const label = name ?? `subagent ${handle}`;
	const taken = new Set(listAgents().map((agent) => agent.name).filter((entry): entry is string => Boolean(entry)));
	const agentName = allocateAgentName(name, handle, taken);

	// The child inherits this environment through the Herdr pane's shell, which is
	// how the shared extension knows to act as a control bridge rather than a parent.
	const childEnv: Record<string, string> = { [CHILD_ENV]: runDir, [NESTED_GUARD_ENV]: "1" };
	if (process.env.HERDR_BIN_PATH) childEnv.HERDR_BIN_PATH = process.env.HERDR_BIN_PATH;

	const tab = createTab({ workspaceId: callerWorkspaceId(), label, cwd, env: childEnv });

	const initialArgs = [...files.map((file) => `@${file}`)];
	if (prompts.length > 0) {
		// Herdr spawns agents through a shell, so newlines in argv are rejected
		// ("agent arguments cannot be encoded safely for the target shell"). Writing the
		// task to a file and passing it as a single-line `@file` mention keeps arbitrary
		// multi-line prompts working, and survives even if the control bridge fails to load.
		const taskFile = join(runDir, "task.md");
		writeFileSync(taskFile, `Task:\n${prompts.join("\n\n")}\n`, { encoding: "utf8", mode: 0o600 });
		initialArgs.push(`@${taskFile}`);
	}

	const piArgs = [
		"--session",
		sessionFile,
		"--provider",
		provider,
		"--model",
		model,
		"--thinking",
		thinking,
		"--name",
		label,
		...launchArgs,
		...initialArgs,
	];

	try {
		startAgent({ name: agentName, paneId: tab.paneId, args: piArgs });
	} catch (error) {
		closePane(tab.paneId);
		removeRunDir(handle);
		throw error;
	}

	const now = new Date().toISOString();
	const manifest: RunManifest = {
		version: 2,
		handle,
		name,
		parentSessionId: process.env.PI_SESSION_ID || undefined,
		parentSessionFile: process.env.PI_SESSION_FILE || undefined,
		workspaceId: callerWorkspaceId() ?? "",
		tabId: tab.tabId,
		paneId: tab.paneId,
		agentName,
		cwd,
		provider,
		model,
		thinking,
		launchArgs,
		childSessionFile: sessionFile,
		createdAt: now,
		updatedAt: now,
	};
	writeManifest(manifest);

	// Announce the launch parameters on the tab so the Herdr sidebar is informative
	// even before the child reports its first metrics.
	try {
		reportMetadata(tab.paneId, { source: SOURCE, agent: "pi", tokens: { model: `${provider}/${model}` } });
	} catch {
		// Display-only metadata; never fail a spawn over it.
	}

	process.stdout.write(
		`Spawned ${runDisplayName(manifest)}\n` +
			`Status: working\n` +
			`Pane: ${tab.paneId}  Tab: ${tab.tabId}  Agent: ${agentName}\n` +
			`Attach: subagent focus ${handle}\n`,
	);
}

// ---------------------------------------------------------------------------
// queries
// ---------------------------------------------------------------------------

/** Join manifests with the live Herdr view. */
function viewOf(manifest: RunManifest, agents: Map<string, HerdrAgent>): RunView {
	const agent = agents.get(manifest.paneId);
	return {
		manifest,
		status: agent ? agent.agent_status : "gone",
		agentName: agent?.name ?? manifest.agentName,
		tokens: agent?.tokens ?? {},
	};
}

function currentViews(): RunView[] {
	const agents = agentByPane();
	return listManifests(process.env.PI_SESSION_ID || undefined).map((manifest) => viewOf(manifest, agents));
}

function describeTokens(tokens: Record<string, string>): string {
	const parts: string[] = [];
	if (tokens.ctx) parts.push(`ctx=${tokens.ctx}`);
	if (tokens.tools) parts.push(`tools=${tokens.tools}`);
	if (tokens.cost) parts.push(`cost=$${tokens.cost}`);
	return parts.join(" ");
}

function statusSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const manifest = getManifest(args[0]);
	const agent = getAgent(manifest.paneId);
	const status = agent ? agent.agent_status : "gone";
	process.stdout.write(
		`${runDisplayName(manifest)}: ${status} (${manifest.provider}/${manifest.model}, ${manifest.thinking})\n` +
			`Pane: ${manifest.paneId}  Tab: ${manifest.tabId}  Agent: ${manifest.agentName}\n` +
			`Attach: subagent focus ${manifest.handle}\n`,
	);
	if (agent?.tokens) {
		const described = describeTokens(agent.tokens);
		if (described) process.stdout.write(`Tokens: ${described}\n`);
	}
	if (status === "blocked") {
		process.stdout.write(`Blocked: waiting for input in the Herdr pane.\n`);
	}
}

function listSubagents(args: string[]): void {
	if (args.length !== 0) usage();
	const views = currentViews();
	if (views.length === 0) {
		process.stdout.write("No subagents\n");
		return;
	}
	for (const view of views) {
		const { manifest, status, tokens } = view;
		const described = describeTokens(tokens);
		process.stdout.write(
			`${runDisplayName(manifest)}  ${status.padEnd(8)}  ${manifest.provider}/${manifest.model}  ${manifest.thinking}` +
				`${described ? `  ${described}` : ""}\n`,
		);
	}
}

function readSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage();
	let lines = 120;
	if (args.length > 0) {
		if (args.length !== 2 || args[0] !== "--lines") usage();
		const parsed = Number(args[1]);
		if (!Number.isInteger(parsed) || parsed <= 0) fail("--lines must be a positive integer");
		lines = parsed;
	}
	const manifest = getManifest(handle);
	process.stdout.write(`${readAgent(manifest.paneId, lines)}\n`);
}

function focusSubagent(args: string[]): void {
	if (args.length !== 1) usage();
	const manifest = getManifest(args[0]);
	focusAgent(manifest.paneId);
}

// ---------------------------------------------------------------------------
// mutations
// ---------------------------------------------------------------------------

function renameSubagent(args: string[]): void {
	if (args.length !== 2) usage();
	const manifest = getManifest(args[0]);
	const name = normalizeRunName(args[1]);
	const updated = updateManifest(manifest.handle, { name });
	if (!updated) fail(`Could not rename subagent: ${manifest.handle}`);
	try {
		renameTab(updated.tabId, runLabel(updated));
	} catch {
		// A closed pane or moved tab should not block the rename.
	}
	process.stdout.write(`Renamed ${runDisplayName(updated)}\n`);
}

function sendSubagent(args: string[]): void {
	const handle = args.shift();
	if (!handle) usage();
	let followUp = false;
	const messageParts: string[] = [];
	for (const arg of args) {
		if (arg === "--follow-up") followUp = true;
		else if (arg.startsWith("--")) fail(`Unknown send argument: ${arg}`);
		else messageParts.push(arg);
	}
	const message = messageParts.join(" ").trim();
	if (!message) fail("send requires a message");
	const manifest = getManifest(handle);
	const agent = getAgent(manifest.paneId);
	if (!agent) fail(`${handle} is not running`);

	const queueDir = inboxDir(runDirForHandle(manifest.handle));
	mkdirSync(queueDir, { recursive: true, mode: 0o700 });
	const id = `${Date.now()}-${randomBytes(4).toString("hex")}`;
	const target = join(queueDir, `${id}.json`);
	const temporary = `${target}.tmp`;
	const payload: InboxMessage = { message, delivery: followUp ? "followUp" : "auto" };
	writeFileSync(temporary, `${JSON.stringify(payload)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);

	const status = agent.agent_status;
	const verb = followUp && status === "working" ? "Queued follow-up for" : isSettled(status) ? "Prompted" : "Steered";
	process.stdout.write(`${verb} ${runDisplayName(manifest)}\n`);
}

async function stopSubagent(args: string[]): Promise<void> {
	if (args.length !== 1) usage();
	const manifest = getManifest(args[0]);
	try {
		closePane(manifest.paneId);
	} catch (error) {
		// The pane may already be gone; removing the record is still correct.
		if (existsSync(runDirForHandle(manifest.handle))) {
			process.stderr.write(`Warning: ${error instanceof Error ? error.message : String(error)}\n`);
		}
	}
	removeRunDir(manifest.handle);
	process.stdout.write(`Stopped ${runDisplayName(manifest)}\n`);
}

function pruneSubagents(args: string[]): void {
	if (args.length !== 0) usage();
	const agents = agentByPane();
	let removed = 0;
	for (const manifest of listManifests()) {
		if (agents.has(manifest.paneId)) continue;
		removeRunDir(manifest.handle);
		removed++;
	}
	process.stdout.write(`Pruned ${removed} finished subagent${removed === 1 ? "" : "s"}\n`);
}

async function waitSubagent(args: string[]): Promise<void> {
	const handle = args.shift();
	if (!handle) usage();
	let timeoutSeconds = 1800;
	if (args.length > 0) {
		if (args.length !== 2 || args[0] !== "--timeout") usage();
		const parsed = Number(args[1]);
		if (!Number.isInteger(parsed) || parsed <= 0) fail("--timeout must be a positive integer");
		timeoutSeconds = parsed;
	}

	const manifest = getManifest(handle);
	const deadline = Date.now() + timeoutSeconds * 1000;
	let sawWorking = false;
	// Give the transcript a moment to flush once the agent reports settled; the
	// session file is written by the child, not by us.
	let settledSince: number | undefined;

	while (Date.now() < deadline) {
		const agent = getAgent(manifest.paneId);
		if (!agent) fail(`${handle} exited before finishing`);
		const status = agent.agent_status;
		if (status === "working") {
			sawWorking = true;
			settledSince = undefined;
		}

		if (status === "blocked") {
			fail(`${handle} is blocked and needs input. Inspect it with: subagent focus ${handle}`);
		}

		if (isSettled(status) && pendingInboxCount(manifest.handle) === 0) {
			settledSince ??= Date.now();
			// `sawWorking` covers a run that started and finished between polls; the
			// transcript check covers a run that was already settled when wait began.
			const elapsed = Date.now() - settledSince;
			if (countAssistantMessages(manifest.childSessionFile) > 0 || (!sawWorking && elapsed > 3000)) {
				const message = readLatestAssistant(manifest.childSessionFile);
				if (!message) fail(`${handle} finished without an assistant response`);
				process.stdout.write(`${handle} finished\n\n${assistantText(message)}\n`);
				if (message.stopReason === "error" || message.stopReason === "aborted") process.exitCode = 1;
				return;
			}
			if (elapsed > 30000) fail(`${handle} reported ${status} but produced no assistant response`);
		} else {
			settledSince = undefined;
		}

		await new Promise((resolveDelay) => setTimeout(resolveDelay, 400));
	}
	fail(`Timed out after ${timeoutSeconds}s waiting for ${handle}`);
}

function doctorSubagent(args: string[]): void {
	if (args.length !== 0) usage();
	const report = doctor();
	process.stdout.write(`herdr cli:      ${report.cliVersion ?? "not found"}\n`);
	process.stdout.write(`inside herdr:   ${report.inHerdr ? "yes" : "NO"}\n`);
	process.stdout.write(`caller pane:    ${report.paneId ?? "(unset)"}\n`);
	process.stdout.write(`workspace:      ${report.workspaceId ?? "(unset)"}\n`);
	process.stdout.write(`socket:         ${report.socketPath ?? "(unset)"}\n`);
	process.stdout.write(`server:         ${report.cliReachable ? `reachable, ${report.agents} agent(s)` : "UNREACHABLE"}\n`);
	process.stdout.write(`pi integration: ${report.integration ?? "(unknown)"}\n`);
	if (report.problems.length > 0) {
		process.stdout.write(`\nProblems:\n${report.problems.map((problem) => `  - ${problem}`).join("\n")}\n`);
		process.exitCode = 1;
	} else {
		process.stdout.write(`\nReady to spawn subagents.\n`);
	}
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const command = args.shift();
	switch (command) {
		case "spawn":
			spawnSubagent(args);
			break;
		case "list":
			listSubagents(args);
			break;
		case "status":
			statusSubagent(args);
			break;
		case "read":
			readSubagent(args);
			break;
		case "rename":
			renameSubagent(args);
			break;
		case "send":
			sendSubagent(args);
			break;
		case "wait":
			await waitSubagent(args);
			break;
		case "focus":
			focusSubagent(args);
			break;
		case "stop":
			await stopSubagent(args);
			break;
		case "prune":
			pruneSubagents(args);
			break;
		case "doctor":
			doctorSubagent(args);
			break;
		default:
			usage();
	}
}

main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});


