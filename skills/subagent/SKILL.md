---
name: subagent
description: Spawn and communicate with observable Pi subagents running in Herdr panes, for second opinions, independent investigations, and delegated implementation work.
---

# Subagent

Use the `subagent` CLI to delegate work to a separate Pi process that owns its own context and runs in its own Herdr tab. You stay in your pane; the child appears in the Herdr sidebar, where the user can watch it and focus it at any time.

Managed subagents cannot spawn nested subagents, and this skill is not loaded into their sessions. They require Herdr: if `subagent doctor` reports problems, fix those before spawning.

## Spawn

Give each child a short, descriptive name. The name becomes its Herdr tab label:

```sh
subagent spawn --name implementation --prompt "Complete task"
```

By default the child inherits the current Pi provider, model, and reasoning level from the bash environment. Use `--provider`, `--model`, or `--thinking` only when deliberately choosing a different configuration, for example a faster model for simple investigation or a stronger model for difficult review. Never pass `$PI_PROVIDER`, `$PI_MODEL`, or `$PI_REASONING_LEVEL` back to the CLI explicitly.

`--cwd` defaults to the current directory. Repeat `--prompt` and `--file` as needed; Pi receives all of them in the first user turn. Run `subagent spawn` directly without piping or redirecting its concise output.

## Tools

Without `--tools`, Pi enables its four default tools:

- `read` - Read text files and images.
- `bash` - Execute shell commands. This can also modify files, so it is not a read-only capability.
- `edit` - Apply exact text replacements to existing files.
- `write` - Create or overwrite files.

Three additional built-in tools are available but off by default:

- `grep` - Search file contents.
- `find` - Find files by glob pattern.
- `ls` - List directory contents.

`--tools` is a comma-separated allowlist across built-in, extension, and custom tools. Common choices:

```sh
# Enforced read-only repository investigation
--tools read,grep,find,ls

# Investigation that may run tests or other commands; bash can modify files
--tools read,bash,grep,find,ls

# Implementation work: omit --tools to use the defaults
```

## Isolation flags

- `--no-extensions` - Disable normal extension discovery. The subagent control bridge and Herdr's Pi integration are re-injected explicitly, so the child still works and is still tracked.
- `--no-skills` - Hide installed skills from the child. Use for tightly specified tasks that should rely only on the supplied prompt and files.
- `--no-prompt-templates` - Disable prompt-template commands. Usually unnecessary.
- `--no-context-files` - Ignore repository instruction files such as `AGENTS.md` and `CLAUDE.md`. Use only when those instructions would bias an independent investigation.

Spawn prints the handle, the Herdr pane, and the attach command. Keep the handle for later commands.

Subagents are owned by the Herdr server, not by your session. They survive `/reload`, and they keep running when this Pi session quits. Resuming the session re-adopts them automatically. They are only removed by `subagent stop` or `subagent prune`.

## Inspect

```sh
subagent list
subagent status <handle>
subagent read <handle> --lines 80
subagent focus <handle>
```

- `list` shows every subagent of this session with its live status, model, and reported metrics. Run it at any time to rediscover handles.
- `status` shows one run in detail.
- `read` returns a snapshot of the child's terminal output. Use it to check on progress without stealing the user's focus.
- `focus` moves the user's Herdr view to the child's tab. Use it when the user asks to see or take over a run, then ask them to help; the child's full interactive TUI is there and they can type into it.

Statuses come from Herdr:

| Status | Meaning |
|---|---|
| `working` | The child is producing work. |
| `idle` / `done` | The child finished its turn and is waiting. `done` is the same state when the tab has not been looked at yet. |
| `blocked` | **The child is stalled on an approval or question prompt and needs the user.** Tell the user and point them at `subagent focus <handle>`. |
| `unknown` | Herdr sees an agent but cannot classify it. Not proof of completion. |

## Wait

```sh
subagent wait <handle>
subagent wait <handle> --timeout 300
```

`wait` follows the durable session state and prints the child's final assistant response. Run it directly so the bash tool returns that response; do not redirect it to a file or pipe it unless the user explicitly asks for an artifact. Do not infer completion from captured terminal text.

Set the bash tool timeout above `wait`'s default 1800-second deadline. `wait` exits non-zero when the child fails, disappears, or becomes `blocked`; a `blocked` result means the user must act before the run can continue.

## Communicate

```sh
# Change the name shown in the Herdr tab.
subagent rename <handle> "new name"

# Idle: starts a new prompt. Busy: steers the current work.
subagent send <handle> "message"

# Busy: waits until current work finishes, then starts another turn.
subagent send <handle> --follow-up "message"
```

Names are 1-64 characters and need not be unique. Messages are delivered through the subagent extension's control inbox; do not write to the Herdr pane with `herdr agent prompt` or `herdr pane send-text`.

## Stop

```sh
subagent stop <handle>
subagent prune
```

`stop` closes the child's Herdr pane and removes its transcript. `prune` removes records whose pane is already gone.

Explicitly stop every subagent when it is no longer needed; do not leave finished subagents sitting in the sidebar. Keep an idle subagent alive only when concrete follow-up work is expected, then stop it afterward. Never close a Herdr pane you did not create through `subagent spawn`.

The interactive `/subagent` command lists the subagents of this session and focuses the one you select.
