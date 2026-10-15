# pi-subagent-herdr

Observable, persistent Pi subagents that live in [Herdr](https://herdr.dev) tabs.

Delegate a task to a separate Pi process with its own context. Watch it work from the Herdr sidebar, focus its tab to see the full interactive TUI, and let it keep running after you quit the parent session.

This is a Herdr-native fork of [`badlogic/pi-subagent`](https://github.com/badlogic/pi-subagent), which drove tmux.

## Why Herdr instead of tmux

tmux is a dumb terminal holder: it has no idea an agent is running inside it. That forces a tmux-based design to *infer* everything, and it cannot see the one thing that matters most — what the agent is actually doing.

Herdr is agent-aware. It recognises Pi in a pane, tracks its lifecycle itself, and exposes events over a socket API. So a whole layer of guesswork disappears:

| What the parent needs | tmux | Herdr |
|---|---|---|
| Is the child alive? | `tmux has-session` (poll) | `pane.exited` event (push) |
| What state is it in? | child self-reports to a JSON file | `agent_status`, authoritative |
| **Is it stuck waiting for me?** | **unknown — no such concept** | **`blocked`** |
| Waiting for a run to finish | poll `metadata.json` every 400ms | `pane.agent_status_changed` events |
| Where is its transcript? | child writes it into metadata | `agent_session`, reported by Herdr |
| What is it doing right now? | nothing — attach and look | `herdr agent read` |
| How do I see it? | attach, suspending the parent TUI | `herdr agent focus` |
| Who owns its lifetime? | the parent, which must suspend/relaunch it | the Herdr server |

## Requirements

- [Pi](https://github.com/earendil-works/pi) running **inside a Herdr pane**
- Node.js 22.19 or newer
- Herdr (tested against 0.9.3)

Check everything at once:

```sh
subagent doctor
```

`doctor` also warns when Herdr's own Pi integration is stale. Keep it current so Herdr can classify child state reliably:

```sh
herdr integration install pi
```

## Install

The extension and the `subagent` CLI are two halves of the same package, and both are needed.

```sh
pi install npm:pi-subagent-herdr
```

Then run `/reload` in an existing Pi session, and confirm the environment with `subagent doctor`.
The extension contributes its bundled skill automatically. `pi install git:github.com/komikive/pi-subagent-herdr` works too, though that route is not built, so it only carries the sources.

Pi installs a package's extension but not its `bin` entries, so on load the extension links its own
CLI into `~/.pi/agent/bin`, the directory Pi already puts on `PATH`. That link is created once and is
idempotent. It never takes over a name something else already owns — your own link, a project-local
install, or a plain file all win over it — and a link left dangling by a moved install is the one
case it repairs.

To manage that link yourself instead, point it at the CLI inside the installed package. The path
follows `PI_CODING_AGENT_DIR`, which defaults to `~/.pi/agent`:

```sh
ln -s "$HOME/.pi/agent/npm/node_modules/pi-subagent-herdr/dist/subagent.js" \
      "$HOME/.pi/agent/bin/subagent"
```

### Working on the extension itself

Clone it wherever you like and link the directory in. Pi discovers extension directories through
symlinks, so a rebuild plus `/reload` picks up your edits without a reinstall:

```sh
git clone https://github.com/komikive/pi-subagent-herdr ~/dev/pi-subagent-herdr
cd ~/dev/pi-subagent-herdr && npm install
ln -s ~/dev/pi-subagent-herdr ~/.pi/agent/extensions/subagent
```

`npm run check`, `npm run build`, and `npm test` are the three steps. The extension test needs a
Herdr pane and skips that half without one; it exercises both the source and, when built, the
packaged form.

`npm run build` bundles `dist/`, which is what npm publishes. The published bin has to be compiled
JavaScript: Node refuses to strip types for files under `node_modules`
(`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), and `pi install` puts packages there, so a
TypeScript bin would be dead on arrival for every npm user.

## Usage

Spawn with a descriptive name, using the parent session's provider, model, and thinking level:

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

The name becomes the Herdr tab label, so the child shows up in your sidebar next to your own work. Your focus does not move.

Override the model configuration when needed:

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

Provide multiple prompt fragments and files:

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

The task reaches the child as its first inbox message, not as a command-line argument. `--file` contents are inlined into it, and `--cwd` selects the working directory (default: the current one).

Restrict tools for a read-only investigation:

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

Manage a run by its handle:

```sh
subagent list
subagent status a1b2c3
subagent read a1b2c3 --lines 80
subagent rename a1b2c3 "error handling review"
subagent send a1b2c3 "Focus on error handling"
subagent send a1b2c3 --follow-up "Then summarize"
subagent wait a1b2c3
subagent wait a1b2c3 --timeout 300
subagent focus a1b2c3
subagent stop a1b2c3
subagent prune
```

Handles and names are both accepted as targets. A handle always wins; a name is only
accepted when it identifies exactly one run.

`/subagent` lists this session's runs and focuses the one you pick.

## Statuses

Status comes straight from Herdr:

| Status | Meaning |
|---|---|
| `working` | producing work |
| `idle` / `done` | turn finished, waiting. `done` is the same state before the tab has been looked at |
| `blocked` | **stalled on an approval or question prompt** |
| `unknown` | Herdr sees an agent but cannot classify it; not proof of completion |
| `gone` | The pane no longer hosts an agent. Applies to recorded runs that have not been cleaned up yet. |

`blocked` is the state a tmux design cannot express. The extension surfaces it in the widget, in `subagent status`, and by failing `subagent wait` immediately instead of hanging until its timeout.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery. The subagent control bridge is re-injected explicitly, along with Herdr's Pi integration when it is installed, so the child still works and is still tracked
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill.

## Lifetime

Subagents belong to the Herdr server, not to the Pi session that spawned them:

- They survive `/reload`.
- They keep running when the parent session quits. The parent does no teardown.
- Resuming that session re-adopts them by matching the saved parent session id against live Herdr panes.
- Records whose pane is gone are cleaned up on the next `session_start`, and `subagent prune` does the same on demand for the current session. `subagent prune --all` widens that to every session, which is why it is not the default: a manifest is the only record of how to re-adopt a running pane.

`subagent spawn` closes the pane it just created if the child fails to start, and `subagent stop` closes a pane for any other reason. Never close a Herdr pane by hand that `subagent spawn` created.

## How it works

```
parent Pi (in a Herdr pane)
├── extension
│   ├── widget ......... herdr agent list, joined with local manifests
│   ├── socket ......... events.subscribe → instant status changes
│   ├── /subagent ...... herdr agent focus
│   └── blocked bridge . pi.events.emit("herdr:blocked", …)
└── subagent CLI ....... herdr tab create / agent start / …

child Pi (in its own Herdr tab)
└── extension
    ├── control bridge . drains inbox/ into user messages
    └── metrics ........ pane.report-metadata → ctx tokens, tool count, cost
```

**The manifest is not a state cache.** Herdr owns liveness, status, and identity. `~/.pi/agent/subagents/<handle>/metadata.json` only stores what Herdr cannot tell us: how the child was launched, which parent session it belongs to, and the transcript path this CLI assigned via `--session`. (Herdr does report an `agent_session` for a pane, and that is what its own sidebar tooling uses, but because the CLI pins the session file itself there is nothing to reconcile.)

**Messages go through an inbox, not the terminal.** `herdr agent prompt` types into the pane, but Pi's follow-up semantics require `alt+enter`, which cannot be expressed that way. A directory of atomically-written JSON files supports exact `steer` versus `followUp` delivery and does not depend on the pane's terminal state.

**`wait` is event-driven.** It subscribes to `pane.agent_status_changed`, `pane.exited`, and `pane.closed` for its target, so a long wait costs one socket instead of a `herdr agent get` process spawn every 400ms. A slow poll stays as a safety net, because a reconnect can drop the one transition being waited for. Measured on a 13-second wait: 2 herdr calls, against roughly 32 for the polling version. The child writes its own transcript, so a settled status can briefly precede the final message; that narrow window is re-checked quickly rather than falling through to the slow poll.

**`spawn` decides readiness itself.** `herdr agent start` returns only once the agent is interactively idle, and a freshly started child is almost never idle — its task is already queued. That made spawn time a race, measured at both 4s and 32s for the same 25-second task, and a slow spawn serialises every parallel dispatch. The start call is now bounded and the agent is confirmed through the same liveness signal every other command uses.

`subagent wait` reads the child's transcript and reconstructs the active branch by walking `parentId` back from the newest entry. Reading the last line would be wrong after compaction or branching.

### A note on `blocked`

Herdr's Pi integration listens for a `herdr:blocked` event on Pi's event bus, but nothing in Pi or in that integration emits it — so a Pi pane sitting on a dialog keeps reading as `working`. Herdr also skips its own screen detection for Pi (`full_lifecycle_hook_authority`), so the reported state is the only signal there is.

`index.ts` supplies the missing emitter by mapping `ui_prompt_start` / `ui_prompt_end` onto that channel. The integration file is managed by Herdr and must not be edited in place, so the emit belongs in a companion extension.

## Development

```sh
npm install
npm run check     # tsc --noEmit
```

Edit in place and run `/reload` in Pi. Children are fresh processes, so they pick up changes on the next spawn without any reload.

## Credits

A Herdr-native derivative of [`badlogic/pi-subagent`](https://github.com/badlogic/pi-subagent) by
[badlogic](https://github.com/badlogic), which drove tmux. The command surface, the control-inbox
message channel, the two-mode extension structure, the active-branch transcript reader, and much of
the wording in `skills/subagent/SKILL.md` come from there; the Herdr substrate, the observability
layer, the metrics reporting, and the `blocked` detection are new here.

See [NOTICE](NOTICE) for the itemised breakdown. The upstream repository publishes no license file,
so it grants no explicit redistribution terms; this project is MIT in the same spirit as
[Pi](https://github.com/earendil-works/pi) itself, with attribution kept here and in `NOTICE`.

## License

MIT. See [LICENSE](LICENSE).
