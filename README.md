# pi-subagent-herdr

运行在 [Herdr](https://herdr.dev) 标签页里的 Pi 子代理：可观测、可持久。

把一项任务派给一个独立的 Pi 进程，它有自己的上下文。你可以在 Herdr 侧边栏看着它干活，聚焦它的标签页就是完整的交互式 TUI，而且父会话退出之后它照样继续跑。

本项目是 [`badlogic/pi-subagent`](https://github.com/badlogic/pi-subagent) 的 Herdr 原生分支——上游用的是 tmux。

## 为什么用 Herdr 而不是 tmux

tmux 只是个哑终端容器，它不知道里面正跑着 agent。于是基于 tmux 的设计什么都得靠**推断**，而最要紧的那件事——agent 现在到底在干什么——它看不见。

Herdr 本身认识 agent。它能在 pane 里认出 Pi，自己跟踪生命周期，并通过 socket API 把事件推出来。于是一整层猜测就消失了：

| 父进程需要知道 | tmux 下怎么得到 | Herdr 下怎么得到 |
|---|---|---|
| 子进程还活着吗 | `tmux has-session`（轮询） | `pane.exited` 事件（推送） |
| 它现在什么状态 | 子进程自己写进 JSON 文件 | `agent_status`，权威来源 |
| **它是不是卡在等我？** | **不知道，没这个概念** | **`blocked`** |
| 等一次运行跑完 | 每 400ms 轮询 `metadata.json` | `pane.agent_status_changed` 事件 |
| 它的会话记录在哪 | 子进程写进 metadata | `agent_session`，由 Herdr 报告 |
| 它此刻在干什么 | 没有，只能 attach 去看 | `herdr agent read` |
| 我怎么看它 | attach，父 TUI 得先挂起 | `herdr agent focus` |
| 生命周期归谁 | 父进程，得负责挂起和重启 | Herdr 服务端 |

## 环境要求

- [Pi](https://github.com/earendil-works/pi) 运行在**Herdr 的 pane 内**
- Node.js 22.19 或更高
- Herdr（在 0.9.3 上验证过）

一次检查全部条件：

```sh
subagent doctor
```

`doctor` 还会在 Herdr 自带的 Pi 集成过期时提醒你。保持它是最新的，Herdr 才能可靠地判断子进程状态：

```sh
herdr integration install pi
```

## 安装

扩展和 `subagent` CLI 是同一个包的两半，都必须装。

```sh
pi install npm:pi-subagent-herdr
```

然后在已打开的 Pi 会话里执行 `/reload`，并用 `subagent doctor` 确认环境。扩展会自动装载它自带的技能。`pi install git:github.com/komikive/pi-subagent-herdr` 也能装，但那一路没有构建产物，只带源码。

Pi 会安装包的扩展，但不会安装 `bin` 入口。所以扩展在加载时会把自带的 CLI 链到 `~/.pi/agent/bin`——也就是 Pi 已经放进 `PATH` 的那个目录。这个链接只创建一次且幂等：已经存在的名字它绝不抢占（你自己的链接、项目级安装、普通文件都优先于它），唯一会去修的是被移动过的安装留下的断链。

你也可以自己管理这个链接，直接指向已安装包里的 CLI。路径跟随 `PI_CODING_AGENT_DIR`，默认是 `~/.pi/agent`：

```sh
ln -s "$HOME/.pi/agent/npm/node_modules/pi-subagent-herdr/dist/subagent.js" \
      "$HOME/.pi/agent/bin/subagent"
```

### 修改扩展本身

把仓库克隆到任意位置，再把目录链进去。Pi 通过符号链接发现扩展目录，所以重新构建加 `/reload` 就能生效，不需要重装：

```sh
git clone https://github.com/komikive/pi-subagent-herdr ~/dev/pi-subagent-herdr
cd ~/dev/pi-subagent-herdr && npm install
ln -s ~/dev/pi-subagent-herdr ~/.pi/agent/extensions/subagent
```

三个命令分别是 `npm run check`、`npm run build`、`npm test`。扩展测试需要 Herdr pane，没有就跳过那一半；它同时覆盖源码形态和构建后的打包形态。

`npm run build` 会把代码打包进 `dist/`，那才是 npm 上发布的内容。发布的 bin 必须是编译后的 JavaScript：Node 拒绝为 `node_modules` 下的文件剥离类型（`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`），而 `pi install` 正是把包装到那里，所以 TypeScript 的 bin 对所有 npm 用户都是装了就死。

## 用法

分配任务时给个有意义的名字，默认沿用父会话的 provider、model 和 thinking 等级：

```sh
subagent spawn --name review --prompt "Review the current diff independently"
```

这个名字会变成 Herdr 的标签页标题，于是子代理就和你的工作并排出现在侧边栏里，而你的焦点不会被打断。

需要时覆盖模型配置：

```sh
subagent spawn \
  --provider openai-codex \
  --model gpt-5.4-mini \
  --thinking low \
  --prompt "Find the relevant implementation"
```

提供多段 prompt 和文件：

```sh
subagent spawn \
  --file /tmp/spec.md \
  --prompt "Implement this specification" \
  --prompt "Run the targeted tests"
```

任务是作为第一条 inbox 消息送达子进程的，不走命令行参数。`--file` 的内容会被内联进去，`--cwd` 指定工作目录（默认当前目录）。

只读调查时限制可用工具：

```sh
subagent spawn --tools read,grep,find,ls --prompt "Investigate the failure"
```

用 handle 管理运行：

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

handle 和名字都能作为目标。handle 永远优先；名字只在能唯一确定一次运行时才被接受。

`/subagent` 会列出当前会话的子代理，并把焦点切到你选中的那个。

## 状态

状态直接来自 Herdr：

| 状态 | 含义 |
|---|---|
| `working` | 正在产出 |
| `idle` / `done` | 本轮结束，等待中。`done` 是同一个状态，只是标签页还没被看过 |
| `blocked` | **卡在审批或提问对话框上** |
| `unknown` | Herdr 看到了 agent 但无法分类；不能当作已完成 |
| `gone` | 这个 pane 里已经没有 agent 了。适用于还没被清理的历史记录 |

`blocked` 是 tmux 那套设计表达不出来的状态。扩展会在 widget、`subagent status` 里显示它，并让 `subagent wait` 立刻失败，而不是一直挂到超时。

## 隔离

可选的 spawn 参数：

- `--tools <names>`：逗号分隔的工具白名单
- `--no-extensions`：关闭扩展发现。子代理的控制桥会被显式重新注入，Herdr 的 Pi 集成（如果已安装）也一样，所以子进程照常工作、照常被跟踪
- `--no-skills`：关闭技能
- `--no-prompt-templates`：关闭 prompt 模板
- `--no-context-files`：忽略仓库的指令文件

嵌套子代理是禁用的。子会话不会加载 subagent 技能。

## 生命周期

子代理属于 Herdr 服务端，不属于派发它的那个 Pi 会话：

- 它们能挺过 `/reload`。
- 父会话退出时它们继续跑，父进程不做任何清理动作。
- 重新打开那个会话时，会按保存的父会话 id 与在线的 Herdr pane 比对，把它们认领回来。
- pane 已经消失的记录会在下次 `session_start` 时清理；`subagent prune` 可以对当前会话按需做同样的事。`subagent prune --all` 会扩大到所有会话——这正是它不作为默认行为的原因：manifest 是重新认领一个运行中 pane 的唯一凭据。

如果子进程启动失败，`subagent spawn` 会关掉自己刚创建的那个 pane；其余情况下只有 `subagent stop` 会关 pane。不要手动关掉 `subagent spawn` 创建的 Herdr pane。

## 工作原理

```
父 Pi（在 Herdr pane 里）
├── 扩展
│   ├── widget ......... herdr agent list，与本地 manifest 合并
│   ├── socket ......... events.subscribe → 状态变化即时推送
│   ├── /subagent ...... herdr agent focus
│   └── blocked 桥 ..... pi.events.emit("herdr:blocked", …)
└── subagent CLI ....... herdr tab create / agent start / …

子 Pi（在自己的 Herdr 标签页里）
└── 扩展
    ├── 控制桥 ......... 把 inbox/ 里的消息排空成用户消息
    └── 指标 ........... pane.report-metadata → 上下文字数、工具数、花费
```

**manifest 不是状态缓存。** 存活、状态、身份都归 Herdr 管。`~/.pi/agent/subagents/<handle>/metadata.json` 只存 Herdr 告诉不了我们的东西：子进程是怎么启动的、属于哪个父会话、以及这个 CLI 通过 `--session` 指定的会话记录路径。（Herdr 确实会为一个 pane 报告 `agent_session`，它自家的侧边栏工具用的就是这个值；但因为 CLI 自己钉死了会话文件，这里没有需要对账的东西。）

**消息走 inbox，不走终端。** `herdr agent prompt` 是往 pane 里打字，但 Pi 的 follow-up 语义需要 `alt+enter`，这种方式表达不出来。一个由原子写入的 JSON 文件组成的目录可以精确区分 `steer` 和 `followUp` 投递，也不依赖 pane 的终端状态。

**`wait` 是事件驱动的。** 它会为目标的 `pane.agent_status_changed`、`pane.exited`、`pane.closed` 建立订阅，所以长时间等待只花一个 socket，而不是每 400ms 派生一次 `herdr agent get` 进程。仍保留一个低频轮询兜底，因为重连可能丢掉正在等待的那一次状态变化。实测 13 秒的等待：2 次 herdr 调用，轮询版约 32 次。会话记录是子进程自己写的，所以"已完成"的状态可能比最终消息早到一点；这个很窄的窗口会被快速复查，而不是掉到慢速轮询里去。

**`spawn` 自己决定什么时候算就绪。** `herdr agent start` 只在 agent 变得可交互空闲时才返回，而刚启动的子进程几乎从不空闲——它的任务已经在队列里了。这让 spawn 耗时变成一场竞态：同一个 25 秒的任务，实测有 4 秒也有 32 秒的情况，而慢的 spawn 会让每一次并行派发串行化。现在启动调用有明确上限，就绪与否通过和其他所有命令一样的存活信号来确认。

`subagent wait` 读取子进程的会话记录，并沿着 `parentId` 从最新一条往回走，重建当前活跃分支。只读最后一行在压缩或分支之后会是错的。

### 关于 `blocked` 的说明

Herdr 的 Pi 集成会监听 Pi 事件总线上的 `herdr:blocked` 事件，但 Pi 本身和那个集成里都没有任何东西去发它——所以停在对话框上的 Pi pane 会一直报告成 `working`。而 Herdr 对 Pi 又跳过自己的屏幕检测（`full_lifecycle_hook_authority`），于是上报的状态就是唯一的信号。

`index.ts` 把 `ui_prompt_start` / `ui_prompt_end` 映射到这个通道上，补上了缺失的发射端。集成文件由 Herdr 管理、不能就地修改，所以发射端放在一个伴随扩展里。

## 开发

```sh
npm install
npm run check     # tsc --noEmit
```

就地修改然后在 Pi 里 `/reload`。子进程都是全新进程，下次 spawn 自然就用上新代码，不用 reload。

## 致谢

本项目是 [`badlogic/pi-subagent`](https://github.com/badlogic/pi-subagent)（作者 [badlogic](https://github.com/badlogic)，基于 tmux）的 Herdr 原生衍生作品。命令面、inbox 消息通道、双态扩展结构、活跃分支记录读取，以及 `skills/subagent/SKILL.md` 中的大量措辞都来自上游；Herdr 底座、可观测层、指标上报和 `blocked` 检测是这里新增的。

逐项拆解见 [NOTICE](NOTICE)。上游仓库没有发布任何许可证文件，因此未授予明确的再分发条款；本项目沿用与 [Pi](https://github.com/earendil-works/pi) 相同的 MIT 许可，并在此处和 `NOTICE` 中保留归因。

## 许可证

MIT，见 [LICENSE](LICENSE)。
