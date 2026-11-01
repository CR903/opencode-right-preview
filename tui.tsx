import { Plugin } from "@opencode/plugin/tui"
import { MacOSScrollAccel, pathToFiletype } from "@opentui/core"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { existsSync } from "node:fs"
import { readdir, stat } from "node:fs/promises"
import { spawn } from "node:child_process"
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path"

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

type PanelTab = "session" | "files" | "changes"
type ChangeScope = "session" | "git"
type FileKind = "ref" | "tool" | "changed"

/** A file the AI touched, read, or was handed during this session. */
interface SessionFile {
  /** Absolute path. */
  path: string
  kind: FileKind
  /** Times the AI came back to it — a cheap "hotness" signal. */
  hits: number
}

/** A file with uncommitted changes. Mirrors the server's `FileDiffInfo`. */
interface DiffEntry {
  file: string
  additions: number
  deletions: number
  status: string
}

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  depth: number
}

/** A local editor the panel can hand files to. */
interface EditorOption {
  id: string
  label: string
  /** CLI binary name, resolved against PATH first. */
  binary?: string
  /** macOS app name; used via `open -a <app>` as a fallback. */
  app?: string
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PANEL_NAME = "right-preview"
/** Storage key carries a version suffix; the v4 shape dropped the content preview. */
const STORE_KEY = "right-preview.v4"

/** Cap on entries read from one directory. */
const TREE_MAX_ENTRIES = 400
/** Cap on flattened tree rows, so a huge tree cannot stall the render loop. */
const TREE_MAX_ROWS = 500
/** Cap on tree recursion depth. */
const TREE_MAX_DEPTH = 6
/** One indent step per tree depth. */
const INDENT = "  "
/** Rows shown in the session tab before it defers to the file tree. */
const SESSION_MAX = 60
/** Left-rail cursor marking the selected row. */
const CURSOR = "▌"

/** Directories never worth showing in a file tree. */
const NOISE_DIRS = new Set([
  "node_modules", ".git", ".next", ".cache", "dist", "build", "out",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  "coverage", ".turbo", ".svelte-kit", ".gradle", "target", "vendor",
  "DerivedData",
])

/** Editors offered in the picker, ordered roughly by popularity. */
const EDITORS: EditorOption[] = [
  { id: "vscode", label: "VS Code", binary: "code", app: "Visual Studio Code" },
  { id: "cursor", label: "Cursor", binary: "cursor", app: "Cursor" },
  { id: "windsurf", label: "Windsurf", binary: "windsurf", app: "Windsurf" },
  { id: "zed", label: "Zed", binary: "zed" },
  { id: "sublime", label: "Sublime Text", binary: "subl", app: "Sublime Text" },
  { id: "webstorm", label: "WebStorm", app: "WebStorm" },
  { id: "idea", label: "IntelliJ IDEA", app: "IntelliJ IDEA" },
  { id: "pycharm", label: "PyCharm", app: "PyCharm" },
  { id: "textedit", label: "TextEdit", app: "TextEdit" },
  { id: "vim", label: "Vim（终端）", binary: "vim" },
  { id: "nvim", label: "Neovim（终端）", binary: "nvim" },
]

/* ------------------------------------------------------------------ */
/* Pure helpers                                                        */
/* ------------------------------------------------------------------ */

/** A theme colour is `{ buffer: {0:r, 1:g, 2:b, 3:a} }`; renderers want a CSS colour. */
function colorOf(value: unknown): string | undefined {
  if (typeof value === "string") return value
  const buffer = (value as { buffer?: Record<string, unknown> })?.buffer
  if (!buffer) return undefined
  const channel = (n: string) => Math.max(0, Math.min(255, Number(buffer[n]) | 0))
  const hex = (n: number) => n.toString(16).padStart(2, "0")
  return `#${hex(channel("0"))}${hex(channel("1"))}${hex(channel("2"))}`
}

/** File-type family, used for both the glyph and its colour. */
type FileFamily = "code" | "doc" | "config" | "style" | "data" | "media" | "other"

/** Classify a file so rows can be tinted by meaning, not just labelled. */
function fileFamily(name: string): FileFamily {
  const lower = basename(name).toLowerCase()
  if (lower === "readme.md" || lower === "agents.md" || lower === "claude.md") return "doc"
  const ext = extname(name).toLowerCase()
  if ([".md", ".mdx", ".markdown", ".txt", ".rst", ".pdf"].includes(ext)) return "doc"
  if ([".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".lock"].includes(ext)) return "config"
  if ([".css", ".scss", ".less", ".html", ".vue", ".svelte"].includes(ext)) return "style"
  if ([".csv", ".tsv", ".sql", ".log"].includes(ext)) return "data"
  if ([".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".ico"].includes(ext)) return "media"
  const lang = (() => {
    try {
      return pathToFiletype(lower) ?? ""
    } catch {
      return ""
    }
  })()
  if (lang && lang !== "json" && lang !== "yaml" && lang !== "markdown") return "code"
  return "other"
}

/** Single-glyph file-type badge. */
function fileBadge(name: string): string {
  switch (fileFamily(name)) {
    case "doc":
      return "▤"
    case "config":
      return "⚙"
    case "style":
      return "◰"
    case "data":
      return "▦"
    case "media":
      return "▣"
    case "code":
      return "◆"
    default:
      return "◈"
  }
}

/** Column width for a CJK-aware ellipsis truncation. */
function truncate(text: string, width: number): string {
  if (width <= 1) return ""
  let used = 0
  let out = ""
  for (const ch of text) {
    const w = /[\u1100-\u115F\u2E80-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE6F\uFF00-\uFF60\uFFE0-\uFFE6]/.test(ch)
      ? 2
      : 1
    if (used + w > width) return `${out}…`
    out += ch
    used += w
  }
  return out
}

/** `file://` URI → filesystem path. */
function uriToPath(uri: string): string | null {
  if (!uri?.startsWith("file://")) return null
  const raw = uri.slice("file://".length)
  try {
    return decodeURIComponent(raw)
  } catch {
    return raw
  }
}

/** Strip the slash-command prefix from `/preview a/b.ts`. */
function parsePreviewArg(raw: string | undefined): string | null {
  const text = (raw ?? "").trim()
  if (!text) return null
  if (!text.startsWith("/")) return text
  return text.replace(/^\/[A-Za-z0-9:_-]+/, "").trim() || null
}

/** Input keys that actually carry a file path. */
const PATH_KEYS = new Set([
  "filePath", "file_path", "filepath", "file", "path",
  "notebook_path", "notebookPath", "targetFile", "target_file", "filename",
])

/** Dig a filesystem path out of a tool's input object. */
function extractPath(input: unknown, depth = 0): string | null {
  if (depth > 5) return null
  if (Array.isArray(input)) {
    for (const item of input) {
      const found = extractPath(item, depth + 1)
      if (found) return found
    }
    return null
  }
  if (!input || typeof input !== "object") return null
  const obj = input as Record<string, unknown>
  for (const [key, value] of Object.entries(obj)) {
    if (!PATH_KEYS.has(key) || typeof value !== "string") continue
    const candidate = value.trim()
    // Skip globs and template placeholders — they are patterns, not files.
    if (!candidate || /[*?[\]{}!]/.test(candidate)) continue
    return candidate
  }
  for (const value of Object.values(obj)) {
    const found = extractPath(value, depth + 1)
    if (found) return found
  }
  return null
}

/** Resolve a CLI binary name against PATH. */
function which(binary: string): string | undefined {
  const pathEnv = process.env.PATH ?? ""
  for (const dir of pathEnv.split(":")) {
    if (!dir) continue
    const full = join(dir, binary)
    if (existsSync(full)) return full
  }
  return undefined
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export default Plugin.define({
  id: "right-preview.tui",
  setup(context) {
    /* ---------------- state ---------------- */

    const [settings, updateSettings] = context.storage.store(STORE_KEY, {
      initial: {
        tab: "session" as PanelTab,
        scope: "session" as ChangeScope,
        editor: "",
      },
    })

    /** Files the AI referenced or touched, keyed by session. */
    const [sessionFiles, setSessionFiles] = createSignal<Record<string, SessionFile[]>>({})
    /** This session's diff, keyed by session. */
    const [sessionDiff, setSessionDiff] = createSignal<Record<string, DiffEntry[]>>({})
    /** The whole working tree's diff. */
    const [gitDiff, setGitDiff] = createSignal<DiffEntry[]>([])
    /** Currently highlighted file path. */
    const [selectedPath, setSelectedPath] = createSignal<string>("")
    const [filter, setFilter] = createSignal("")

    /**
     * Wrap any click handler so the mouse event is consumed and never reaches
     * the host's root — an un-stopped right-click triggers the host's clipboard
     * paste, which throws "Cannot read 'clipboard' (this model does not support
     * image input)" when the model lacks image support.
     */
    const click = <T,>(fn: () => T) => (e?: { stopPropagation?: () => void; preventDefault?: () => void }) => {
      e?.stopPropagation?.()
      e?.preventDefault?.()
      return fn()
    }

    // `settings` is a Solid store; these accessors keep every consumer reactive.
    const activeTab = () => settings.tab
    const activeScope = () => settings.scope

    /* ---------------- theme ---------------- */

    const th = () => context.theme as Record<string, any>
    const textBase = () => th().text?.base ?? th().text?.default ?? "#ffffff"
    const textMuted = () => th().text?.muted ?? th().text?.subdued ?? "#888888"
    const surfaceRaised = () => th().background?.raised?.base
    const surfaceActive = () => th().background?.selected?.base ?? th().surface?.base ?? th().background?.raised?.base
    const accent = () => th().hue?.accent?.[500] ?? th().syntax?.keyword ?? textBase()
    const diffAdded = () => th().diff?.text?.added ?? "#4ade80"
    const diffRemoved = () => th().diff?.text?.removed ?? "#f87171"

    /* ---------------- project root ---------------- */

    /**
     * A globally-installed TUI plugin reports its own folder as `location`, and
     * `process.cwd()` can be that folder too — so neither identifies the user's
     * project. `data.project.list()[].canonical` is authoritative; the rest are
     * fallbacks ranked by trust.
     */
    function projectRoots(): string[] {
      const out: Array<{ abs: string; rank: number }> = []
      const home = process.env.HOME ?? ""
      const pluginDirs = [resolve(join(home, ".config", "opencode")), resolve(join(home, ".opencode"))]
        .map((d) => resolve(d))
        .filter((d) => d !== sep)

      const push = (dir: unknown, rank: number) => {
        if (typeof dir !== "string" || !dir) return
        const abs = resolve(dir)
        if (abs === sep) return
        if (pluginDirs.some((p) => abs === p || abs.startsWith(p + sep))) return
        const at = out.findIndex((e) => e.abs === abs)
        if (at >= 0) out[at].rank = Math.min(out[at].rank, rank)
        else out.push({ abs, rank })
      }

      try {
        for (const p of context.data.project.list() ?? []) push(p.canonical, 0)
      } catch {
        /* project store not synced yet */
      }
      try {
        push(context.location?.directory, 1)
      } catch {
        /* ignore */
      }
      try {
        push(context.data.location.default()?.directory, 2)
      } catch {
        /* ignore */
      }
      push(process.cwd(), 3)
      if (out.length === 0) out.push({ abs: process.cwd(), rank: 9 })
      out.sort((a, b) => a.rank - b.rank)
      return out.map((e) => e.abs)
    }

    /** Best guess at the project root, used for display and relative paths. */
    function projectRoot(): string {
      return projectRoots()[0] ?? process.cwd()
    }

    /** Resolve user input to a path inside the project. */
    function resolveInsideProject(input: string): { abs: string; root: string } | null {
      const candidates: Array<{ abs: string; root: string }> = []
      for (const root of projectRoots()) {
        const abs = isAbsolute(input) ? resolve(input) : resolve(root, input)
        const rel = relative(root, abs)
        if (rel.startsWith("..") || isAbsolute(rel)) continue
        candidates.push({ abs, root })
      }
      if (candidates.length === 0) return null
      return candidates.find((c) => existsSync(c.abs)) ?? candidates[0]
    }

    function currentSessionID(): string {
      const route = context.ui.router.current()
      return route.type === "session" ? route.sessionID : ""
    }

    /* ---------------- session file collection ---------------- */

    function addSessionFiles(sessionID: string, paths: Array<{ path: string; kind: FileKind }>) {
      if (!sessionID || paths.length === 0) return
      const root = projectRoot()
      setSessionFiles((prev) => {
        const existing: SessionFile[] = prev[sessionID] ?? []
        const list = new Map<string, SessionFile>(existing.map((e) => [e.path, e]))
        for (const { path, kind } of paths) {
          const abs = resolve(root, path)
          const hit = list.get(abs)
          if (hit) hit.hits += 1
          else list.set(abs, { path: abs, kind, hits: 1 })
        }
        return { ...prev, [sessionID]: [...list.values()] }
      })
    }

    /** Full scan of the transcript for referenced / touched files. */
    async function collectSessionFiles(sessionID: string) {
      if (!sessionID) return
      const found: Array<{ path: string; kind: FileKind }> = []
      try {
        await context.data.session.message.sync(sessionID)
        for (const msg of context.data.session.message.list(sessionID) ?? []) {
          if (msg.type === "user" && Array.isArray(msg.files)) {
            for (const f of msg.files) {
              if (f.source?.type === "uri") {
                const p = uriToPath(f.source.uri)
                if (p) found.push({ path: p, kind: "ref" })
              }
            }
          }
          if (msg.type !== "assistant") continue
          for (const part of msg.content) {
            if (part.type !== "tool") continue
            const state = part.state as { status?: string; input?: unknown; content?: unknown }
            if (state?.status !== "completed") continue
            const p = extractPath(state.input)
            if (p) found.push({ path: p, kind: "tool" })
            if (Array.isArray(state.content)) {
              for (const c of state.content) {
                const item = c as { type?: string; uri?: string }
                if (item?.type === "file" && item.uri) {
                  const fp = uriToPath(item.uri)
                  if (fp) found.push({ path: fp, kind: "tool" })
                }
              }
            }
          }
        }
      } catch {
        /* message store not synced */
      }
      if (found.length > 0) addSessionFiles(sessionID, found)
    }

    /* ---------------- diffs ---------------- */

    /** Normalise the server's FileDiffInfo into absolute paths. */
    function toDiffEntries(rows: unknown): DiffEntry[] {
      if (!Array.isArray(rows)) return []
      const root = projectRoot()
      const out: DiffEntry[] = []
      for (const row of rows as Array<Record<string, unknown>>) {
        const file = typeof row.file === "string" ? row.file : ""
        if (!file) continue
        out.push({
          file: resolve(root, file),
          additions: Number(row.additions ?? 0),
          deletions: Number(row.deletions ?? 0),
          status: typeof row.status === "string" ? row.status : "modified",
        })
      }
      return out
    }

    /** Files this session changed, with stats. */
    async function collectSessionDiff(sessionID: string) {
      if (!sessionID) return
      try {
        // Returns FileDiffInfo[] directly — no `{ data }` envelope.
        const rows = await context.client.session.diff({ sessionID } as never)
        setSessionDiff((prev) => ({ ...prev, [sessionID]: toDiffEntries(rows) }))
      } catch {
        /* not available for this session */
      }
    }

    /** Every uncommitted change in the working tree. */
    async function collectGitDiff() {
      try {
        const res = await context.client.vcs.diff({
          mode: "working",
          location: { directory: projectRoot(), mode: "working" },
        } as never)
        setGitDiff(toDiffEntries((res as { data?: unknown })?.data))
      } catch {
        /* not a git repo, or no VCS backend */
      }
    }

    /* ---------------- events ---------------- */

    const stops: Array<() => void> = []

    stops.push(
      context.data.on("session.tool.called", (e) => {
        const p = extractPath(e.data.input)
        if (p) addSessionFiles(e.data.sessionID, [{ path: p, kind: "tool" }])
      }),
    )

    stops.push(
      context.data.on("session.idle", (e) => {
        void collectSessionFiles(e.data.sessionID)
        void collectSessionDiff(e.data.sessionID)
        void collectGitDiff()
      }),
    )

    stops.push(
      context.data.on("filesystem.changed", (e) => {
        const file = e.data.file
        const sid = currentSessionID()
        if (!file || !sid) return
        addSessionFiles(sid, [{ path: file, kind: "changed" }])
        void collectGitDiff()
      }),
    )

    /* ---------------- file tree ---------------- */

    const [expanded, setExpanded] = createSignal<Set<string>>(new Set())
    const [treeCache, setTreeCache] = createSignal<Record<string, TreeNode[]>>({})

    /** Read one directory level into the cache. Idempotent. */
    async function loadDir(dir: string, depth: number): Promise<void> {
      try {
        const entries = await readdir(dir, { withFileTypes: true })
        const nodes: TreeNode[] = []
        for (const entry of entries) {
          if (NOISE_DIRS.has(entry.name)) continue
          if (entry.name.startsWith(".")) continue
          nodes.push({
            name: entry.name,
            path: join(dir, entry.name),
            isDir: entry.isDirectory(),
            depth,
          })
          if (nodes.length >= TREE_MAX_ENTRIES) break
        }
        nodes.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name))
        setTreeCache((prev) => ({ ...prev, [dir]: nodes }))
      } catch {
        /* unreadable — leave it out of the tree */
      }
    }

    /**
     * Kick off loads for expanded directories we have not read yet. This lives
     * outside the memo below so rendering stays pure and async writes land as a
     * second, cheap render pass.
     */
    createEffect(() => {
      const root = projectRoot()
      const seen = new Set<string>()
      const walk = (dir: string, depth: number) => {
        if (depth > TREE_MAX_DEPTH || seen.has(dir)) return
        seen.add(dir)
        if (!treeCache()[dir]) void loadDir(dir, depth)
        for (const node of treeCache()[dir] ?? []) {
          if (node.isDir && expanded().has(node.path)) walk(node.path, depth + 1)
        }
      }
      walk(root, 0)
    })

    /** Flatten the expanded tree into render rows, honouring the filter. */
    const visibleTree = createMemo<TreeNode[]>(() => {
      const root = projectRoot()
      const needle = filter().trim().toLowerCase()
      const rows: TreeNode[] = []

      const walk = (dir: string, depth: number) => {
        if (depth > TREE_MAX_DEPTH || rows.length > TREE_MAX_ROWS) return
        let nodes = treeCache()[dir] ?? []
        if (needle) nodes = nodes.filter((n) => n.name.toLowerCase().includes(needle))
        for (const node of nodes) {
          if (rows.length > TREE_MAX_ROWS) return
          // While filtering, keep directories so nested matches stay reachable.
          if (!needle || node.isDir) rows.push(node)
          if (node.isDir && (expanded().has(node.path) || needle)) walk(node.path, depth + 1)
        }
      }
      walk(root, 0)
      return rows
    })

    const toggleDir = (path: string) =>
      setExpanded((prev) => {
        const next = new Set(prev)
        if (next.has(path)) next.delete(path)
        else next.add(path)
        return next
      })

    /* ---------------- editor support ---------------- */

    /** The editor saved by the user, if still known. */
    const configuredEditor = createMemo<EditorOption | undefined>(() =>
      EDITORS.find((e) => e.id === settings.editor),
    )

    /** First editor whose CLI binary is actually on PATH. */
    function detectDefaultEditor(): EditorOption | undefined {
      for (const e of EDITORS) {
        if (e.binary && which(e.binary)) return e
      }
      return undefined
    }

    /** Build the argv to open `file`; falls back from CLI binary to macOS app. */
    function editorArgv(editor: EditorOption, file: string): string[] | null {
      if (editor.binary) {
        const bin = which(editor.binary)
        if (bin) return [bin, file]
      }
      if (process.platform === "darwin" && editor.app) {
        return ["open", "-a", editor.app, "--", file]
      }
      if (process.platform === "linux" && editor.app) {
        return [editor.app, file]
      }
      return null
    }

    /** Launch the editor detached from the TUI; the child outlives us. */
    function launchEditor(editor: EditorOption, absPath: string): boolean {
      const argv = editorArgv(editor, absPath)
      if (!argv) {
        context.ui.toast.show({
          message: `找不到编辑器「${editor.label}」的可执行文件，请安装或换一个`,
          variant: "error",
        })
        return false
      }
      const child = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" })
      child.on("error", (err) => {
        context.ui.toast.show({
          message: `打开失败: ${(err as NodeJS.ErrnoException).message}`,
          variant: "error",
        })
      })
      child.unref()
      return true
    }

    /** Show the editor picker and persist the choice. */
    async function chooseEditor(): Promise<EditorOption | undefined> {
      const current = configuredEditor()
      const picked = await context.ui.dialog.select<EditorOption>({
        title: "选择本地编辑器",
        placeholder: "选择用于打开文件的编辑器（可随时用 /editor 更换）",
        current,
        options: EDITORS.map((e) => ({
          title: e.label,
          value: e,
          description: e.binary
            ? `命令行 ${e.binary} <文件>`
            : e.app
              ? `macOS 应用 ${e.app}`
              : undefined,
        })),
      })
      if (picked) {
        await updateSettings((d) => {
          d.editor = picked.id
        })
      }
      return picked
    }

    /** Open a path in the configured (or auto-detected) local editor. */
    async function openInEditor(input: string): Promise<void> {
      const resolved = resolveInsideProject(input)
      if (!resolved) {
        context.ui.toast.show({ message: `路径不在项目内: ${input}`, variant: "error" })
        return
      }
      const { abs, root } = resolved
      try {
        const info = await stat(abs)
        if (!info.isFile()) {
          context.ui.toast.show({ message: `不是文件: ${relative(root, abs)}`, variant: "warning" })
          return
        }
      } catch {
        context.ui.toast.show({ message: `文件不存在: ${relative(root, abs)}`, variant: "error" })
        return
      }

      let editor = configuredEditor()
      if (!editor) {
        editor = detectDefaultEditor()
        if (editor) {
          void updateSettings((d) => {
            d.editor = editor!.id
          })
        } else {
          editor = await chooseEditor()
          if (!editor) return
        }
      }
      setSelectedPath(abs)
      launchEditor(editor, abs)
    }

    /* ---------------- list selection ---------------- */

    /** Flat, ordered paths of the current tab — drives keyboard selection. */
    const visibleRows = createMemo<Array<{ path: string }>>(() => {
      const tab = activeTab()
      if (tab === "session") {
        return (sessionFiles()[currentSessionID()] ?? []).slice(0, SESSION_MAX).map((f) => ({ path: f.path }))
      }
      if (tab === "files") {
        return visibleTree().filter((n) => !n.isDir).map((n) => ({ path: n.path }))
      }
      const rows = activeScope() === "git" ? gitDiff() : sessionDiff()[currentSessionID()] ?? []
      return rows.map((c) => ({ path: c.file }))
    })

    function moveSelection(delta: number) {
      const rows = visibleRows()
      if (rows.length === 0) return
      const cur = rows.findIndex((r) => r.path === selectedPath())
      const base = cur >= 0 ? cur : 0
      const next = Math.max(0, Math.min(rows.length - 1, base + delta))
      setSelectedPath(rows[next].path)
      listRef?.scrollTo(Math.max(0, next - 2))
    }

    function openSelected() {
      const sel = selectedPath()
      if (sel) void openInEditor(sel)
    }

    /* ---------------- list rows ---------------- */

    /**
     * Empty state: a short title plus concrete next steps. Empty panels are where
     * users get stuck, so say what to do rather than just reporting "nothing here".
     */
    const EmptyState = (props: { title: string; hint?: string[] }) => (
      <box paddingX={3} paddingY={1} flexDirection="column" gap={0}>
        <text fg={textMuted()}>{props.title}</text>
        <For each={props.hint ?? []}>
          {(line) => (
            <text fg={textMuted()}>
              {"· "}
              {line}
            </text>
          )}
        </For>
      </box>
    )

    /** Semantic colour for a file-type glyph. */
    function familyColor(name: string): unknown {
      switch (fileFamily(name)) {
        case "code":
          return th().syntax?.type ?? accent()
        case "doc":
          return th().syntax?.string ?? textBase()
        case "config":
          return th().syntax?.keyword ?? accent()
        case "style":
          return th().syntax?.function ?? accent()
        case "data":
          return th().syntax?.number ?? accent()
        case "media":
          return th().syntax?.type ?? accent()
        default:
          return textMuted()
      }
    }

    /** Colour for a git status letter. */
    function statusColor(status: string | undefined) {
      switch ((status ?? "").toLowerCase()) {
        case "added":
        case "a":
        case "?":
          return diffAdded()
        case "deleted":
        case "d":
          return diffRemoved()
        case "renamed":
        case "r":
          return th().syntax?.type ?? textMuted()
        default:
          return accent() ?? textMuted()
      }
    }

    /**
     * One row of a flat file list. Clicking hands the file to the local editor;
     * the row stays highlighted so keyboard users know what Enter will open.
     */
    const FileRow = (props: {
      path: string
      label: string
      dir?: string
      glyph: string
      glyphColor?: unknown
      meta?: string
      metaColor?: unknown
    }) => {
      const selected = () => selectedPath() === props.path
      return (
        <box
          flexDirection="row"
          alignItems="center"
          gap={1}
          paddingRight={1}
          backgroundColor={selected() ? surfaceRaised() : undefined}
          onMouseDown={click(() => {
            setSelectedPath(props.path)
            void openInEditor(props.path)
          })}
        >
          <text fg={selected() ? accent() : undefined}>{selected() ? CURSOR : " "}</text>
          <text fg={props.glyphColor ?? textMuted()}>{props.glyph}</text>
          <text fg={selected() ? textBase() : textMuted()} wrapMode="none">
            {truncate(props.label, 26)}
          </text>
          <Show when={props.dir}>
            <text fg={textMuted()} wrapMode="none">
              {truncate(props.dir ?? "", 16)}
            </text>
          </Show>
          <box flexGrow={1} />
          <Show when={props.meta}>
            <text fg={props.metaColor ?? textMuted()}>{props.meta}</text>
          </Show>
        </box>
      )
    }

    const SessionList = () => {
      const files = () => sessionFiles()[currentSessionID()] ?? []
      const root = () => projectRoot()
      return (
        <box flexDirection="column" gap={0}>
          <Show when={files().length === 0}>
            <EmptyState
              title="本会话还没有涉及文件"
              hint={["用 @ 引用文件，或让 AI 读取 / 创建文件", "点击文件用本地编辑器打开"]}
            />
          </Show>
          <For each={files().slice(0, SESSION_MAX)}>
            {(f) => (
              <FileRow
                path={f.path}
                label={basename(f.path)}
                dir={truncate(dirname(relative(root(), f.path)) || ".", 18)}
                glyph={fileBadge(f.path)}
                glyphColor={familyColor(f.path)}
                meta={f.hits > 1 ? `×${f.hits}` : undefined}
              />
            )}
          </For>
          <Show when={files().length > SESSION_MAX}>
            <box paddingX={3} paddingY={1}>
              <text fg={textMuted()}>
                … 其余 {files().length - SESSION_MAX} 个 · 切到「文件」标签浏览全部
              </text>
            </box>
          </Show>
        </box>
      )
    }

    const TreeList = () => (
      <box flexDirection="column" gap={0}>
        <For each={visibleTree()}>
          {(node) => {
            const selected = () => selectedPath() === node.path
            return (
              <box
                flexDirection="row"
                alignItems="center"
                gap={1}
                paddingRight={1}
                backgroundColor={selected() ? surfaceRaised() : undefined}
                onMouseDown={click(() => {
                  if (node.isDir) toggleDir(node.path)
                  else {
                    setSelectedPath(node.path)
                    void openInEditor(node.path)
                  }
                })}
              >
                <text fg={selected() ? accent() : undefined}>{selected() ? CURSOR : " "}</text>
                {/* Indent doubles as a guide rail so nesting stays legible. */}
                <text fg={textMuted()}>
                  {node.depth === 0 ? "" : `${"│ ".repeat(node.depth - 1)}${INDENT}`}
                </text>
                <text fg={selected() ? accent() : textMuted()}>
                  {node.isDir ? (expanded().has(node.path) ? "▾" : "▸") : fileBadge(node.name)}
                </text>
                <text fg={selected() ? textBase() : textMuted()} wrapMode="none">
                  {truncate(node.name, 30)}
                </text>
              </box>
            )
          }}
        </For>
        <Show when={visibleTree().length === 0}>
          <Show
            when={treeCache()[projectRoot()]}
            fallback={
              <box paddingX={3} paddingY={1}>
                <text fg={textMuted()}>正在加载项目…</text>
              </box>
            }
          >
            <EmptyState
              title={filter() ? "无匹配文件" : "空目录"}
              hint={filter() ? [`没有名称包含「${filter()}」的文件`] : ["这个目录下没有可显示的文件"]}
            />
          </Show>
        </Show>
      </box>
    )

    const ChangeList = () => {
      const rows = () => (activeScope() === "git" ? gitDiff() : sessionDiff()[currentSessionID()] ?? [])
      return (
        <box flexDirection="column" gap={0}>
          <Show when={rows().length === 0}>
            <EmptyState
              title={activeScope() === "git" ? "工作区没有未提交变更" : "本会话还没有文件改动"}
              hint={
                activeScope() === "git"
                  ? ["提交后这里会清空", "按 s 切回「本轮」查看本会话改动"]
                  : ["让 AI 编辑文件后这里会出现 diff", "按 s 切到「全部」查看工作区变更"]
              }
            />
          </Show>
          <For each={rows()}>
            {(c) => (
              <FileRow
                path={c.file}
                label={basename(c.file)}
                dir={truncate(dirname(relative(projectRoot(), c.file)) || ".", 18)}
                glyph="●"
                glyphColor={statusColor(c.status)}
                meta={`+${c.additions} -${c.deletions}`}
              />
            )}
          </For>
        </box>
      )
    }

    /* ---------------- panel ---------------- */

    let listRef: ScrollBoxRenderable | undefined
    const SCROLL_ACCEL = new MacOSScrollAccel()

    let lastSync = ""
    const syncPanel = (sessionID: string) => {
      if (!sessionID || sessionID === lastSync) return
      lastSync = sessionID
      void collectSessionFiles(sessionID)
      void collectSessionDiff(sessionID)
      void collectGitDiff()
    }

    const TABS: Array<{ id: PanelTab; label: string }> = [
      { id: "session", label: "会话" },
      { id: "files", label: "文件" },
      { id: "changes", label: "变动" },
    ]

    context.ui.slot({
      append: "session.panel",
      render: (panel) => {
        // The keymap provider only exists inside a render, so register here.
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "right-preview.fullscreen",
              title: "Toggle file panel fullscreen",
              group: "Right Preview",
              bind: "f",
              run: () => panel.toggleFullscreen(),
            },
            {
              id: "right-preview.next-tab",
              title: "Next panel view (session / files / changes)",
              group: "Right Preview",
              bind: "t",
              run: () =>
                updateSettings((d) => {
                  const at = TABS.findIndex((x) => x.id === d.tab)
                  d.tab = TABS[(at + 1) % TABS.length].id
                }),
            },
            {
              id: "right-preview.toggle-scope",
              title: "Toggle change scope (this session / whole tree)",
              group: "Right Preview",
              bind: "s",
              run: () =>
                updateSettings((d) => {
                  d.scope = d.scope === "session" ? "git" : "session"
                }),
            },
            {
              id: "right-preview.select-up",
              title: "Move file selection up",
              group: "Right Preview",
              bind: "up",
              enabled: () => panel.focused,
              run: () => moveSelection(-1),
            },
            {
              id: "right-preview.select-down",
              title: "Move file selection down",
              group: "Right Preview",
              bind: "down",
              enabled: () => panel.focused,
              run: () => moveSelection(1),
            },
            {
              id: "right-preview.open-selected",
              title: "Open selected file in editor",
              group: "Right Preview",
              bind: "enter",
              enabled: () => panel.focused,
              run: () => openSelected(),
            },
            {
              id: "right-preview.list-scroll-up",
              title: "Scroll file list up",
              group: "Right Preview",
              bind: "ctrl+p",
              enabled: () => panel.focused,
              run: () => listRef?.scrollBy(-1, "step"),
            },
            {
              id: "right-preview.list-scroll-down",
              title: "Scroll file list down",
              group: "Right Preview",
              bind: "ctrl+n",
              enabled: () => panel.focused,
              run: () => listRef?.scrollBy(1, "step"),
            },
            {
              id: "right-preview.close",
              title: "Close file panel",
              group: "Right Preview",
              bind: "escape",
              enabled: () => panel.focused,
              run: () => context.ui.panel.close(),
            },
          ],
        }))

        if (panel.name === PANEL_NAME && panel.sessionID) syncPanel(panel.sessionID)

        return (
          <Show when={panel.name === PANEL_NAME}>
            <box flexDirection="column" width="100%" height="100%" gap={0}>
              {/* Tab bar; the active tab sits on a raised pill, and the chosen
                  editor is shown at the right edge — click it to switch. */}
              <box
                flexDirection="row"
                gap={1}
                alignItems="center"
                flexShrink={0}
                height={1}
                paddingLeft={1}
                paddingRight={1}
                backgroundColor={surfaceRaised()}
              >
                <For each={TABS}>
                  {(t) => (
                    <box
                      paddingX={1}
                      backgroundColor={activeTab() === t.id ? surfaceActive() : undefined}
                      onMouseDown={click(() => updateSettings((d) => void (d.tab = t.id)))}
                    >
                      <text fg={activeTab() === t.id ? accent() : textMuted()}>{t.label}</text>
                    </box>
                  )}
                </For>
                <box flexGrow={1} />
                <box onMouseDown={click(() => { void chooseEditor() })}>
                  <text fg={configuredEditor() ? accent() : textMuted()}>
                    {configuredEditor()?.label ?? "选择编辑器"} ▾
                  </text>
                </box>
                <text fg={textMuted()} onMouseDown={click(() => panel.toggleFullscreen())}>
                  {panel.presentation === "fullscreen" ? "还原" : "全屏"}
                </text>
                <text fg={textMuted()} onMouseDown={click(() => context.ui.panel.close())}>
                  ✕
                </text>
              </box>

              {/* secondary controls */}
              <box flexDirection="row" gap={2} alignItems="center" paddingX={2} paddingTop={1} flexShrink={0}>
                <Show
                  when={activeTab() === "files"}
                  fallback={
                    <Show when={activeTab() === "changes"}>
                      <box onMouseDown={click(() => updateSettings((d) => void (d.scope = "session")))}>
                        <text fg={activeScope() === "session" ? accent() : textMuted()}>
                          {activeScope() === "session" ? "●" : "○"} 本轮
                        </text>
                      </box>
                      <box onMouseDown={click(() => updateSettings((d) => void (d.scope = "git")))}>
                        <text fg={activeScope() === "git" ? accent() : textMuted()}>
                          {activeScope() === "git" ? "●" : "○"} 全部
                        </text>
                      </box>
                    </Show>
                  }
                >
                  <input
                    value={filter()}
                    placeholder="过滤文件…"
                    focused={activeTab() === "files"}
                    onInput={(e: any) => setFilter(e?.value ?? e ?? "")}
                    onSubmit={() => undefined}
                  />
                </Show>
              </box>

              {/* File list — the whole panel body now. Clicking a file opens it
                  in the local editor; the panel itself never renders content. */}
              <scrollbox
                ref={listRef}
                scrollY
                stickyScroll
                scrollAcceleration={SCROLL_ACCEL}
                flexGrow={1}
                flexShrink={1}
              >
                <Show when={activeTab() === "session"}>
                  <SessionList />
                </Show>
                <Show when={activeTab() === "files"}>
                  <TreeList />
                </Show>
                <Show when={activeTab() === "changes"}>
                  <ChangeList />
                </Show>
              </scrollbox>
            </box>
          </Show>
        )
      },
    })

    /* ---------------- commands ---------------- */

    context.ui.slot({
      append: "app",
      render: () => {
        context.keymap.layer(() => ({
          mode: "global",
          priority: 10,
          commands: [
            {
              id: "right-preview.toggle",
              title: "Open the file panel (session / files / changes)",
              description: "Toggle the panel, or open a file directly with /preview <path>",
              group: "Right Preview",
              bind: "<leader>p",
              palette: true,
              suggested: true,
              slash: { name: "preview", aliases: ["preview-file"], arguments: true },
              run: async (input) => {
                const arg = parsePreviewArg(input)
                if (arg) {
                  await openInEditor(arg)
                  return
                }
                if (context.ui.panel.current()?.name === PANEL_NAME) {
                  context.ui.panel.close()
                  return
                }
                if (!context.ui.panel.open(PANEL_NAME)) {
                  context.ui.toast.show({ message: "请先进入一个会话", variant: "warning" })
                }
              },
            },
            {
              id: "right-preview.choose-editor",
              title: "选择打开文件的本地编辑器",
              description: "Pick which local editor the panel hands files to",
              group: "Right Preview",
              bind: "<leader>e",
              palette: true,
              suggested: true,
              slash: { name: "editor", aliases: ["choose-editor"] },
              run: () => {
                void chooseEditor()
              },
            },
          ],
          bindings: ["right-preview.toggle", "right-preview.choose-editor"],
        }))
        return <></>
      },
    })

    /* ---------------- cleanup ---------------- */

    return () => {
      for (const stop of stops) {
        try {
          stop()
        } catch {
          /* ignore */
        }
      }
    }
  },
})