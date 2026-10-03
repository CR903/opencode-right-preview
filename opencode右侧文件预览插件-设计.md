# OpenCode「右侧文件预览」插件设计方案

> 目标：在 OpenCode TUI 中，把**主窗口（会话/聊天）里提到或给出的文件**自动收集到一个面板中，点击后**在右侧**直接浏览文件内容。
> 本文档 = 调研结论 + 他人经验总结 + 完整设计方案。

---

## 1. 调研结论

使用 `sn-search-code` 技能对 GitHub / Hacker News / Stack Overflow 进行了多轮检索，关键词包括：
`opencode plugin file preview`、`opencode file viewer`、`opencode sidebar`、`opencode 插件 文件`、
`opencode right panel preview`、`opencode 右侧 预览` 等。

### 结论：没有现成插件完全匹配需求

当前生态里**没有插件**能做到「主窗口提到的文件 → 点击 → 在右侧面板内浏览内容」。
最接近的现有插件如下：

| 插件 | 位置 | 预览方式 | 亮点 | 与本需求的差距 |
|---|---|---|---|---|
| [TM23-sanji/opencode-file-tree](https://github.com/TM23-sanji/opencode-file-tree)（7★） | 左侧 sidebar | 点击文件后**在侧边栏内联**显示行号内容 | 已实现「文件树+inline 预览」；v1 TUI API 的完整范例 | 面板在**左侧**，且是文件树驱动的预览，不收集聊天中提到的文件 |
| [amy220478/opencode-cairn](https://github.com/amy220478/opencode-cairn) | 左侧 sidebar | 点击文件用**系统默认应用**打开（`open`/`xdg-open`） | v2 TUI API 最佳范例：零构建、两文件、命令面板、状态持久化、fs.watch 实时刷新 | 不在终端内预览；不关联聊天内容 |
| [mike652638/opencode-preview-plus](https://github.com/mike652638/opencode-preview-plus)（fork 自 Edison-A-N/opencode-preview） | **浏览器**（http://localhost:17890） | 浏览器标签页内预览 Markdown/DrawIO/HTML/CSV/40+ 语言 | 功能最全：文件树、多标签、WebSocket 实时刷新、AI 可调用 `preview` 工具 | 是浏览器方案，不是 TUI 右侧面板 |
| [chenkumi/opencode-project-panel](https://github.com/chenkumi/opencode-project-panel) | **底部栏** | 文件管理器 + Markdown/代码预览 + 编辑 | 证明「底部条/侧边栏」插件形态可行；含权限面板 | 面板在底部，不收集聊天引用 |
| [streetturtle/opencode-better-sidebar](https://github.com/streetturtle/opencode-better-sidebar)（55★） | 左侧 sidebar | 一组小侧边栏插件（open-in / token 统计等） | 小而美的侧边栏插件范式 | 无文件预览 |

**结论**：需要自研，但可站在 `opencode-cairn`（v2 API、零构建）和 `opencode-file-tree`（inline 预览）的肩膀上。

---

## 2. 别人的经验总结（关键教训）

### 2.1 插件 API 有 v1 / v2 两代，务必选 v2
- **v1**（`@opencode-ai/plugin/tui`）：`api.slots.register({ slots: { sidebar_content() {...} } })`，如 `opencode-file-tree`。
- **v2**（`@opencode/plugin/tui`）：`Plugin.define({ id, setup(context) })`，如 `opencode-cairn`。提供 `context.ui.slot`、`context.storage.store`、`context.keymap.layer`、`context.state.session` 等高层 API。
- 本机 OpenCode 是 **v2.0.20** → 必须用 v2 API。

### 2.2 宿主槽位：没有官方「右侧栏」，但可以用 `app` 槽位 + 绝对定位实现
v2 的宿主槽位（`TuiHostSlotMap`）只有这些：

```ts
app / app_bottom
home_logo / home_prompt / home_prompt_right / home_bottom / home_footer
session_prompt / session_prompt_right
sidebar_title / sidebar_content / sidebar_footer
```

没有 `right_sidebar`。但 OpenTUI 的布局支持 `position: "absolute"` + `top/right/bottom/left` + `zIndex`
（见 `@opentui/core` 的 `LayoutOptions`），且 `app` 槽位渲染在整棵 UI 树最外层：

```tsx
// 宿主 app.tsx 的关键结构
<box width={dimensions().width} height={dimensions().height} flexDirection="column">
  <box flexGrow={1} minHeight={0} flexDirection="column"> {/* Home / Session 路由 */} </box>
  <box flexShrink={0}><pluginRuntime.Slot name="app_bottom" /></box>
  <pluginRuntime.Slot name="app" />   {/* 在这里可以放绝对定位的右侧浮层 */}
</box>
```

✅ **方案可行**：在 `app` 槽位返回一个 `position="absolute"`、`right={0} top={0} bottom={0} width={60}` 的盒子，
即可实现真正的「右侧面板」浮层（需给足 `zIndex`，并在窄终端避免遮挡输入框）。

### 2.3 收集「聊天中提到的文件」不需要 server 插件
v2 TUI 插件可直接读取当前会话数据：
- `context.state.session.messages(sessionID)` 拿消息列表；
- `context.state.part(messageID)` 拿消息的 parts，其中 **`type === "file"` 的 `FilePart` 自带文件路径**；
- `context.state.session.diff(sessionID)` 返回 AI 改动的文件（`{ file, additions, deletions }`）；
- `context.event.on("message.updated" / "message.part.updated", ...)` 监听新消息 → 触发列表刷新。

这样**单个 TUI 插件文件即可完成**「收集引用 → 展示 → 点击预览」，无需 server 端逻辑。

### 2.4 数据流与状态管理
- 用 SolidJS `createSignal` 管理 UI 状态（文件列表、展开目录、当前打开文件）；
- 用 `context.storage.store("preview.params", { initial })` 做**持久化**（跨重启记住面板开关、宽度、打开的最近文件）；
- 大目录/大文件不要一次性渲染：文件树按需 `readdir` + 缓存（`opencode-file-tree` 的做法）；文件预览**截断前 N 行**。

### 2.5 鼠标与键盘都要支持
- 终端需开启 `mouse: true`（TUI 默认开启）；点击用 `onMouseDown`（`opencode-cairn` 强调这是 best-effort）；
- **必须提供键盘/命令面板路径**：`/preview`、`ctrl+x` 快捷键、命令面板（`context.keymap.layer`）——SSH 下没有鼠标也能用。

### 2.6 主题与语法高亮
- `context.theme.current` 提供完整配色，包括 `syntaxComment / syntaxKeyword / syntaxString / syntaxNumber / syntaxFunction / syntaxType / syntaxOperator / syntaxPunctuation` 等语法色；
- 可用极简正则分词（注释/字符串/关键字/数字）做**轻量高亮**，避免引入重型高亮库；后续可接入 `highlight.js`。

### 2.7 安全与性能
- **路径安全**：只允许打开项目目录（`worktree` / `directory`）内的文件，阻止 `../` 路径穿越（`opencode-preview-plus` 的教训）；
- **忽略目录**：`node_modules / .git / dist / build / .venv / __pycache__` 等；
- **二进制**：按扩展名跳过 `.png .jpg .pdf .db .so` 等，避免乱码（`opencode-file-tree` 的 IGNORE_EXTS）。

---

## 3. 插件设计：`opencode-right-preview`

### 3.1 目标
在 OpenCode TUI 右侧显示一个可开关的预览面板：
1. 自动列出当前会话中「提到/给出的文件」（`@` 引用、AI 读取/编辑过的文件）；
2. 点击文件名 → 右侧面板内直接浏览文件内容（行号 + 轻量语法高亮 + 滚动）；
3. 支持 `/preview` 命令与快捷键切换面板、直接打开指定路径。

### 3.2 功能清单（MVP）
- **引用文件列表**：从当前会话消息 parts（`FilePart`）自动提取；
- **改动文件列表**：从 `session.diff` 提取（AI 刚改过的文件，标绿/标红增删行数）；
- **右侧预览**：绝对定位面板，显示文件内容（行号、截断大文件、深浅色跟随主题）；
- **点击打开 / 关闭**：点文件加载内容，点 `×` 或再点关闭；
- **命令**：`/preview` 开关面板、`/preview <path>` 打开指定文件；
- **快捷键**：`ctrl+x p` 切换面板（通过 `context.keymap.layer`）；
- **持久化**：面板开关、宽度、当前文件、最近文件列表（`context.storage.store`）。

### 3.3 技术选型
| 项 | 选择 |
|---|---|
| 运行环境 | OpenCode v2.x（本机 v2.0.20），Bun |
| 插件 API | `@opencode/plugin` + `@opencode/plugin/tui`（v2） |
| UI 框架 | `@opentui/solid`（宿主自带）+ `solid-js` |
| 构建 | **零构建**（两三个源文件直接加载，同 `opencode-cairn`） |
| 高亮 | 第一阶段极简正则；预留 `highlight.js` 接入点 |
| 语言 | TypeScript（`.ts` / `.tsx`） |

### 3.4 架构与数据流

```
OpenCode TUI 宿主（v2，session.panel 官方插件面板槽位）
        │
        ├─ context.data.on("session.tool.called")      ──┐
        ├─ context.data.on("session.tool.success")       ──┤ 实时
        ├─ context.data.on("session.idle")               ──┤
        └─ context.data.on("filesystem.changed")          ──┤
           context.data.session.message.list(sessionID)    ▼
                                              ┌─────────────────────┐
                                              │  collectFiles()     │
                                              │  → user files.uri  │
                                              │  → tool input/content│
                                              │  → filesystem.changed│
                                              └─────────┬───────────┘
                                                       ▼  (SolidJS signals)
                                    ┌────────────────────────────────────┐
                                    │  RightPreviewPanel              │
                                    │  (context.ui.slot session.panel)│
                                    │  ├─ 会话引用/生成文件列表       │
                                    │  └─ 文件内容视图（行号+高亮）    │
                                    └────────────────────────────────────┘
```

- 面板**不在 `app` 槽位做绝对定位**，而是使用 v2.0.8+ 官方 `session.panel` 插件面板槽位
  （`context.ui.slot({ append: "session.panel" })` + `context.ui.panel.open("right-preview")`），
  由宿主负责布局、宽度、全屏与焦点——天然不会重叠输入框；
- 消息事件到达 → 收集文件 → 更新列表 signal；
- 点击文件 → `readFile`（路径安全校验）→ 存入 `openFile` signal → 内容视图渲染；
- 最近文件/上次打开文件 → `context.storage.store` 持久化；
- 命令与快捷键在 `append: "app"` 槽位的 `render` 中注册 `context.keymap.layer`（keymap provider 仅在渲染时可用）。

### 3.5 文件结构

```
~/.config/opencode/plugins/opencode-right-preview/
├── package.json          # 声明 @opencode/plugin/tui 等 peer 依赖
├── index.ts              # server 插件入口（空壳，保证插件被注册）
├── tui.tsx               # TUI 插件：右侧面板 + 命令 + 快捷键（核心，全部逻辑）
└── README.md             # 使用说明
```

> 参考 `opencode-cairn`：server 入口只做 `Plugin.define({ id, setup() {} })`，
> 真正逻辑 100% 在 `tui.tsx`。这样**无需构建步骤**，复制目录、重启即生效。

### 3.6 核心实现（代码骨架）

#### `package.json`
```jsonc
{
  "name": "opencode-right-preview",
  "version": "0.1.0",
  "type": "module",
  "peerDependencies": {
    "@opencode/plugin": ">=2.0.0",
    "@opencode/plugin/tui": ">=2.0.0",
    "@opentui/solid": ">=0.5.0",
    "solid-js": "*"
  }
}
```

#### `index.ts`（server 空壳）
```ts
import { Plugin } from "@opencode/plugin"

export default Plugin.define({
  id: "right-preview.server",
  setup() {}, // 本插件不需要 server 能力；保留入口以被正确注册
})
```

#### `tui.tsx`（核心）

> 完整实现见仓库 `opencode-right-preview/tui.tsx`（已实现并验证通过）。以下为核心骨架：

```tsx
import { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, Show } from "solid-js"
import { readFile } from "node:fs/promises"
import { relative, resolve, sep } from "node:path"

const PANEL_NAME = "right-preview"
const MAX_LINES = 1000

export default Plugin.define({
  id: "right-preview.tui",
  setup(context) {
    const [settings, updateSettings] = context.storage.store("right-preview.params", {
      initial: { openPath: "", recent: [] as string[] },
    })
    const [filesBySession, setFilesBySession] = createSignal<Record<string, FileEntry[]>>({})
    const [changedFiles, setChangedFiles] = createSignal<Set<string>>(new Set())
    const [openFile, setOpenFile] = createSignal<OpenFile | null>(null)

    // 收集：用户 @ 引用（files[].uri）+ 工具调用 input.filePath + filesystem.changed
    async function collectFiles(sessionID: string) {
      const base = context.data.session.root(sessionID)
      const entries: FileEntry[] = []
      await context.data.session.message.sync(sessionID)
      for (const msg of context.data.session.message.list(sessionID) ?? []) {
        if (msg.type === "user" && msg.files) {
          for (const f of msg.files) if (f.source?.type === "uri")
            entries.push({ path: resolve(base, uriToPath(f.source.uri) ?? ""), kind: "ref" })
        }
        if (msg.type === "assistant" && msg.content) {
          for (const part of msg.content) if (part.type === "tool" && part.state?.status === "completed") {
            const p = extractPathFromJson((part.state as any).input)
            if (p) entries.push({ path: resolve(base, p), kind: "tool" })
          }
        }
      }
      if (entries.length) setFilesBySession(prev => ({ ...prev, [sessionID]: dedupe([...(prev[sessionID] ?? []), ...entries]) }))
    }

    // 事件订阅（工具调用/成功、会话空闲、文件变更）
    context.data.on("session.tool.called", (e) => collectFromToolInput(e.data.sessionID, e.data.input))
    context.data.on("session.idle", (e) => void collectFiles(e.data.sessionID))

    // 右侧面板：官方 session.panel 槽位
    context.ui.slot({
      append: "session.panel",
      render: (panel) => (
        <Show when={panel.name === PANEL_NAME}>
          <box flexDirection="column" width="100%" height="100%">
            <box flexDirection="row" justifyContent="space-between">
              <text fg={context.theme.text.base}><strong>📄 文件预览</strong></text>
              <box flexDirection="row" gap={1}>
                <text fg={context.theme.text.muted} onMouseDown={() => panel.toggleFullscreen()}>⛶</text>
                <text fg={context.theme.text.muted} onMouseDown={() => context.ui.panel.close()}>×</text>
              </box>
            </box>
            <box flexDirection="column" flexGrow={1} overflow="scroll">
              <For each={filesBySession()[panel.sessionID] ?? []}>
                {(f) => (
                  <box onMouseDown={() => void openPath(f.path)}>
                    <text fg={context.theme.text.muted}>{context.ui.format.path(f.path)}</text>
                  </box>
                )}
              </For>
            </box>
            {/* 内容区：行号 + 轻量高亮，略 */}
          </box>
        </Show>
      ),
    })

    // 命令与快捷键：必须在 app 槽位 render 中注册 keymap layer
    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global", priority: 10,
          commands: [{
            id: "right-preview.toggle",
            title: "Toggle right file preview panel",
            group: "Right Preview",
            bind: "<leader>p",          // ← leader 键格式（ctrl+x 然后 p）
            palette: true, suggested: true,
            slash: { name: "preview", arguments: true },
            run: async (input) => {
              if (context.ui.panel.current()?.name === PANEL_NAME) return context.ui.panel.close()
              if (context.ui.panel.open(PANEL_NAME) && input?.trim() && !input.trim().startsWith("/")) {
                await openPath(input.trim())
              }
            },
          }],
          bindings: ["right-preview.toggle"],
        }))
        return null
      },
    })
  },
})
```

> 关键经验（实现中踩到的坑）：
> 1. `context.keymap.layer()` **不能在 `setup` 中直接调用**，会报 `Keymap.Provider is missing`；必须放在 `append: "app"` 槽位的 `render` 里（官方 session panels 文档范式）。
> 2. leader 组合键要用 **`<leader>p`**，而不是 `ctrl+x p`（后者不会触发）。
> 3. v2.0.8 消息模型没有 `FilePart`，用户引用在 `msg.files[].source.uri`（`file://` URI），AI 工具路径在 `tool.state.input` 中。
> 4. `session.panel` 在窄终端会自动全屏（宿主行为）；宽终端下才是右侧分栏。

### 3.7 配置（可选）
`tui.json` 无需额外配置（面板通过 `ctrl+x p` / `/preview` 打开）。若想自定义快捷键，可在 `tui.json` 覆盖：
```jsonc
{
  "$schema": "https://opencode.ai/tui.json",
  "plugin": ["./plugins/opencode-right-preview"],
  "keybinds": { "right-preview.toggle": "<leader>p" }
}
```

### 3.8 安装与验证
```bash
# 安装（macOS/Linux）
mkdir -p ~/.config/opencode/plugins/opencode-right-preview
cp -r index.ts tui.tsx package.json ~/.config/opencode/plugins/opencode-right-preview/

# 重启 opencode 后验证插件已加载
opencode --print-logs plugin list   # 应看到 right-preview.tui / right-preview.server
```

### 3.9 风险与规避

| 风险 | 规避方案 |
|---|---|
| `session.panel` 在窄终端强制全屏、宽终端下隐藏左侧栏 | 宿主行为（issue #48519），非致命；提供 `f` 全屏切换与 `×` 关闭，后续可增加「仅吸附输出区」的自定义布局 |
| 鼠标点击在某些终端不可靠 | 保留 `/preview`、`ctrl+x p`、命令面板路径（键盘优先） |
| 大文件渲染卡顿 | 截断 `MAX_LINES`（1000 行）；后续改为分页预览（借鉴 `dsh-workspace-explorer`） |
| 路径穿越读取任意文件 | `openPath` 强制解析到项目根内，越界直接拒绝并 toast |
| v1 与 v2 API 混淆 | 明确目标 v2.0.x；若用户停留在 v1，需要 `api.slots.register({ sidebar_content })` 的版本（保留一份 v1 分支代码） |
| 二进制/大目录拖慢 | 忽略目录 + 扩展名黑名单（同 `opencode-file-tree`） |
| 面板与内置 diff-viewer 冲突 | 命名空间独立（`right-preview.*`），不覆盖内置命令 |

### 3.10 开发 Roadmap

- **M0（MVP）**：右侧面板 + 引用文件列表 + 点击预览（行号/高亮）+ `/preview` 命令。≈ 1 天。
- **M1**：`session.diff` 改动文件列表 + 增删行数徽标 + 实时刷新（事件订阅）。
- **M2**：文件树（可折叠目录）+ 面包屑 + 最近文件历史。
- **M3**：Markdown 渲染（GFM）、CSV/表格预览、图片（终端图片协议如 Kitty Graphics）。
- **M4**：多标签页、宽度拖拽调整、跨会话持久化完整化、发布 npm（`opencode plugin install`）。

---

## 附：为什么不用「浏览器预览」方案？
`opencode-preview-plus` 的思路是起本地 HTTP 服务 + 浏览器打开。它的体验更接近 IDE（Markdown 渲染、实时刷新、多标签），
但**不是终端内嵌**，需要切窗口。本插件定位是**纯 TUI 内的轻量快速预览**，两者可共存互补；
后续若想要浏览器增强，可复用其 `preview` 工具思路，在右侧面板加一个「在浏览器打开」按钮。

---

# 4. DSH（DeepSeek Harness）生态调研与可行性分析

## 4.1 调研概况

DSH（DeepSeek Harness，`deepseek-ai/deepseek-harness`，GitHub 24 万+ star）是「Everything is a Plugin」架构的 AI 编码 Agent。
其插件为 **Cordis bundle**，典型结构是 **host 半部（Node 服务）+ client 半部（浏览器 React UI）**，通过 `cordis.patch.yml`
装配到 `~/.dsh/profiles/web`。插件生态非常庞大（`awesome-dsh-plugin` 精选列表 1.7 万+ star，插件市场收录 1.1 万+ 插件），
其中**文件预览 / 文件引用 / 右侧面板**类插件数量众多、成熟度高，是我们最重要的参考系。

用 `sn-search-code` 检索 `dsh plugin file preview` / `dsh markdown preview` / `dsh file reference` / `DeepSeek Harness plugin` 等关键词，
筛选出 **7 个最值得借鉴**的项目如下。

## 4.2 最值得借鉴的 DSH 插件

| 插件 | Star | 形态 | 与我们的需求贴合度 |
|---|---|---|---|
| `poiuyjie/dsh-md-preview` | 2 | **对话里点 `.md` 引用 → 右侧并排预览** | ★★★★★ 几乎同构 |
| `jiashangqi/dsh-file-viewer` | 0 | **对话中出现的文件路径可点击 → 右侧侧边栏打开** | ★★★★★ 核心需求最接近 |
| `yu2025-luo/dsh-file-panel` | 3 | **右侧面板，agent 创建/下载文件时自动弹出** | ★★★★☆ 右侧+事件驱动 |
| `Jiyr0119/dsh-workspace-explorer` | 32 | **右侧目录树面板，点击/拖拽文件引用进输入框** | ★★★★☆ 右侧+输入框不遮挡 |
| `nirvanaslash/dsh-artifact-preview` | 1 | **聊天产物卡片 + 分屏右侧预览（多类型渲染）** | ★★★★☆ 多格式预览天花板 |
| `joejojoking-cloud/dsh-file-explorer` | 21 | **右侧文件树+多标签预览+编辑** | ★★★☆☆ 多标签/编辑 |
| `No-PRM/dsh-explorer` | 7 | **右侧文件树+Git 状态+CodeMirror 预览+拖拽引用** | ★★★☆☆ Git 徽标/虚拟滚动 |

### 4.2.1 `dsh-md-preview` —— 与我们的需求几乎同构

> 在会话头部加「MD 预览」入口，自动跟踪本会话读写/打开过的 `.md` 文件，
> **点击对话中的 md 引用时在右侧栏并排打开预览**，而不是跳转系统编辑器。

可借鉴的设计：
- **右侧并排停靠**：与对话并排、顶部对齐，**左缘分隔线可拖动调宽**；布局自动让位、不遮挡对话。
- **会话隔离的最近列表**：按会话收集「读/写/改/删 + 时间 + 文件 mtime」，会话间互不串扰。
- **两种打开方式**：浮动窗口（可拖动缩放，位置记忆）+ 右侧停靠。
- **修饰键逃生**：按住 Ctrl/Cmd/Shift 点击引用 → 仍走系统默认编辑器。
- **架构**：`index.js`（host）监听 `fs/observed` 记录文件访问，提供 `/md-preview/api/{recent,read,peek}` 三个 HTTP 端点；
  `client.js`（浏览器）负责面板 UI、**document 捕获阶段拦截 md 引用按钮点击**、右侧停靠与布局让位。

### 4.2.2 `dsh-file-viewer` —— 核心需求最接近

> 对话中出现的文件路径（tool outputs / messages）变成**可点击**，hover 显示 reveal 按钮，
> 点击在**右侧侧边栏**打开；自带代码高亮 + Markdown 预览/源码切换；**只读设计**。

可借鉴的设计：
- **Click-to-open file references**：把消息/tool 输出里出现的路径收集起来，点击即打开。
- **零依赖**：host 只用 `node:fs/os/path/child_process`；client 无构建步骤。
- **host 路由**：`/fileviewer/*` + `/api/file-mentions/*`。

### 4.2.3 `dsh-file-panel` —— 事件驱动自动弹出

> 监听 agent 创建/下载的文件，在**右侧弹出自适应面板**（Codex 风格），自动弹出 + NEW 徽标。

可借鉴的设计：
- **事件驱动自动弹出**：`fs/observed`（write/edit 工具上报）+ 递归 `fs.watch`（捕获 shell 下载）→ 右侧面板自动弹出。
- **行操作**：预览（图片内联 / 文本前 256KB）、在文件夹中显示、系统应用打开、复制绝对路径。
- **安全模型（很重要）**：RPC 只注册 `authority: 'loopback'`；**只接受 tracker 实际见过的绝对路径**——
  防止把预览 RPC 变成通用文件读取原语。
- **忽略规则**：`node_modules` / `.git` / 临时文件。
- **持久化**：localStorage 记住 open/collapsed + auto-pop 偏好。
- **轮询**：client 每 1.5s 轮询一次 RPC 拉新文件。

### 4.2.4 `dsh-workspace-explorer` —— 右侧面板 + 不遮挡输入框

> 「Workspace Files」胶囊按钮 → 右侧弹出目录树；点击/拖拽文件引用进输入框；预览分页。

可借鉴的设计：
- **面板定位策略（直接解决我们的遮挡风险）**：popup 实时测量并定位在 **session header 与 composer 之间**，永不盖住输入框。
- **懒加载树 + 噪声目录隐藏**（`node_modules` / `.git` / `dist` / `__pycache__`）。
- **分页预览**：大文件 prev/next 翻页（总行数 + 当前页），**不一次性渲染整个文件**。
- **预览与树分离**：split view，340px 预览面板 + 右侧树。
- **编辑**：textarea 模式 + **外部修改检测**（保存时警告文件已被外部修改）。
- 实现机制：host `fs.listDir` ↔ client RPC `ws-tree.list/peek`；`shell.overlay` 槽位定位；`conversation.input.dock` 写输入框。

### 4.2.5 `dsh-artifact-preview` —— 多类型渲染天花板

> AI 写完文件后，聊天尾部显示「产物」卡片行 + 缩略图；点击打开分屏右侧预览面板。

可借鉴的设计：
- **多类型渲染**：Markdown 富文本 / 代码深色高亮 / CSV 表格 / JSON 折叠树 / 图片 checkerboard / HTML+本地端口 iframe。
- **全局钩子**：`window.__dshOpenFilePreview` / `__dshCanPreviewPath`，供其他插件把「打开文件」意图路由进预览面板。
- **已知边界（对我们有重要启示）**：作者明确表示 **消息 prose 中文件名的点击拦截需要 patch DSH 核心**，故意不打包——
  说明「点击消息文本里的文件名」在宿主不改核心的情况下很难做。**我们的 OpenCode 方案应聚焦 `FilePart`，不做消息文本拦截**。

### 4.2.6 `dsh-file-explorer` / `No-PRM/dsh-explorer` —— UX 细节

- 浏览器式**多标签预览**（按打开顺序、后台切换不重载、×关闭）、**1MB 上限**提示不支持预览。
- **Git 状态徽标**（M/A/U/D/R 列 + 脏点 + 删除线）+ git diff 并排视图。
- **虚拟滚动**（大目录保持响应）；CodeMirror 内 Ctrl+F 查找。
- 开发教训：`[data-phase=active]` 让位 padding 要**即时生效**（不加 transition），否则流式期间聊天列宽动画会导致消息上跳/空白。

## 4.3 DSH 与 OpenCode v2 插件架构对比

| 维度 | DSH 插件 | OpenCode v2 插件（我们的目标） |
|---|---|---|
| 运行模型 | Cordis bundle：host（Node）+ client（浏览器 React/DOM/CSS） | server 插件 + **TUI 插件**（OpenTUI/SolidJS 字符画布），Bun 运行 |
| UI 载体 | Web GUI（HTML/CSS/DOM） | 终端 TUI（字符、颜色、边框） |
| 插槽机制 | `shell.overlay` / `conversation.session.header.utilities` / `conversation.chat.turnTail` 等 | `app` / `app_bottom` / `sidebar_content` / `session_prompt_right` 等 |
| 文件访问 | host 半部 Node `fs` + HTTP/RPC 桥 | TUI 插件**同进程直接 `node:fs`**（更简单） |
| 事件源 | `fs/observed`、`message` 等 | `file.edited`、`message.updated`、`message.part.updated`、`session.diff` |
| 引用检测 | DOM 级点击拦截 + `fs/observed` | **`FilePart` 结构化路径**（更可靠，无需 DOM 拦截） |
| 持久化 | localStorage / host 状态 | `context.storage.store`（跨重启） |
| 鼠标交互 | 完整 DOM（click / hover / drag&drop / iframe） | `onMouseDown`（依赖终端鼠标报告，best-effort） |
| 富文本能力 | 高（Markdown/CSV/JSON/图片/iframe/编辑器） | 低（OpenTUI 的 Markdown/Code 组件或极简文本渲染） |

## 4.4 可行性分析结论

### 核心需求：✅ 可行，且已被 DSH 生态验证
「右侧面板 + 收集会话中提到的文件 + 点击预览」在 DSH 已被多个插件反复验证（`dsh-md-preview`、`dsh-file-viewer`、
`dsh-file-panel` 都是右侧面板）。OpenCode v2 具备实现同样功能的**全部原语**：

- 右侧面板：`app` 槽位 + `position="absolute" right/top/bottom` + `zIndex`（已核实 OpenTUI `LayoutOptions` 支持）；
- 引用检测：`context.state.part()` 的 `FilePart` 直接给出结构化路径（比 DSH 的 DOM 拦截更可靠）；
- 内容读取：`node:fs` 同进程直读（比 DSH 的 HTTP/RPC 桥更简单）；
- 实时刷新：`context.event.on("message.updated")`；
- 持久化：`context.storage.store`。

### 需要降级 / 不可行的点

| DSH 能力 | 在 OpenCode TUI 中的可行性 | 降级方案 |
|---|---|---|
| 点击**消息文本里的**文件路径 | ❌ 需改宿主核心（DSH 作者也证实要 patch 核心） | 把引用收集到右侧面板**列表项**，点击列表项打开（我们的方案） |
| Markdown/CSV/JSON/图片/iframe 富渲染 | ⚠️ 部分可行 | Markdown 可用 OpenTUI Markdown/Code 组件或极简文本渲染；CSV/JSON 做文本/表格化；图片需终端图片协议（Kitty Graphics）或跳过 |
| 拖拽文件到输入框 | ❌ TUI 无拖拽语义 | 提供 `/preview <path>` 命令 + 面板列表点击 |
| 鼠标 hover 显示按钮 | ⚠️ 有限 | 用行内固定图标（👁/📂）替代 hover 操作 |
| 分页/虚拟滚动 | ✅ 可行 | `For` + 截断 + prev/next 页（参考 `dsh-workspace-explorer`） |
| Git 状态徽标 | ✅ 可行 | `session.diff` 已给出 `{file, additions, deletions}`，可渲染 M/A 徽标 |

### 应吸收的最佳实践（按优先级）

1. **面板定位在 header 与 composer 之间 / 或 bottom 留白**，永不遮挡输入框（来自 `dsh-workspace-explorer`、`dsh-md-preview`）——修正原设计风险。
2. **事件驱动自动弹出 + NEW 徽标**：OpenCode 用 `file.edited` / `session.diff` 触发，等价于 DSH 的 `fs/observed`（来自 `dsh-file-panel`）。
3. **路径白名单安全模型**：只允许打开「本会话实际出现过的路径 + 项目根内路径」，防止预览面板被当作任意文件读取原语（来自 `dsh-file-panel`）。
4. **会话隔离的最近文件列表**：每个会话只看自己访问过的文件，记录访问时间与 mtime（来自 `dsh-md-preview`）。
5. **大文件分页预览**，不一次性渲染（来自 `dsh-workspace-explorer`）。
6. **修饰键逃生**：Ctrl/Cmd 点击 → 用系统默认应用打开（TUI 中可映射为 `ctrl+x` 命令或 `/preview open` 子命令）（来自 `dsh-md-preview`）。
7. **1MB 预览上限 + 多标签**（来自 `dsh-file-explorer`）。
8. **Git 状态徽标 + 虚拟滚动**（来自 `No-PRM/dsh-explorer`）。
9. **开发纪律**：不手改构建产物；面板让位即时生效、避免动画重排（来自 `dsh-file-explorer` 的教训）。

### 最终结论
**「OpenCode 右侧文件预览」插件可行性高**。DSH 生态证明了产品形态成立，且我们需要的每一项技术原语 OpenCode v2
都已具备；代价仅是**交互从 DOM 级降级为 TUI 级**（点击消息文本、拖拽、富文本渲染受限）。
建议按以下合并后的路线实现：

- **M0（MVP）**：右侧面板（`app` 槽位 + 绝对定位，`bottom` 留白不遮输入框）+ `FilePart` 引用列表 + 点击预览（行号/轻量高亮）+ `/preview` 命令 + `ctrl+x p` 快捷键 + `context.storage.store` 持久化。
- **M1**：`session.diff` 改动文件列表（NEW 徽标 + 增删行数）+ `file.edited` 事件驱动自动弹出 + 路径白名单 + 会话隔离最近列表。
- **M2**：懒加载文件树 + 分页预览 + 1MB 上限 + 多标签。
- **M3**：Markdown 渲染 + CSV/JSON 表格化 + Git 状态徽标。
- **M4**：发布 npm（`opencode plugin install`），补充「在系统应用打开」修饰键逃生。
---

# 5. 实现状态（M0+M1 已完成并验证）

## 5.1 已实现

| 模块 | 状态 | 说明 |
|---|---|---|
| 右侧面板 | ✅ | `context.ui.slot({ append: "session.panel" })` + `ui.panel.open("right-preview")`，宿主管理布局/全屏/焦点 |
| 会话文件收集 | ✅ | 用户 `@` 引用（`files[].source.uri`）、AI 工具调用（`tool.state.input` 递归提取 `filePath`）、`filesystem.changed` 事件 |
| 文件内容预览 | ✅ | 行号 + 注释/字符串/关键字/数字轻量高亮；`MAX_LINES=1000` 截断提示 |
| 命令与快捷键 | ✅ | `/preview [path]` 斜杠命令、命令面板、`ctrl+x p`（`bind: "<leader>p"`） |
| NEW 徽标 | ✅ | `filesystem.changed` 触发，标记会话中刚变更的文件 |
| 持久化 | ✅ | `context.storage.store` 记住最近文件与上次打开文件，重启自动恢复 |
| 路径安全 | ✅ | 只允许项目根内路径，越界拒绝并 toast |

## 5.2 已验证

- `bun build` 语法/JSX 构建通过（`@opentui/solid` 作为 JSX runtime）。
- `opencode --print-logs plugin list` 正确列出 `right-preview.server`。
- TUI 启动加载无 `Keymap.Provider is missing` / 其他错误。
- 在会话中按 `ctrl+x p` 成功打开右侧面板，正确渲染「📄 文件预览」标题、文件列表、内容提示。
- 让 AI `read` 设计文档后，面板中正确显示会话引用文件 `~/project/others/opencode右侧文件预览插件-设计.md`。

## 5.3 源码与安装位置

- 源码：`/Users/zhouri/project/others/opencode-right-preview/`
  - `package.json`、`index.ts`（server 空壳）、`tui.tsx`（全部逻辑）、`README.md`
- 已安装：`~/.config/opencode/plugins/opencode-right-preview/`
- 卸载：`rm -rf ~/.config/opencode/plugins/opencode-right-preview`

## 5.4 后续 M2-M4（待办）

- **M2**：懒加载文件树（借鉴 `dsh-workspace-explorer`）+ 分页预览 + 1MB 上限 + 多标签。
- **M3**：Markdown/CSV 渲染 + Git 状态徽标（`filesystem.changed` 已有事件基础）。
- **M4**：发布 npm（`opencode plugin install`）、宽终端布局优化（跟进 issue #48519 的 sidebar 共存方案）、「在系统应用打开」修饰键逃生。

---

# 6. 方案重构（v2）：借鉴 dsh-better-sidebar

## 6.1 参考对象分析

参考 [omdsh-dev/DSH-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（3.9k star）——
DSH 生态的服务化侧边栏框架，核心是「右侧栏 + 底部工作台」双工作台，并把
`ctx.betterSidebar` 服务开放给所有插件（`registerTab` / `registerFileViewer`）。

### 它的信息架构（值得借鉴的核心）

| 视图 | 内容 | 对我们的价值 |
|---|---|---|
| 文件 | 懒加载目录树 + Git 着色 + 搜索 + 多选 | ⭐⭐⭐ 核心 |
| 文件变动 | Git 视角 + **本轮 AI 改动视角**双合一，统一 diff 渲染 | ⭐⭐⭐ 我们的差异化 |
| 任务 | 子代理拓扑 + 后台任务 | 超出范围 |
| 侧边对话 | 独立线程继承主会话上下文 | 超出范围 |

### 关键设计决策（我们采纳的）

1. **用「视图维度」组织信息，而非平铺列表** —— 原方案只有「文件列表 + 内容」二分结构，信息密度低。
2. **宿主渲染器优先** —— 宿主已内置 `<markdown>` / `<diff>` / `<scrollbox>` / `<tab_select>`，
   不必手写渲染。
3. **变更即一等公民** —— 「AI 改了什么」比「项目有哪些文件」更贴合用户意图。

## 6.2 宿主能力核实（决定了可行性边界）

### ✅ 可用：OpenTUI 内置渲染器

JSX 标签名为小写下划线风格，实测可用组件：

| 标签 | 类型 | props 要点 |
|---|---|---|
| `<markdown>` | MarkdownRenderable | `content` `syntaxStyle` `conceal` `treeSitterClient` |
| `<diff>` | DiffRenderable | `diff` `view="unified\|split"` `showLineNumbers` `conceal` `wrapMode` `syncScroll` |
| `<scrollbox>` | ScrollBoxRenderable | `scrollY` `scrollX` `stickyScroll` `viewportCulling`（视口裁剪=虚拟滚动） |
| `<tab_select>` | TabSelectRenderable | Tab 切换 |
| `<select>` | SelectRenderable | 键盘导航列表 |
| `<code>` | CodeRenderable | 代码高亮 |
| `<textarea>` | TextareaRenderable | 简易编辑（`onContentChange` / `onSubmit`） |

**结论**：手写的 100 行正则 tokenizer 可以删除，换用宿主渲染器，渲染质量与性能都更好。

### ✅ 可用：OpenCode 数据源

- `context.client.session.diff({...})` —— 会话 diff
- `context.client.vcs.diff(...)` —— Git 工作区 diff
- `context.data.session.diff(sessionID)` —— `{ file, additions, deletions }[]`
- `filesystem.changed` 事件 —— 实时文件变更

### ❌ 不可行（TUI 形态限制）

| DSH 能力 | 原因 | 处置 |
|---|---|---|
| 点击聊天文本里的文件路径 | 需 DOM 捕获阶段拦截，TUI 无 DOM | 改用 `sidebar.content` 区块承载清单 |
| CodeMirror 可编辑编辑器 | 浏览器专属 | 降级为 `<textarea>` 简易编辑（可选） |
| hover / 右键菜单 / 拖拽 / 多选 | 终端输入能力 | 改为单击 + 快捷键 |
| 图片 / PDF / Office 预览 | 无浏览器渲染引擎 | 交给外部程序（`$EDITOR`） |
| Mermaid 图表渲染 | 无 SVG 引擎 | 放弃 |
| 底部拖拽分栏 | 无拖拽语义 | 放弃 |

## 6.3 新架构：双区联动

用户决策：聊天涉及的文件清单放在**宿主已有侧栏**（MCP 区块下方），点击后唤起**右侧面板**查看内容。

```
┌──────────────┬──────────────────────────────────┐
│              │  文件  变动           [还原][×] │ ← 右侧面板（session.panel）
│  MCP         ├──────────────────────────────────┤
│  ─────────   │  🔍 过滤                   ⓖ    │ ← 自建 Tab 切换
│  LSP         ├──────────────────────────────────┤
│  TODO        │  ▾ src/                          │
│  ─────────   │    ▾ components/                 │ ← 文件树视图
│  📎 会话文件  │      ● Sidebar.tsx          M    │   （懒加载 + Git 着色）
│    ◈ a.tsx 5 │      ● index.ts               A  │
│    ▤ b.md  2 │  ▸ 128 个文件                    │
│  ─────────   ├══════════════════════════════════┤ ← 分割线
│  Files       │  index.ts  12.4K  184 行     ⓧ │ ← 内容区（宿主渲染器）
│              │  ──────────────────────────────── │
│              │   1  import { Plugin } ...       │
└──────────────┴──────────────────────────────────┘
   ↑ sidebar.content                              ↑ session.panel
   （宿主已有侧栏，MCP 下方）                        （点击文件后唤起）
```

### 侧栏区块（`sidebar.content` append）

- 标题：`📎 会话文件 (N)`，带折叠箭头
- 每行：类型图标 + 文件名 + 目录 + 操作次数角标 + `NEW` 徽标
- 点击 → `ui.panel.open("right-preview")` 并加载该文件
- 空态：提示用 `@` 引用或让 AI 读取文件

### 右侧面板（`session.panel`）

**Tab 1 · 文件** —— 懒加载目录树
- 按需 `readdir`，噪声目录自动隐藏（`node_modules` / `.git` / `dist` …）
- Git 状态着色 + `M/A/D/U/R` 状态字母
- 软链接识别
- 文件名过滤（`/` 触发）

**Tab 2 · 变动** —— 变更追踪
- 二级过滤：`本轮` / `全部`
- `本轮`：本会话 AI 读写的文件（复用已有事件采集）
- `全部`：Git 工作区变更（`vcs.diff`）
- 每行：状态色点 + 路径 + `+增 -删` 计数
- 点击 → 内容区切到 `<diff>` 渲染

**内容区**（按文件类型分发）
| 类型 | 渲染器 |
|---|---|
| `.md` / `.mdx` | `<markdown content={...} />` |
| 有 diff 上下文 | `<diff diff={...} view="unified" showLineNumbers />` |
| 其他代码 | `<scrollbox>` + `<code content={...} />` |
| JSON / CSV | `<code>` + 等宽对齐 |

## 6.4 与 v1 的差异对照

| 项 | v1（已废弃） | v2 |
|---|---|---|
| 文件清单位置 | 右侧面板上半区 | **宿主侧栏**（MCP 下方） |
| 组织方式 | 平铺列表 + 目录后缀 | **目录树 + Git 着色** |
| 视图数 | 1 | **2**（文件 / 变动） |
| Markdown | 纯文本 + 正则高亮 | **`<markdown>` 富文本渲染** |
| diff | 无 | **`<diff>` unified/split** |
| 滚动 | `overflow="scroll"` | **`<scrollbox>` + 视口裁剪** |
| 语法高亮 | 手写 100 行 tokenizer | **宿主 `<code>` / Tree-sitter** |
| 代码行数上限 | 1000 行硬截断 | 分页 / 视口裁剪 |

## 6.6 实测结论：宿主能力边界（v2.0.20）

设计阶段的判断需要用实测修正。以下均通过 PTY 抓取 + 探针文件验证。

### 槽位可用性实测

| 槽位 | claim render 是否被调用 | 可见 |
|---|---|---|
| `app` | ✅ | （无输出，用于注册 keymap） |
| `home.footer` / `home.footer.status` | ✅ | ✅ |
| `prompt.footer` / `.status` / `.file` | ✅ | `prompt.footer.status` ✅，另两者被挤掉 |
| `session.panel` | ✅ | ✅ |
| `sidebar.content` | ❌ **从不调用** | — |
| `sidebar.footer` | ❌ **从不调用** | — |
| `session.composer.top` | ❌ **从不调用** | — |

**结论**：「文件清单放进宿主侧栏 MCP 下方」这条路在 v2.0.20 走不通 ——
侧栏明明在渲染（MCP 区块可见），但 claim 的 render 一次都没被调用。这是宿主 bug，不是用法错误。
因此把「会话」清单收进面板，作为三个视图之一。

### 宿主渲染器：必须自带 `syntaxStyle`

`MarkdownOptions` / `CodeOptions` / `DiffRenderableOptions` 都把 `syntaxStyle` 声明为**必填**。
缺它时构造抛错，**整个面板渲染树被中断**（连 `<diff>` 前面那个普通 `<text>` 都不显示）。

- `await import("@opentui/core")` → `Cannot find package`（宿主只对**静态** import 注入）
- `import { SyntaxStyle } from "@opentui/core"`（静态）→ ✅ 可用
- `SyntaxStyle.fromTheme([{ scope, style: { foreground } }])` ← 从 `theme.syntax` 转 RGBA buffer

### 数据源签名修正

- `client.session.diff({ sessionID })` → `Promise<FileDiffInfo[]>`，**直接是数组**，没有 `{ data }` 外层
- `client.vcs.diff({ mode, location })` → `{ data: FileDiffInfo[] }` ← 这个**有**外层

### 语法高亮：宿主渲染器不可用（实测结论）

`<code>` 把着色委托给全局 tree-sitter client，而该 client **不会为插件渲染的视图初始化**，
`highlightOnce()` 返回空后渲染器**静默退回纯文本**（无报错、无警告）。

逐步排除：

| 尝试 | 结果 |
|---|---|
| `<code>` + 合法 grammar + `SyntaxStyle` | 整行单色 |
| `filetype="ts"` | 无 grammar，`ts`/`js` 不是 grammar 名 |
| `filetype="typescript"`（宿主 `pathToFiletype()`） | 仍无高亮 |
| 检查宿主二进制 | grammars wasm、`highlightOnce` 均存在 → 初始化问题 |
| 搜 `Code highlighting failed` 日志 | **无输出** → 证实静默降级 |

**决策**：自带正则分词器（`makeTokenizer`），颜色全部取自 `theme.syntax`。
代价是多写 ~80 行；收益是**高亮一定存在**，且随用户主题自动适配，
不依赖宿主某个版本是否初始化了 tree-sitter。

分词要点：
- 单条有序正则一次扫描，注释/字符串整体消费，内部关键字不会被误标
- 闭包携带**跨行块注释**状态（否则 JSDoc 正文会被当成代码）
- 按语言区分注释风格（`HASH_COMMENT` / `SLASH_COMMENT`）
- 标识符靠后瞻定类：关键字 → 首字母大写=类型 → 紧跟 `(`=函数 → 否则变量

### 设计系统落地（TUI 转译）

检索到的设计系统是 Web 向的（Dark Mode OLED / density 8 / JetBrains Mono）。
TUI 无法直接套用 CSS，但可以迁移其**层次原则**：

| Web 原则 | TUI 落地 |
|---|---|
| 用 surface 抬升区分层次 | 活动标签落在 `background.selected` 药丸上 |
| 依赖明度对比建立层次 | 三级：文件名全亮 / 目录与元信息弱化 / 字形着语义色 |
| 语义色 token，不硬编码 | 全部取自 `context.theme`（`text`/`syntax`/`diff`/`background`） |
| 状态不能只靠颜色 | 选中态同时有 `▌` 光标 + 抬升背景 |
| 空状态要给出路 | `EmptyState` 组件统一「标题 + 具体下一步」 |
| 图标语义一致 | 文件族统一字形（◆▤⚙◰▦▣）+ 同族同色 |

### 三个交互缺陷的根因（均为实测）

#### 1. 触控板/滚轮失效

`ScrollBox` 的滚轮处理是 `onMouseEvent` 里 `this.scrollAccel.tick(now)`。
`scrollAcceleration` 的类型是 `ScrollAcceleration`（接口：`tick()` / `reset()`），
**传字符串会让这里直接抛错**，滚轮路径整个挂掉 —— 而拖动滚动条走
`ScrollBarRenderable` 的另一套逻辑，所以照常工作。表象极具迷惑性：
「能拖不能滚」。

改为传 `new MacOSScrollAccel()`（宿主自带的 macOS 原生加速曲线）。

#### 2. Markdown 无样式

`<markdown>` 按**作用域名**查 `SyntaxStyle`，命名空间是 `markup.*`：

```
markup.heading  markup.strong  markup.italic  markup.link
markup.link.label  markup.link.url  markup.list  markup.quote
markup.raw  markup.strikethrough
```

与代码高亮的 `theme.syntax`（`keyword` / `string` / `comment` …）**零重叠**。
只注册代码 token ⇒ markdown 每个作用域都查不到 ⇒ 整篇退化为无格式纯文本。
现在两套都注册。

#### 3. JSON 触发终端崩溃

根因是**渲染成本模型错了**：高亮原本是「每个 token 一个 `<text>` renderable」。
压缩 JSON 是单行巨串，切出几万个 token ⇒ 几万 renderable ⇒ 终端崩溃。

改为行内 `<span>`（廉价 text node），每行仅 1 个 renderable，并加三重上限：
`MAX_RENDER_LINES=3000` / `MAX_LINE_CHARS=4000` / `MAX_TOKENS_PER_LINE=400`。

> 教训：TUI 里的「样式」不是免费的。每个 span 都要走 Yoga 布局 + 帧缓冲，
> 节点数量本身就是性能与稳定性问题，与视觉复杂度无关。

### 布局重叠与交互补强

**重叠根因**：把内容区从 `<box overflow="scroll">` 换成 `<scrollbox>` 时，
外层包装没删，于是形成嵌套视口。内层被压缩时把文件头挤成 0 高度，
文件头就画在了第一行代码上 —— 表现为「文件名和内容第一行重叠」。

修正：删掉多余外层滚动容器；文件头 `height={1}` + `flexShrink={0}`；
标签栏同样固定高度。教训：**滚动容器只能有一个**，嵌套视口会静默破坏布局。

**渐进加载**：代码区初始只渲染 `CHUNK_LINES=400` 行，底部出现
`▸ 点击加载更多 · 已显示 400 / 522 行`，点击追加下一段。
这既解决大文件一次性铺满的问题，也让「读到哪里'加载到哪里'」成为可能。

**可拖拽分隔条**：列表区高度用百分比（`listPct`），分隔条按下后
由面板根节点接管 `move`/`up`，用**增量**换算百分比（只依赖指针行位移与面板高度，
不依赖绝对坐标）。未移动的按下视为点击，在 25/40/55/70% 之间循环 ——
即使终端不派发 drag 事件也仍然可用。比例写入持久化存储。

> 符号约定：终端 `y` 坐标**向下为正**，所以「向下拖 → 列表变高 → 分隔条下移」，
> 公式是 `listPct + dy/height*100`。写成减号会让分隔条与手指**反向**运动
> （往上拖反而变矮），这是分隔条实现里最常见的符号错误。

### 鼠标事件冒泡导致剪贴板误读

**现象**：点击文件后报错 `Cannot read "clipboard" (this model does not support image input)`。

**根因**：OpenCode 宿主在应用根节点注册了 `onMouseDown` 处理器，对**右键**点击
触发剪贴板粘贴（`$w(T,W,Ze)` = paste 函数）。插件的 `onMouseDown` 没有调用
`stopPropagation()`，事件冒泡到宿主根节点后，宿主读取剪贴板 → 发现图片 →
当前模型（GLM 5.2 等）不支持图片输入 → 插入错误文本块。

注意：此错误文本是模型请求准备阶段（`SessionModelRequest.prepare` 里的 `d6` 函数）
生成的，它把不支持的媒体类型替换成 `ERROR: Cannot read "${filename}" (this model
does not support ${type} input). Inform the user.` 文本块。文件名 `"clipboard"`
说明剪贴板里有图片。

**修复**：所有 `onMouseDown` 用 `click()` 辅助函数包裹，内部先
`e.stopPropagation()` + `e.preventDefault()` 再执行业务逻辑，确保鼠标事件不会
冒泡到宿主的粘贴处理器。

### 高亮失效根因与弹窗查看

**ts/tsx/go/vue 无高亮的根因**：`syntaxColor()` 直接返回 `theme.syntax.keyword`
等原始主题值。opentui 主题把颜色存成 `{buffer:{0:R,1:G,2:B}}` 的 RGB buffer 对象，
不是字符串 —— `<span fg={对象}>` 拿到对象后渲染器无法识别，全部退化成默认色，
看起来就是「完全没有高亮」。修复：每个 `syntax.X` 都走 `colorOf()` 提取
`#rrggbb` 字符串。

同时发现 `pathToFiletype()` 返回的语言名与 tokenizer 的集合不匹配：
- `.tsx` → `typescriptreact`（不是 `tsx`）
- `.jsx` → `javascriptreact`（不是 `jsx`）
- `.vue` → `vue`（不在旧集合里）

这些名字没进 `SLASH_COMMENT`，所以块注释也不识别。补全后 ts/tsx/vue/svelte/astro
的 `//` 和 `/* */` 注释也正常了。运算符正则加了 `@`，Angular 装饰器 `@Component`
才会被切成 `@`（运算符色）+ `Component`（类型色），而不是一整块纯文本。

**全屏弹窗查看**：文件头的 ⤢ 按钮把当前文件弹到全屏覆盖层 —— 用
`position="absolute"` + `zIndex={9999}` 在 `app` slot 渲染，覆盖整个终端
而非仅面板区域。弹窗复用 `FileContent` 组件（从 ContentArea body 抽取的共享
渲染器），所以代码高亮、markdown 样式、diff 视图在弹窗里和面板里完全一致。
关闭方式：Esc / q / 头部 ✕ 按钮。滚动：↑↓ PgUp/PgDn g/G，全部 `enabled: () => modalOpen()`
门控，不与面板的滚动键冲突。

### 6.7 最终落地形态

```
▸ 会话   文件   变动                          [全屏] [×]
────────────────────────────────────────────────
  ▤ README.md                        ×3        ← 会话：对话中涉及的文件
  ◈ src/index.ts                     ×1
────────────────────────────────────────────────
README.md  4KB  86 行                              [ⓧ]
────────────────────────────────────────────────
  <markdown> / <code> / <diff>                   ← 宿主渲染器
```

- `会话`：`@` 引用 + 工具调用路径 + `filesystem.changed`
- `文件`：懒加载目录树（`createMemo` 纯计算 + `createEffect` 触发 IO）
- `变动`：`本轮` = `session.diff`，`全部` = `vcs.diff`
- 快捷键：`t` 切视图 / `s` 切范围 / `d` 切 diff 布局 / `f` 全屏 / `esc` 关闭
- 面板 keymap 层需 `priority: 10`，否则单字母键被宿主抢占

---

## 6.5 实施路线

- **R1（基础）**：侧栏区块（会话文件清单）+ 右侧面板骨架 + `<markdown>`/`<code>` 渲染
- **R2（文件树）**：懒加载目录树 + Git 状态着色 + 过滤
- **R3（变动视图）**：本轮/全部双视角 + `<diff>` 渲染
- **R4（打磨）**：键盘导航、面板宽度记忆、`<textarea>` 简易编辑
