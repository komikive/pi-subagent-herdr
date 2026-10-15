/**
 * Shared state for the CLI and the extension.
 *
 * The on-disk record is a *launch manifest*, not a state cache. Herdr owns
 * liveness, status, identity, and the child's session path; this file only keeps
 * what Herdr cannot tell us: how the child was launched and which parent session
 * it belongs to.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentStatus } from "./herdr.ts";

export interface RunManifest {
	version: 2;
	/** Stable, generated identifier. Survives renames. */
	handle: string;
	/** Display name. Mirrored to the Herdr tab label. */
	name?: string;
	parentSessionId?: string;
	parentSessionFile?: string;

	// Herdr topology. `paneId` is the authoritative handle for every Herdr call.
	workspaceId: string;
	tabId: string;
	paneId: string;
	agentName: string;

	// Relaunch parameters.
	cwd: string;
	provider: string;
	model: string;
	thinking: string;
	/** Extra pi CLI flags (tool allowlist, isolation switches) reused on relaunch. */
	launchArgs?: string[];

	childSessionFile: string;
	/**
	 * When the current turn's prompt was dispatched. The widget measures elapsed time from here
	 * rather than from an observed status change: this survives a reload, needs no event
	 * tracking, and is not disturbed by unrelated status events such as metrics reports.
	 */
	lastPromptAt?: string;
	createdAt: string;
	updatedAt: string;
}

export interface InboxMessage {
	message: string;
	delivery: "auto" | "followUp";
}

/** A manifest joined with the live Herdr view of the same run. */
export interface RunView {
	manifest: RunManifest;
	status: AgentStatus | "gone";
	agentName?: string;
	tokens: Record<string, string>;
}

/** Statuses that mean the agent is not currently producing work. */
export function isSettled(status: AgentStatus | "gone"): boolean {
	return status === "idle" || status === "done";
}

export function getAgentDir(): string {
	return process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
}

export function getRunsDir(): string {
	return join(getAgentDir(), "subagents");
}

export function manifestPath(runDir: string): string {
	return join(runDir, "metadata.json");
}

export function inboxDir(runDir: string): string {
	return join(runDir, "inbox");
}

export function isValidRunName(value: unknown): value is string {
	return (
		typeof value === "string" &&
		value.length > 0 &&
		value.length <= 64 &&
		value.trim() === value &&
		!/[\u0000-\u001f\u007f]/.test(value)
	);
}

/** `name (handle)` when named, otherwise just the handle. */
export function runDisplayName(manifest: RunManifest): string {
	return manifest.name ? `${manifest.name} (${manifest.handle})` : manifest.handle;
}

/** Tab label: the human-facing name, which may contain spaces. */
export function runLabel(manifest: RunManifest): string {
	return manifest.name ?? `subagent ${manifest.handle}`;
}

function isManifest(value: unknown): value is RunManifest {
	if (typeof value !== "object" || value === null) return false;
	const manifest = value as Partial<RunManifest>;
	return (
		manifest.version === 2 &&
		typeof manifest.handle === "string" &&
		typeof manifest.paneId === "string" &&
		typeof manifest.tabId === "string" &&
		typeof manifest.workspaceId === "string" &&
		typeof manifest.agentName === "string" &&
		typeof manifest.childSessionFile === "string" &&
		(manifest.name === undefined || isValidRunName(manifest.name))
	);
}

export function readManifest(runDir: string): RunManifest | undefined {
	try {
		const value: unknown = JSON.parse(readFileSync(manifestPath(runDir), "utf8"));
		return isManifest(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

export function writeManifest(manifest: RunManifest): void {
	const target = manifestPath(runDirForHandle(manifest.handle));
	mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
	const temporary = `${target}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
	renameSync(temporary, target);
}

/**
 * The run directory is derived from the handle, so the manifest never needs to
 * store its own location.
 */
export function runDirForHandle(handle: string): string {
	return join(getRunsDir(), handle);
}

export function updateManifest(handle: string, patch: Partial<RunManifest>): RunManifest | undefined {
	const current = readManifest(runDirForHandle(handle));
	if (!current) return undefined;
	const next: RunManifest = {
		...current,
		...patch,
		version: 2,
		handle: current.handle,
		updatedAt: new Date().toISOString(),
	};
	writeManifest(next);
	return next;
}

export function removeRunDir(handle: string): void {
	rmSync(runDirForHandle(handle), { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}

export function listManifests(parentSessionId?: string): RunManifest[] {
	const root = getRunsDir();
	if (!existsSync(root)) return [];
	const manifests: RunManifest[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifest = readManifest(join(root, entry.name));
		if (!manifest) continue;
		if (parentSessionId && manifest.parentSessionId !== parentSessionId) continue;
		manifests.push(manifest);
	}
	return manifests.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
}

export function pendingInboxCount(handle: string): number {
	const queueDir = inboxDir(runDirForHandle(handle));
	if (!existsSync(queueDir)) return 0;
	return readdirSync(queueDir).filter((name) => name.endsWith(".json")).length;
}

// ---------------------------------------------------------------------------
// Child session transcripts
// ---------------------------------------------------------------------------

interface SessionEntry {
	type: string;
	id: string;
	parentId: string | null;
	message?: unknown;
}

interface AssistantMessage {
	role: "assistant";
	content?: unknown;
	stopReason?: string;
	errorMessage?: string;
}

interface AssistantEntry extends SessionEntry {
	type: "message";
	message: AssistantMessage;
}

function isSessionEntry(value: unknown): value is SessionEntry {
	if (typeof value !== "object" || value === null) return false;
	const entry = value as Record<string, unknown>;
	return (
		typeof entry.type === "string" &&
		typeof entry.id === "string" &&
		(entry.parentId === null || typeof entry.parentId === "string")
	);
}

function parseEntries(sessionFile: string): SessionEntry[] {
	let content: string;
	try {
		content = readFileSync(sessionFile, "utf8");
	} catch {
		return [];
	}
	const entries: SessionEntry[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		try {
			const value: unknown = JSON.parse(line);
			if (isSessionEntry(value)) entries.push(value);
		} catch {
			// The final JSONL record may still be mid-append.
		}
	}
	return entries;
}

/**
 * Walk `parentId` back from the newest entry to reconstruct the live branch.
 *
 * Reading the last line is not enough: compaction and branching leave abandoned
 * entries behind, and the newest *assistant* message on the active branch is the
 * only correct answer to "what did it just say".
 */
function activeBranch(entries: SessionEntry[]): SessionEntry[] {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	const branch: SessionEntry[] = [];
	const seen = new Set<string>();
	let current = entries.at(-1);
	while (current && !seen.has(current.id)) {
		branch.push(current);
		seen.add(current.id);
		current = current.parentId === null ? undefined : byId.get(current.parentId);
	}
	return branch.reverse();
}

function isAssistantEntry(entry: SessionEntry): entry is AssistantEntry {
	if (entry.type !== "message" || typeof entry.message !== "object" || entry.message === null) return false;
	return (entry.message as Record<string, unknown>).role === "assistant";
}

export function readLatestAssistant(sessionFile: string): AssistantMessage | undefined {
	return activeBranch(parseEntries(sessionFile)).findLast(isAssistantEntry)?.message;
}

/**
 * Number of assistant messages on the active branch.
 *
 * Used as the "has this run produced anything yet" latch that upstream spelled
 * `hasStarted`.
 */
export function countAssistantMessages(sessionFile: string): number {
	return activeBranch(parseEntries(sessionFile)).filter(isAssistantEntry).length;
}

export function assistantText(message: AssistantMessage): string {
	if (!Array.isArray(message.content)) return message.errorMessage ?? "(no response text)";
	const parts: string[] = [];
	for (const item of message.content) {
		if (typeof item !== "object" || item === null) continue;
		const block = item as Record<string, unknown>;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n").trim() || message.errorMessage || "(no response text)";
}
