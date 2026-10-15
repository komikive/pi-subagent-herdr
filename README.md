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

```sh
git clone <your-fork> ~/dev/pi-subagent-herdr
ln -s ~/dev/pi-subagent-herdr ~/.pi/agent/extensions/subagent
ln -s ../extensions/subagent/subagent.ts ~/.pi/agent/bin/subagent
```

Pi discovers extension directories through symlinks, so the git checkout stays where you want it while `/reload` picks up edits. `~/.pi/agent/bin` is already on `PATH` inside Pi's bash tool.

Then run `/reload` in an existing Pi session. The extension contributes its bundled skill automatically.

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
subagent focus a1b2c3
subagent stop a1b2c3
subagent prune
```

`/subagent` lists this session's runs and focuses the one you pick.

## Statuses

Status comes straight from Herdr:

| Status | Meaning |
|---|---|
| `working` | producing work |
| `idle` / `done` | turn finished, waiting. `done` is the same state before the tab has been looked at |
| `blocked` | **stalled on an approval or question prompt** |
| `unknown` | Herdr sees an agent but cannot classify it; not proof of completion |

`blocked` is the state a tmux design cannot express. The extension surfaces it in the widget, in `subagent status`, and by failing `subagent wait` immediately instead of hanging until its timeout.

## Isolation

Optional spawn flags:

- `--tools <names>`: comma-separated tool allowlist
- `--no-extensions`: disable extension discovery. The subagent control bridge and Herdr's Pi integration are re-injected explicitly, so the child still works and is still tracked
- `--no-skills`: disable skills
- `--no-prompt-templates`: disable prompt templates
- `--no-context-files`: ignore repository instruction files

Nested subagents are disabled. Child sessions do not receive the subagent skill.

## Lifetime

Subagents belong to the Herdr server, not to the Pi session that spawned them:

- They survive `/reload`.
- They keep running when the parent session quits. The parent does no teardown.
- Resuming that session re-adopts them by matching the saved parent session id against live Herdr panes.
- Records whose pane is gone are cleaned up on the next `session_start`, and `subagent prune` does it on demand.

Only `subagent stop` closes a pane. Never close a Herdr pane by hand that `subagent spawn` created.

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

**The manifest is not a state cache.** Herdr owns liveness, status, identity, and the child's session path. `~/.pi/agent/subagents/<handle>/metadata.json` only stores what Herdr cannot tell us: how the child was launched and which parent session it belongs to.

**Messages go through an inbox, not the terminal.** `herdr agent prompt` types into the pane, but Pi's follow-up semantics require `alt+enter`, which cannot be expressed that way. A directory of atomically-written JSON files supports exact `steer` versus `followUp` delivery and does not depend on the pane's terminal state.

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

This project is a Herdr-native rewrite of [`badlogic/pi-subagent`](https://github.com/badlogic/pi-subagent) by
[badlogic](https://github.com/badlogic), which drove tmux. The command surface (`spawn` / `send` / `wait` /
`stop` / `rename` / `list`), the control-inbox message channel, the two-mode extension structure
(one file serving both the parent UI and the child control bridge), and much of the wording in
`skills/subagent/SKILL.md` originate there. The Herdr substrate, the observability layer, the metrics
reporting, the `blocked` detection, and the launch-manifest model are new here.

The upstream repository publishes no license file, so it grants no explicit redistribution terms.
This project is distributed under the MIT license in the same spirit as
[Pi](https://github.com/earendil-works/pi) itself, with attribution to the original author kept in
`README.md` and below. If you are the upstream author and want different terms, please open an issue.

## License

MIT. See [LICENSE](LICENSE).

Copyright (c) 2026 komikive. Contains material derived from `badlogic/pi-subagent`,
Copyright (c) badlogic.
