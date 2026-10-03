# opencode-right-preview

OpenCode TUI 插件：**右侧文件浏览面板**。

在主会话里用 `@` 引用文件、或让 AI 读写文件后，这些文件会自动出现在面板里；
点击即可在右侧直接查看 —— 语法高亮代码、Markdown 富文本、Git diff。

基于 OpenCode v2 官方 `session.panel` 槽位实现，零构建步骤（纯 TSX）。

## 功能

- **三个视图**，`t` 循环切换：
  - `会话` —— 本次对话中涉及的所有文件（`@` 引用、AI 读取/创建/修改）
  - `文件` —— 项目目录树，懒加载、隐藏噪声目录、带过滤框
  - `变动` —— 变更追踪，`本轮`（本会话改动）/ `全部`（工作区 Git 变更）
- **语法高亮** —— 自带分词器 + 行号栏，颜色取自宿主的 `theme.syntax`，
  所以换主题时高亮自动跟随（详见下方「为什么自己写高亮」）
- **Markdown 富文本渲染**，由宿主 `<markdown>` 渲染器负责
- **Git diff** 渲染，支持 unified / split 切换（`d`）
- **滚动**：鼠标滚轮 / 触控板、拖动滚动条、`↑` `↓` 单行、`PgUp` `PgDn` 十行、`g` `G` 首尾
- 面板聚焦时的快捷键：`t` 切视图 · `s` 切范围 · `d` 切 diff 布局 · `f` 全屏 · `esc` 关闭
- **渐进加载**：先渲染一屏的行，滚到底点「加载更多」再展开下一段 —— 大文件不会一上来就把终端压垮
- **可拖拽分隔条**：拖动调整「文件树 / 内容区」的高度比例（也支持点击在 25/40/55/70% 之间切换），比例会被记住
- **全屏弹窗查看**：点文件头的 ⤢ 按钮把当前文件弹到全屏覆盖层查看（类似编辑器的标签页全屏），Esc / q 关闭，↑↓ PgUp/PgDn g/G 滚动
- 记忆上次打开的文件（仅当它属于当前项目）
- 三种入口：快捷键 `ctrl+x p`、命令面板、`/preview <路径>`

## 界面

```
会话   文件   变动                              还原  ✕
──────────────────────────────────────────────────────
 ▌ ◆ tui.tsx          opencode-right-preview/   ×12
   ▤ README.md        .
   ⚙ package.json     package.json
──────────────────────────────────────────────────────
◆ tui.tsx                                    39KB · 1123 行
──────────────────────────────────────────────────────
  1 │ import { Plugin } from "@opencode/plugin/tui"
  2 │
  3 │ /**                     ← 注释
  4 │  * Server-side plugin entry.
  5 │  */
  6 │ export default Plugin.define({     ← 关键字 / 类型 / 函数分色
```

设计要点：

- **选中态**用左侧 `▌` 光标 + 抬升背景表示，不单靠颜色
- **活动标签**落在抬升底色的「药丸」上，一眼可辨
- **三级层次**：文件名全亮、目录与元信息弱化、装饰字形着语义色
- **文件类型着色**：代码=◆ 青、文档=▤ 黄、配置=⚙ 品红、样式=◰ 绿、数据=▦ 紫、媒体=▣
- **空状态**给出具体下一步动作，而不是只说「暂无内容」

## 安装

### 方式一：通过 OpenCode 插件命令安装（推荐）

```bash
# 从 GitHub 安装
opencode plugin add github:CR903/opencode-right-preview

# 指定分支或标签
opencode plugin add github:CR903/opencode-right-preview#main

# 使用 SSH
opencode plugin add git+ssh://git@github.com/CR903/opencode-right-preview.git

# 安装特定版本
opencode plugin add opencode-right-preview@0.1.0
```

### 方式二：手动配置

在 `~/.config/opencode/opencode.json` 或项目根目录的 `opencode.json` 中添加：

```json
{
  "plugins": ["github:CR903/opencode-right-preview"]
}
```

### 方式三：本地开发/源码安装

```bash
# 克隆到本地
git clone git@github.com:CR903/opencode-right-preview.git

# 方式 A：复制到全局插件目录
cp -r opencode-right-preview ~/.config/opencode/plugins/opencode-right-preview

# 方式 B：配置本地路径
echo '{ "plugins": ["./path/to/opencode-right-preview"] }' > ~/.config/opencode/opencode.json
```

### 验证安装

重启 OpenCode 后验证：

```bash
opencode --print-logs plugin list
# 应看到 right-preview.server / right-preview.tui
```

### 更新插件

```bash
# 更新所有插件
opencode plugin update

# 更新指定插件
opencode plugin update opencode-right-preview
```

### 卸载插件

```bash
opencode plugin remove opencode-right-preview
```

## 使用

1. `ctrl+x p` 打开面板（或命令面板里选 “Open the file panel”）。
2. `会话` 标签列出本轮对话涉及的文件，点击即在下方查看。
3. `/preview src/index.ts` 直接打开指定路径。
4. 点 `文件` 浏览整个项目，点 `变动` 看 AI 到底改了什么。

> 终端宽度不足约 80 列时宿主会强制全屏，这是 OpenCode 的行为，不是插件的 bug。

## 为什么自己写语法高亮

宿主确实内置了 `<code>` 渲染器，但它**在插件里用不了**：

`<code>` 把语法着色交给一个全局 tree-sitter client，而该 client **不会为插件渲染的视图初始化**。
`highlightOnce()` 返回空结果后，渲染器**静默退回纯文本** —— 不报错、不告警，就是没有颜色。

实测（v2.0.20）逐一排除了其他可能：

| 尝试 | 结果 |
|---|---|
| `<code>` + 合法 grammar 名 + `SyntaxStyle` | 整行单色，**无高亮** |
| `filetype="ts"`（扩展名而非 grammar 名） | 无高亮 —— `ts`/`js` 没有对应 grammar |
| `filetype="typescript"`（宿主 `pathToFiletype()` 解析） | 仍无高亮 |
| 检查宿主二进制 | grammars wasm 与 `highlightOnce` 都在，说明是初始化问题而非缺资源 |
| 查找 `Code highlighting failed` 警告 | **无任何输出** —— 证实是静默降级 |

所以本插件自带一个正则分词器，用宿主主题的 `theme.syntax` 上色：
换主题自动跟随配色，也不会因为宿主某个版本没初始化 tree-sitter 就退化成「没有高亮的代码查看器」。

分词器覆盖：关键字、字符串、数字、注释（含**跨行块注释**）、函数、类型、运算符、标点，
按语言区分注释风格（`#` 与 `//`），并跳过 glob/模板等非文件路径。

颜色以行内 `<span>` 输出，每行只创建一个 renderable —— 这是大文件（含压缩 JSON）
不炸终端的关键。

### Markdown 为什么要单独注册作用域

`<markdown>` 渲染器不读主题配置，而是按**作用域名**去 `SyntaxStyle` 里查：
`markup.heading`、`markup.strong`、`markup.italic`、`markup.link`、`markup.link.url`、
`markup.list`、`markup.quote`、`markup.raw`、`markup.strikethrough`。

这套命名和代码高亮的 `theme.syntax`（`keyword`/`string`/`comment`…）**完全不重叠**。
只注册代码 token，markdown 的每个作用域都查不到样式，于是整篇渲染成无格式纯文本。
所以插件同时注册两套：代码作用域原样取自主题，markdown 作用域映射到最接近的主题色。

## 工作原理

- **文件收集**
  - 用户消息的 `files[].source.uri`（`@` 引用）
  - AI 消息中已完成工具调用的 `state.input`（只取已知路径键，见下方踩坑）
  - `filesystem.changed` 事件（新建/修改的文件）
- **数据源**
  - `context.client.session.diff({ sessionID })` → `FileDiffInfo[]`（**直接返回数组，没有 `{ data }` 外层**）
  - `context.client.vcs.diff({ mode: "working", location: { directory } })` → `{ data: FileDiffInfo[] }`
- **面板**：`context.ui.slot({ append: "session.panel" })` + `ui.panel.open("right-preview")`
- **主题**：所有颜色取自 `context.theme`（`text` / `syntax` / `diff` / `background`），
  不硬编码色值，所以跟随用户的终端主题
- **状态**：`context.storage.store` 持久化（键名带 `.v3` 版本后缀，结构变化时换键即可重置）

## 踩坑记录

开发过程中实测踩到并修复的问题，均在 OpenCode v2.0.20 / `@opencode/plugin` v2.0.8 上验证。

| 问题 | 原因 | 解决 |
|---|---|---|
| **代码完全不高亮** | `<code>` 依赖的全局 tree-sitter client 未为插件视图初始化，`highlightOnce()` 返回空后**静默退回纯文本** | 自带正则分词器 + `theme.syntax` 上色（见上一节） |
| **触控板/滚轮无法滚动**，只能拖滚动条 | `scrollAcceleration` 我传了字符串 `"fast"`，但它必须是实现了 `tick()`/`reset()` 的**对象**；`ScrollBox.onMouseEvent` 里 `this.scrollAccel.tick(...)` 抛错，滚轮路径直接挂掉，而拖滚动条走的是另一条代码路径所以照常工作 | 传入 `new MacOSScrollAccel()`（宿主的 macOS 原生加速曲线） |
| **md 文件没有任何样式** | `<markdown>` 按**作用域名**查样式，用的是 `markup.*` 命名空间（`markup.heading`/`markup.strong`/`markup.link`…），与代码的 `theme.syntax` 完全不重叠。只注册代码 token → 所有 markdown 作用域查不到 → 渲染成一片无格式纯文本 | `SyntaxStyle` 里补齐整套 `markup.*` 作用域，映射到最接近的主题色 |
| **查看 JSON 文件导致终端崩溃** | 高亮是**每个 token 一个 `<text>` renderable**；压缩过的 JSON 是单行巨串，能切出几万个 token → 几万 renderable 直接把终端拖垮 | 改用行内 `<span>`（廉价文本节点，1 行 1 个 renderable），并加三重上限：行数 5000 / 单行字符 4000 / 单行 token 400，超出折叠并提示 |
| **文件名首行与代码第一行重叠** | 升级到 `<scrollbox>` 时漏删了外层的 `overflow="scroll"` 包装，形成**嵌套视口**；内层被压缩时把文件头挤成 0 高度，于是画在了第一行代码上 | 删掉多余的外层滚动容器；文件头显式 `height={1}` + `flexShrink={0}`（这一行是刚性需求） |
| **ts/tsx/go/vue 等代码文件完全没有高亮** | `syntaxColor()` 直接返回 `theme.syntax.keyword` 等**原始主题值**；opentui 主题把这些值存成 `{buffer:{0:R,1:G,2:B}}` 对象而非字符串，于是 `<span fg={对象}>` 拿到的是个对象 → 渲染器无法识别 → 全部退化成默认色，看起来就是「没有高亮」 | 每个 `syntax.X` 都走 `colorOf()` 提取出 `#rrggbb` 字符串再传给 `fg`；同时补全 `typescriptreact`/`javascriptreact`/`vue`/`svelte`/`astro` 进 `SLASH_COMMENT`（`pathToFiletype` 返回这些名字而非 `tsx`/`jsx`），并给运算符正则加上 `@` 让 Angular 装饰器 `@Component` 正确分词 |
| **点击文件后报错 "Cannot read \"clipboard\" (this model does not support image input)" | 鼠标按下事件未调用 `stopPropagation()`，冒泡到宿主根节点后触发右键粘贴 → 宿主读取剪贴板图片 → 当前模型（如 GLM 5.2）不支持图片输入 → 报错 | 用 `click()` 辅助函数包裹所有 `onMouseDown`，内部先 `e.stopPropagation()` + `e.preventDefault()` 再执行业务逻辑 |
| **面板整个不渲染**（连前置 `<text>` 都不显示） | `<markdown>` / `<diff>` 都**必填** `syntaxStyle`；缺失时构造抛错，整个渲染树被中断 | 静态 `import { SyntaxStyle } from "@opentui/core"` + `fromTheme()` |
| 动态 `import("@opentui/core")` 失败 | 宿主只对**静态** import 注入这些包；动态 import 走 Bun 解析器，找不到包 | 只能用静态 import |
| `/preview <路径>` 打不开文件 | `slash: { arguments: true }` 传给 `run` 的是**整行原文** `/preview a/b.ts` | `parsePreviewArg()` 剥掉命令前缀再当路径 |
| `/preview` 打开了「上次看的文件」 | 打开面板时会恢复 `lastFile`，与 `/preview` 的加载并发，慢的那个赢 | 加单调 `loadSeq` 令牌，只允许最后一次加载生效 |
| `sidebar.content` / `sidebar.footer` / `session.composer.top` 槽位从不渲染 | **宿主 bug**：侧栏可见（MCP 区块在显示），但 claim 的 `render` 一次都没被调用 | 放弃侧栏方案，改为面板内三视图（实测有效的槽位：`app` / `prompt.footer*` / `home.footer*` / `session.panel`） |
| 所有文件报「路径不在项目内」 | `data.session.root(id)` 返回**根会话 ID**（`ses_xxx`），不是目录 | 改用 `data.project.list()[].canonical` 等真实目录来源 |
| 相对路径解析到错误位置 | 全局安装的 TUI 插件，`context.location` 与 `process.cwd()` 都指向**插件自身目录** | 多候选根目录 + 过滤插件目录 + 按「文件真实存在」择一 |
| 文件树一直显示「正在加载…」 | `visibleTree()` 是普通函数，`For each={...}` 拿不到 `treeCache` 的响应式依赖 | 改为 `createMemo`；异步 `readdir` 的副作用挪进 `createEffect` |
| 视图标签点击后不切换 | Solid store 读取没建立响应式；且 `void (d.tab = ...)` 吞掉赋值语义 | 包一层访问器 `activeTab()`；赋值写成 `{ d.tab = ... }` |
| 面板内单字母快捷键（`t`/`s`）被宿主抢占 | 层没有 `priority`，与宿主默认绑定冲突 | 面板 keymap 层加 `priority: 10` |
| 会话列表混入 `git diff HEAD -- a.txt` | 把工具入参里任意含 `/` 的字符串都当成路径（`shell` 的 `command` 字段） | 改为**路径键白名单**（`filePath`/`path`/`file`…），并跳过含 glob 字符的值 |
| 切项目后自动打开上一个项目的文件 | 持久化存储是全局的，而 `projectRoots()` 会列出用户**所有**项目 | 恢复前校验路径确实位于 `projectRoot()` 之下 |
| JSDoc 块注释只有首行变灰 | 逐行独立分词，`/* … */` 跨行状态丢失 | 分词器改为闭包，跨行携带块注释状态 |
| `Keymap.Provider is missing` | `context.keymap.layer()` 不能在 `setup` 里直接调用 | 放进槽位的 `render` 中注册（该层由宿主按组件生命周期托管，重复调用不会泄漏） |
| `ctrl+x p` 无效 | leader 组合键必须写成 `<leader>p` | `bind: "<leader>p"` |
| 内容区空白 | `when={openFile() && !loading()}` 把文件对象强转成布尔 `true` | `when={!loading() && openFile()}` |
| `of is not a function` 崩溃 | 给 `Show` 加了 `keyed`，子函数收到原始值而非访问器 | 去掉 `keyed` |

## License

MIT
