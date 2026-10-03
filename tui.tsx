import { Plugin } from "@opencode/plugin/tui"
import { SyntaxStyle, MacOSScrollAccel, pathToFiletype } from "@opentui/core"
import type { ScrollBoxRenderable } from "@opentui/core"
import { createEffect, createMemo, createSignal, For, Show } from "solid-js"
import { existsSync } from "node:fs"
import { readdir, readFile, stat } from "node:fs/promises"
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
  patch: string
  additions: number
  deletions: number
  status: string
}

interface OpenFile {
  path: string
  rel: string
  content: string
  total: number
  size: number
  truncated: boolean
}

interface TreeNode {
  name: string
  path: string
  isDir: boolean
  depth: number
}

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

const PANEL_NAME = "right-preview"
/** Storage key carries a version suffix so old shapes never leak in. */
const STORE_KEY = "right-preview.v3"

/** Hard ceiling on a single file read. */
const MAX_BYTES = 1024 * 1024
/** Hard ceiling on lines rendered; beyond this the file is truncated. */
const MAX_LINES = 5000
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

/** Directories never worth showing in a file tree. */
const NOISE_DIRS = new Set([
  "node_modules", ".git", ".next", ".cache", "dist", "build", "out",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache",
  "coverage", ".turbo", ".svelte-kit", ".gradle", "target", "vendor",
  "DerivedData",
])

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

/** Compact human-readable file size. */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}M`
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

/** True when the host `<markdown>` renderer should handle this file. */
function isMarkdown(path: string): boolean {
  const ext = extname(path).toLowerCase()
  return ext === ".md" || ext === ".mdx" || ext === ".markdown"
}

/**
 * Tree-sitter grammar name for a file path.
 *
 * Must be a *grammar name* (`typescript`, `tsx`, `javascript`), never a bare
 * extension — `ts` and `js` have no grammar. The host ships the authoritative
 * extension→grammar table (including basenames like `Dockerfile`), so use it
 * rather than hand-rolling one that drifts.
 */
function highlightType(path: string): string {
  try {
    return pathToFiletype(basename(path)) ?? ""
  } catch {
    return ""
  }
}

/**
 * Bound the cost of a single line.
 *
 * Minified JSON and data blobs are one enormous line that tokenises into tens of
 * thousands of pieces. Uncapped, the view builds a renderable per piece and takes
 * the terminal down with it — so collapse the overflow instead of exploding.
 */
function capTokens(tokens: Token[]): Token[] {
  const wasClipped = tokens.length > MAX_TOKENS_PER_LINE
  if (wasClipped) tokens = tokens.slice(0, MAX_TOKENS_PER_LINE)

  const last = tokens[tokens.length - 1]
  const tail = last?.text ?? ""
  const merged = tokens.slice(0, -1)
  const head = last ? last.text.slice(0, Math.max(0, MAX_LINE_CHARS - tail.length)) : ""

  if (wasClipped) {
    merged.push({ kind: "plain", text: `${head} …（本行过长，已折叠）` })
    return merged
  }
  if (last && head.length < tail.length) {
    merged.push({ kind: last.kind, text: `${head} …` })
    return merged
  }
  return tokens
}

/** Left-rail cursor marking the selected row. */
const CURSOR = "▌"
/** Lines rendered on first paint, and added per "load more". */
const CHUNK_LINES = 400
/** Hard ceiling on rendered lines regardless of how much is loaded. */
const MAX_RENDER_LINES = 5000
/** Characters of a single line rendered. Guards minified JSON and data blobs. */
const MAX_LINE_CHARS = 4000
/** Coloured tokens per line; the remainder collapses into one plain token. */
const MAX_TOKENS_PER_LINE = 400

/* ------------------------------------------------------------------ */
/* Syntax highlighting                                                 */
/* ------------------------------------------------------------------ */

/**
 * The host `<code>` renderer delegates to a global tree-sitter client that is not
 * initialised for plugin-rendered views: `highlightOnce()` yields nothing and it
 * **silently falls back to flat, uncoloured text** (verified on v2.0.20 — even
 * with a valid grammar name and a `SyntaxStyle`, output stays one colour).
 *
 * Colour is the entire point of this panel, so tokenise here and paint spans with
 * the host theme's own `theme.syntax` tokens — highlighting then always tracks the
 * user's chosen colours instead of being dropped on the floor.
 */

type TokenKind =
  | "keyword" | "string" | "comment" | "number"
  | "function" | "type" | "variable" | "operator" | "punctuation" | "plain"

interface Token {
  kind: TokenKind
  text: string
}

/** Keywords shared across the languages worth highlighting. */
const KEYWORDS = new Set([
  "abstract", "as", "async", "await", "break", "case", "catch", "chan", "class",
  "const", "constructor", "continue", "debugger", "declare", "default", "defer",
  "def", "delete", "do", "elif", "else", "enum", "export", "extends", "fallthrough",
  "false", "finally", "fn", "for", "from", "func", "function", "get", "global",
  "go", "goto", "if", "impl", "implements", "import", "in", "instanceof",
  "interface", "is", "lambda", "let", "map", "match", "mod", "module", "mut",
  "namespace", "new", "nil", "not", "null", "of", "or", "package", "pass",
  "priv", "private", "protected", "pub", "public", "raise", "range", "readonly",
  "return", "select", "self", "set", "static", "struct", "super", "switch",
  "this", "throw", "trait", "true", "try", "type", "typedef", "typeof",
  "undefined", "union", "unsafe", "use", "using", "var", "void", "where",
  "while", "with", "yield",
])

/** Languages whose line comment starts with `#`. */
const HASH_COMMENT = new Set([
  "python", "ruby", "bash", "shell", "sh", "zsh", "yaml", "toml", "r", "julia",
  "perl", "make", "dockerfile", "conf", "ini", "elixir", "nix",
])

/** Languages supporting `//` line comments and `/* *\/` block comments. */
const SLASH_COMMENT = new Set([
  "typescript", "typescriptreact", "javascript", "javascriptreact", "java",
  "c", "cpp", "csharp", "go", "rust", "php", "swift", "kotlin", "scala",
  "dart", "css", "less", "scss", "json", "jsonc", "zig", "solidity",
  "proto", "groovy", "vue", "svelte", "astro",
])

/**
 * Build a line tokeniser for one file.
 *
 * A closure rather than a plain function because `/* *\/` block comments span
 * lines: without carrying that state, the body of a JSDoc block gets tokenised as
 * code and reads as a wall of meaningless punctuation.
 *
 * One ordered regex beats a chain of `indexOf` scans: a single pass, and comment
 * and string bodies get consumed whole so keywords inside them are never
 * mis-tagged. Group order *is* the precedence order.
 */
function makeTokenizer(lang: string): (line: string) => Token[] {
  const supportsBlock = SLASH_COMMENT.has(lang)
  let inBlockComment = false

  const parts: string[] = []
  const groups: string[] = []

  if (supportsBlock) {
    groups.push("cmt")
    parts.push("(\\/\\/[^\\n]*|\\/\\*.*?(?:\\*\\/|$))")
  }
  if (HASH_COMMENT.has(lang)) {
    groups.push("cmt")
    parts.push("(#[^\\n]*)")
  }
  groups.push("str", "num", "word", "op", "punct")
  parts.push(
    "(\"(?:[^\"\\\\]|\\\\.)*\"|'(?:[^'\\\\]|\\\\.)*'|`(?:[^`\\\\]|\\\\.)*`|'[^']*'?)",
    "\\b(\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b",
    "([A-Za-z_$][\\w$]*)",
    "([+\\-*/%=<>!&|^~?:@]+)",
    "([(){}\\[\\];,.])",
  )

  const pattern = new RegExp(parts.join("|"), "g")
  // `word` is a sentinel: identifiers need lookahead to pick their final kind.
  const SLOT_KIND: Record<string, TokenKind | "word"> = {
    cmt: "comment",
    str: "string",
    num: "number",
    word: "word",
    op: "operator",
    punct: "punctuation",
  }
  const kindOf = groups.map((g) => SLOT_KIND[g] ?? "plain")

  return (line: string): Token[] => {
    // Continuation of a block comment opened on an earlier line.
    if (inBlockComment) {
      const end = line.indexOf("*/")
      if (end === -1) return capTokens([{ kind: "comment", text: line }])
      inBlockComment = false
      const head: Token[] = [{ kind: "comment", text: line.slice(0, end + 2) }]
      const rest = line.slice(end + 2)
      if (rest !== "") head.push(...tokenize(rest, pattern, kindOf, line, end + 2))
      return capTokens(head)
    }

    const tokens: Token[] = []
    let last = 0
    let match: RegExpExecArray | null

    while ((match = pattern.exec(line)) !== null) {
      const [text] = match
      if (match.index > last) tokens.push({ kind: "plain", text: line.slice(last, match.index) })

      let kind: TokenKind = "plain"
      for (let g = 1; g < match.length; g++) {
        if (match[g] === undefined) continue
        const slot = kindOf[g - 1]
        if (slot === "word") {
          if (KEYWORDS.has(text)) kind = "keyword"
          else if (/^[A-Z]/.test(text)) kind = "type"
          else if (line[match.index + text.length] === "(") kind = "function"
          else kind = "variable"
        } else {
          kind = slot as TokenKind
        }
        break
      }

      // An unterminated `/*` means the comment continues onto the next line.
      if (kind === "comment" && supportsBlock && text.startsWith("/*") && !text.includes("*/")) {
        inBlockComment = true
      }
      tokens.push({ kind, text })

      // A zero-length match would spin forever.
      if (text.length === 0) pattern.lastIndex++
      last = match.index + text.length
    }
    if (last < line.length) tokens.push({ kind: "plain", text: line.slice(last) })
    return capTokens(tokens)
  }

  /** Shared scan body, used for the tail of a line after a block comment ends. */
  function tokenize(
    line: string,
    pat: RegExp,
    kinds: Array<TokenKind | "word">,
    full: string,
    offset: number,
  ): Token[] {
    pat.lastIndex = 0
    const out: Token[] = []
    let last = 0
    let match: RegExpExecArray | null
    while ((match = pat.exec(line)) !== null) {
      const [text] = match
      if (match.index > last) out.push({ kind: "plain", text: line.slice(last, match.index) })
      let kind: TokenKind = "plain"
      for (let g = 1; g < match.length; g++) {
        if (match[g] === undefined) continue
        const slot = kinds[g - 1]
        if (slot === "word") {
          if (KEYWORDS.has(text)) kind = "keyword"
          else if (/^[A-Z]/.test(text)) kind = "type"
          else if (full[offset + match.index + text.length] === "(") kind = "function"
          else kind = "variable"
        } else kind = slot as TokenKind
        break
      }
      out.push({ kind, text })
      if (text.length === 0) pat.lastIndex++
      last = match.index + text.length
    }
    if (last < line.length) out.push({ kind: "plain", text: line.slice(last) })
    return capTokens(out)
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

/**
 * Extract the file path from a command's argument.
 *
 * The palette hands `run` a bare path, but a slash command with
 * `arguments: true` receives the whole raw prompt line — `/preview a/b.ts`.
 */
function parsePreviewArg(raw: string | undefined): string | null {
  const text = (raw ?? "").trim()
  if (!text) return null
  if (!text.startsWith("/")) return text
  return text.replace(/^\/[A-Za-z0-9:_-]+/, "").trim() || null
}

/**
 * Input keys that actually carry a file path.
 *
 * Deliberately a whitelist: tools also pass free-form strings (`command` on
 * `shell`/`bash`), and treating those as paths turns `git diff HEAD -- a.txt`
 * into a bogus file entry.
 */
const PATH_KEYS = new Set([
  "filePath", "file_path", "filepath", "file", "path",
  "notebook_path", "notebookPath", "targetFile", "target_file", "filename",
])

/**
 * Dig a filesystem path out of a tool's input object. Tools nest their inputs
 * (`{"edits": [{"filePath": ...}]}`), so recurse — but only ever accept a string
 * found under a known path key.
 */
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

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export default Plugin.define({
  id: "right-preview.tui",
  setup(context) {
    /* ---------------- state ---------------- */

    const [settings, updateSettings] = context.storage.store(STORE_KEY, {
      initial: {
        lastFile: "",
        tab: "session" as PanelTab,
        scope: "session" as ChangeScope,
        diffView: "unified" as "unified" | "split",
        listPct: 40,
      },
    })

    /** Files the AI referenced or touched, keyed by session. */
    const [sessionFiles, setSessionFiles] = createSignal<Record<string, SessionFile[]>>({})
    /** This session's diff, keyed by session. */
    const [sessionDiff, setSessionDiff] = createSignal<Record<string, DiffEntry[]>>({})
    /** The whole working tree's diff. */
    const [gitDiff, setGitDiff] = createSignal<DiffEntry[]>([])

    const [openFile, setOpenFile] = createSignal<OpenFile | null>(null)
    const [showDiff, setShowDiff] = createSignal(false)
    const [loading, setLoading] = createSignal(false)
    const [filter, setFilter] = createSignal("")
    /** Full-screen popup viewer for the current file. */
    const [modalOpen, setModalOpen] = createSignal(false)

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
    // Declared up front because `createMemo` bodies below run immediately.
    const activeTab = () => settings.tab
    const activeScope = () => settings.scope

    /* ---------------- theme ---------------- */

    const th = () => context.theme as Record<string, any>
    const textBase = () => (th().text?.base ?? th().text?.default ?? "#ffffff")
    const textMuted = () => (th().text?.muted ?? th().text?.subdued ?? "#888888")
    const surfaceRaised = () => th().background?.raised?.base
    /** Slightly stronger than `raised`, for the active tab pill. */
    const surfaceActive = () => th().background?.selected?.base ?? th().surface?.base ?? th().background?.raised?.base
    const diffAdded = () => th().diff?.text?.added ?? "#4ade80"
    const diffRemoved = () => th().diff?.text?.removed ?? "#f87171"
    const accent = () => th().hue?.accent?.[500] ?? th().syntax?.keyword ?? textBase()

    /**
     * Token colours come straight from the host theme (`theme.syntax`), so the
     * panel's code view stays in step with whatever theme the user is running
     * instead of hardcoding a palette that clashes with it.
     */
    const syntaxColor = (kind: TokenKind): unknown => {
      const syntax = th().syntax ?? {}
      switch (kind) {
        case "keyword":
          return colorOf(syntax.keyword) ?? accent()
        case "string":
          return colorOf(syntax.string) ?? textBase()
        case "comment":
          return colorOf(syntax.comment) ?? textMuted()
        case "number":
          return colorOf(syntax.number) ?? textBase()
        case "function":
          return colorOf(syntax.function) ?? accent()
        case "type":
          return colorOf(syntax.type) ?? accent()
        case "variable":
          return colorOf(syntax.variable) ?? textBase()
        case "operator":
          return colorOf(syntax.operator) ?? textMuted()
        case "punctuation":
          return colorOf(syntax.punctuation) ?? textMuted()
        default:
          return textBase()
      }
    }

    /**
     * `SyntaxStyle` for the host's `<markdown>` and `<diff>` renderers.
     *
     * The host resolves styles by *scope name*, and markdown uses a completely
     * different namespace from code: `markup.heading`, `markup.strong`,
     * `markup.link`, … Registering only `theme.syntax` (comment/keyword/string/…)
     * leaves every markdown scope unresolved, which is why a `.md` file rendered
     * as one flat run of text with no emphasis, headings or link styling.
     *
     * So: code scopes verbatim from the theme, plus the `markup.*` set mapped onto
     * the closest theme tokens so markdown still tracks the user's colours.
     */
    const syntaxStyle = createMemo(() => {
      try {
        const t = th()
        const syntax = t.syntax ?? {}
        const styles: Array<{ scope: string[]; style: Record<string, unknown> }> = []

        for (const [scope, value] of Object.entries(syntax)) {
          const fg = colorOf(value)
          if (fg) styles.push({ scope: [scope], style: { foreground: fg } })
        }

        const base = colorOf(t.text?.base)
        const muted = colorOf(t.text?.muted)
        const link = colorOf(syntax.function) ?? colorOf(syntax.type)
        const raw = colorOf(syntax.string)
        const keyword = colorOf(syntax.keyword)
        const comment = colorOf(syntax.comment)

        const markup: Array<[string, Record<string, unknown> | undefined]> = [
          ["heading", { foreground: keyword ?? base, bold: true }],
          ["strong", { foreground: base, bold: true }],
          ["italic", { foreground: muted, italic: true }],
          ["em", { foreground: muted, italic: true }],
          ["link", { foreground: link }],
          ["link.label", { foreground: link, underline: true }],
          ["link.url", { foreground: raw }],
          ["list", { foreground: muted }],
          ["quote", { foreground: comment ?? muted, italic: true }],
          ["raw", { foreground: raw }],
          ["strikethrough", { foreground: muted }],
        ]
        for (const [name, style] of markup) {
          if (style) styles.push({ scope: [`markup.${name}`], style })
        }

        return styles.length > 0 ? SyntaxStyle.fromTheme(styles as never) : SyntaxStyle.create()
      } catch {
        return SyntaxStyle.create()
      }
    })

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
          patch: typeof row.patch === "string" ? row.patch : "",
          additions: Number(row.additions ?? 0),
          deletions: Number(row.deletions ?? 0),
          status: typeof row.status === "string" ? row.status : "modified",
        })
      }
      return out
    }

    /** Files this session changed, with patches. */
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

    /* ---------------- open a file ---------------- */

    /**
     * Monotonic token for the in-flight load. Opening the panel restores the last
     * file while `/preview` may already be loading another one — without a guard
     * the slower of the two wins, so the requested file silently loses.
     */
    let loadSeq = 0

    async function openFileByPath(input: string) {
      const resolved = resolveInsideProject(input)
      if (!resolved) {
        context.ui.toast.show({ message: `路径不在项目内: ${input}`, variant: "error" })
        return
      }
      const { abs, root } = resolved
      const seq = ++loadSeq
      try {
        setLoading(true)
        const info = await stat(abs)
        if (seq !== loadSeq) return
        if (!info.isFile()) {
          context.ui.toast.show({ message: `不是文件: ${relative(root, abs)}`, variant: "warning" })
          return
        }
        const bySize = info.size > MAX_BYTES
        const raw = await readFile(abs, "utf-8")
        if (seq !== loadSeq) return
        const bytes = bySize ? Buffer.from(raw).subarray(0, MAX_BYTES).toString("utf-8") : raw
        const lines = bytes.split("\n")
        const byLines = lines.length > MAX_LINES
        setOpenFile({
          path: abs,
          rel: relative(root, abs),
          content: byLines ? lines.slice(0, MAX_LINES).join("\n") : bytes,
          total: lines.length,
          size: info.size,
          truncated: bySize || byLines,
        })
        void updateSettings((d) => {
          d.lastFile = abs
        })
      } catch (err) {
        if (seq !== loadSeq) return
        const code = (err as { code?: string })?.code
        context.ui.toast.show({
          message: code === "ENOENT" ? `文件不存在: ${relative(root, abs)}` : `读取失败: ${relative(root, abs)}`,
          variant: "error",
        })
      } finally {
        if (seq === loadSeq) setLoading(false)
      }
    }

    /** The diff for the currently open file, if any. */
    const patchFor = createMemo<string | undefined>(() => {
      const file = openFile()
      if (!file) return undefined
      const entries = activeScope() === "git" ? gitDiff() : sessionDiff()[currentSessionID()] ?? []
      return entries.find((e) => e.file === file.path)?.patch || undefined
    })

    /** Open the panel and show a file inside it. */
    function showInPanel(input: string) {
      if (!context.ui.panel.open(PANEL_NAME)) {
        context.ui.toast.show({ message: "请先进入一个会话", variant: "warning" })
        return
      }
      setShowDiff(false)
      void openFileByPath(input)
    }

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

    /**
     * One row of a flat file list.
     *
     * Hierarchy comes from three levels of emphasis rather than boxes and rules:
     * a left-rail cursor plus a raised background for the selected row, the
     * filename at full strength, and the trailing meta dimmed.
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
      const selected = () => openFile()?.path === props.path
      return (
        <box
          flexDirection="row"
          alignItems="center"
          gap={1}
          paddingRight={1}
          backgroundColor={selected() ? surfaceRaised() : undefined}
          onMouseDown={click(() => {
            setShowDiff(false)
            void openFileByPath(props.path)
          })}
        >
          <text fg={selected() ? accent() : undefined}>{selected() ? CURSOR : " "}</text>
          <text fg={props.glyphColor ?? textMuted()}>{props.glyph}</text>
          <text fg={selected() ? textBase() : textMuted()} wrap="none">
            {truncate(props.label, 26)}
          </text>
          <Show when={props.dir}>
            <text fg={textMuted()} wrap="none">
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
              hint={["用 @ 引用文件，或让 AI 读取 / 创建文件", "它们会自动出现在这里"]}
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
            const selected = () => openFile()?.path === node.path
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
                    setShowDiff(false)
                    void openFileByPath(node.path)
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
                <text fg={selected() ? textBase() : textMuted()} wrap="none">
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
      const rows = () =>
        activeScope() === "git" ? gitDiff() : sessionDiff()[currentSessionID()] ?? []
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

    /* ---------------- content area ---------------- */

    /**
     * Line-numbered, token-coloured source view.
     *
     * Colour is emitted as inline `<span>`s inside a single `<text>` per line, not
     * as one `<text>` renderable per token. Spans are cheap text nodes, whereas
     * renderables are not — a large JSON file tokenises into tens of thousands of
     * pieces, and one renderable each was enough to take the terminal down.
     *
     * Deliberately *not* `flexGrow`: inside a scroll container a growing child
     * stretches to the viewport instead of overflowing it, which silently
     * collapses the scroll range to zero and makes the file unscrollable.
     */
    const CodeView = (props: { content: string; path: string }) => {
      // Recreated per path, so block-comment state never leaks across files.
      const tokenize = createMemo(() => makeTokenizer(highlightType(props.path)))
      const all = createMemo(() => props.content.split("\n"))

      /**
       * Progressive reveal. Rendering every line up front is what made big files
       * unusable (and JSON crash outright), so start with a screenful's worth and
       * let the reader pull in more when they hit the bottom.
       */
      const [shown, setShown] = createSignal(CHUNK_LINES)
      createEffect(() => {
        // Reset the window whenever the file changes.
        props.path
        props.content
        setShown(CHUNK_LINES)
      })

      const limit = createMemo(() => Math.min(shown(), MAX_RENDER_LINES))
      const lines = createMemo(() => all().slice(0, limit()))
      const remaining = createMemo(() => all().length - limit())
      const gutter = createMemo(() => String(lines().length).length)

      return (
        <box flexDirection="column" flexShrink={0}>
          <For each={lines()}>
            {(line, i) => (
              <box flexDirection="row" flexShrink={0}>
                <text fg={textMuted()}>{String(i() + 1).padStart(gutter(), " ")} │ </text>
                <text wrap="none">
                  <For each={tokenize()(line)}>
                    {(token) => <span fg={syntaxColor(token.kind)}>{token.text}</span>}
                  </For>
                </text>
              </box>
            )}
          </For>

          <Show when={remaining() > 0}>
            <box
              flexDirection="row"
              gap={1}
              flexShrink={0}
              paddingX={2}
              paddingY={1}
              backgroundColor={surfaceRaised()}
              onMouseDown={click(() => setShown((n) => Math.min(n + CHUNK_LINES, all().length)))}
            >
              <text fg={accent()}>▸ 点击加载更多</text>
              <text fg={textMuted()}>
                已显示 {limit()} / {all().length} 行
              </text>
              <Show when={all().length > MAX_RENDER_LINES}>
                <text fg={textMuted()}>（上限 {MAX_RENDER_LINES} 行）</text>
              </Show>
            </box>
          </Show>
        </box>
      )
    }

    /**
     * Shared content renderer for the file body — used both by the inline panel
     * body and the full-screen popup, so a file looks the same in either view.
     */
    const FileContent = (props: { of: OpenFile; patch: string | undefined; showDiff: boolean }) => {
      return (
        <Show
          when={props.showDiff && props.patch}
          fallback={
            <Show
              when={isMarkdown(props.of.rel)}
              fallback={<CodeView content={props.of.content} path={props.of.rel} />}
            >
              <markdown content={props.of.content} syntaxStyle={syntaxStyle()} />
            </Show>
          }
        >
          {(p) => (
            <diff
              diff={p()}
              view={settings.diffView}
              syntaxStyle={syntaxStyle()}
              showLineNumbers
              wrapMode="none"
            />
          )}
        </Show>
      )
    }

    const ContentArea = () => {
      const patch = () => patchFor()
      return (
        <>
          <Show when={loading()}>
            <box paddingX={3} paddingY={1}>
              <text fg={textMuted()}>正在读取…</text>
            </box>
          </Show>

          <Show when={!loading() && openFile()}>
            {(of) => (
              <box flexDirection="column" flexGrow={1} flexShrink={1} gap={0}>
                {/* File header: name at full strength, meta dimmed and right-aligned.
                    `flexShrink={0}` is load-bearing — a shrinkable header gets
                    squeezed to zero rows and then paints over line 1. */}
                <box
                  flexDirection="row"
                  gap={1}
                  alignItems="center"
                  height={1}
                  flexShrink={0}
                  paddingLeft={2}
                  paddingRight={1}
                  backgroundColor={surfaceRaised()}
                >
                  <text fg={familyColor(of().rel)}>{fileBadge(of().rel)}</text>
                  <text fg={textBase()} wrap="none">
                    {truncate(of().rel, 30)}
                  </text>
                  <text fg={textMuted()} wrap="none">
                    {formatSize(of().size)} · {of().total} 行
                  </text>
                  <Show when={of().truncated}>
                    <text fg={accent()}>已截断</text>
                  </Show>
                  <box flexGrow={1} />
                  <Show when={patch()}>
                    <text fg={showDiff() ? accent() : textMuted()} onMouseDown={click(() => setShowDiff((v) => !v))}>
                      {showDiff() ? "内容" : "diff"}
                    </text>
                  </Show>
                  <text fg={textMuted()} onMouseDown={click(() => setModalOpen(true))}>
                    ⤢
                  </text>
                  <text fg={textMuted()} onMouseDown={click(() => setOpenFile(null))}>
                    ✕
                  </text>
                </box>

                {/* body */}
                <scrollbox
                  ref={bodyRef}
                  scrollY
                  stickyScroll
                  scrollAcceleration={SCROLL_ACCEL}
                  flexGrow={1}
                  flexShrink={1}
                  paddingX={1}
                >
                  <FileContent of={of()} patch={patch()} showDiff={showDiff()} />
                </scrollbox>
              </box>
            )}
          </Show>

          <Show when={!loading() && !openFile()}>
            <EmptyState
              title="从上方选择一个文件查看内容"
              hint={["t 切换视图 · s 切换范围 · f 全屏", "/preview <路径> 可直接打开"]}
            />
          </Show>
        </>
      )
    }

    /* ---------------- panel ---------------- */

    /**
     * Scroll handles for the two scrollable regions.
     *
     * `<scrollbox>` rather than `<box overflow="scroll">`: it owns a real
     * scrollbar (so it is *visible* that more content exists), handles the wheel,
     * and exposes `scrollBy`/`scrollTo` — which the keymap layer drives for
     * keyboard users. A plain overflow box gave no affordance and no keyboard path.
     */
    let listRef: ScrollBoxRenderable | undefined
    let bodyRef: ScrollBoxRenderable | undefined
    let modalRef: ScrollBoxRenderable | undefined

    /* ---------------- resizable splitter ---------------- */

    /** Height of the list area as a percentage of the panel. */
    const [listPct, setListPct] = createSignal(settings.listPct ?? 40)
    const [dragging, setDragging] = createSignal(false)
    let dragStartY = 0
    let dragLastY = 0
    let dragMoved = false
    let panelBox: { height?: number } | undefined

    const PRESETS = [25, 40, 55, 70]
    const clampPct = (v: number) => Math.max(15, Math.min(80, Math.round(v)))

    const persistPct = (value: number) =>
      updateSettings((d) => {
        d.listPct = value
      })

    /**
     * One gesture, three phases. A press that never moves is treated as a click and
     * cycles through preset heights, which keeps the splitter usable even if the
     * terminal does not deliver drag events.
     */
    const beginDrag = (e: { y: number; stopPropagation?: () => void; preventDefault?: () => void }) => {
      e?.stopPropagation?.()
      e?.preventDefault?.()
      dragStartY = e.y
      dragLastY = e.y
      dragMoved = false
      setDragging(true)
    }
    const moveDrag = (e: { y: number }) => {
      if (!dragging()) return
      if (Math.abs(e.y - dragStartY) > 0) dragMoved = true
      const dy = e.y - dragLastY
      if (dy === 0) return
      dragLastY = e.y
      const height = panelBox?.height ?? 0
      if (height <= 0) return
      // The divider must travel with the pointer: `y` grows downward, so dragging
      // down (dy > 0) enlarges the list above it. Negating here made the divider
      // move opposite to the drag.
      setListPct(clampPct(listPct() + (dy / height) * 100))
    }
    const endDrag = () => {
      if (!dragging()) return
      setDragging(false)
      if (!dragMoved) {
        const at = PRESETS.findIndex((p) => p >= listPct())
        const next = PRESETS[(at + 1) % PRESETS.length]
        setListPct(next)
        void persistPct(next)
        return
      }
      void persistPct(listPct())
    }

    /**
     * The divider. Move/up are bound on the panel root so the pointer does not have
     * to stay on this single row while dragging.
     */
    const Splitter = () => (
      <box
        flexShrink={0}
        height={1}
        alignItems="center"
        backgroundColor={dragging() ? surfaceActive() : undefined}
        onMouseDown={beginDrag}
      >
        <text fg={dragging() ? accent() : textMuted()}>
          {"──"} {dragging() ? "⠿ 拖动调整高度" : "⠿ 拖动/点击调整高度（当前 " + listPct() + "%）"} {"──"}
        </text>
      </box>
    )

    /**
     * Scroll acceleration for the trackpad.
     *
     * `scrollAcceleration` must be an *object* implementing `tick()`/`reset()` —
     * passing a string (e.g. `"fast"`) makes `ScrollBox.onMouseEvent()` throw on
     * `this.scrollAccel.tick(...)`, so wheel/trackpad scrolling silently stops
     * while dragging the scrollbar (a different code path) keeps working.
     * `MacOSScrollAccel` matches the host platform's native feel.
     */
    const SCROLL_ACCEL = new MacOSScrollAccel()

    /* ---------------- popup modal ---------------- */

    function scrollModal(delta: number) {
      modalRef?.scrollBy(delta, "line")
    }
    function jumpModal(to: "top" | "bottom") {
      if (!modalRef) return
      modalRef.scrollTo(to === "top" ? 0 : Math.max(0, modalRef.scrollHeight))
    }

    /**
     * Full-screen file viewer rendered at the `app` level so it overlays the
     * entire terminal, not just the panel column. Opened by the ⤢ button in the
     * file header; closes on Esc / q / the header ✕ button.
     *
     * `position="absolute"` + `zIndex` is the OpenTUI way to float above siblings:
     * the node is taken out of flex flow and pinned to the viewport origin.
     */
    const FileModal = () => (
      <Show when={modalOpen() && openFile()}>
        {(of) => (
          <box
            position="absolute"
            top={0}
            left={0}
            width="100%"
            height="100%"
            zIndex={9999}
            backgroundColor={th().background?.base ?? "#000000"}
            flexDirection="column"
          >
            {/* Modal header */}
            <box
              flexDirection="row"
              gap={1}
              alignItems="center"
              height={1}
              flexShrink={0}
              paddingLeft={2}
              paddingRight={1}
              backgroundColor={surfaceRaised()}
            >
              <text fg={familyColor(of().rel)}>{fileBadge(of().rel)}</text>
              <text fg={textBase()} wrap="none">{truncate(of().rel, 50)}</text>
              <text fg={textMuted()} wrap="none">
                {formatSize(of().size)} · {of().total} 行
              </text>
              <box flexGrow={1} />
              <text fg={textMuted()}>Esc / q 关闭</text>
              <text fg={accent()} onMouseDown={click(() => setModalOpen(false))}>✕</text>
            </box>

            {/* Modal body */}
            <scrollbox
              ref={modalRef}
              scrollY
              stickyScroll
              scrollAcceleration={SCROLL_ACCEL}
              flexGrow={1}
              flexShrink={1}
              paddingX={2}
            >
              <FileContent of={of()} patch={patchFor()} showDiff={showDiff()} />
            </scrollbox>
          </box>
        )}
      </Show>
    )

    /** Scroll whichever region the user is looking at. */
    function scrollBody(delta: number) {
      bodyRef?.scrollBy(delta, "line")
    }
    function scrollList(delta: number) {
      listRef?.scrollBy(delta, "line")
    }
    function jumpBody(to: "top" | "bottom") {
      if (!bodyRef) return
      bodyRef.scrollTo(to === "top" ? 0 : Math.max(0, bodyRef.scrollHeight))
    }

    const TABS: Array<{ id: PanelTab; label: string }> = [
      { id: "session", label: "会话" },
      { id: "files", label: "文件" },
      { id: "changes", label: "变动" },
    ]

    let lastSync = ""
    const syncPanel = (sessionID: string) => {
      if (!sessionID || sessionID === lastSync) return
      lastSync = sessionID
      void collectSessionFiles(sessionID)
      void collectSessionDiff(sessionID)
      void collectGitDiff()
      // Restore the last file, but only if it lives under *this* project's root.
      // The store is global and `projectRoots()` lists every project the user has
      // opened, so a looser check would reopen a path from the previous project.
      const remembered = settings.lastFile
      if (!remembered || openFile()) return
      const root = projectRoot()
      const rel = relative(root, remembered)
      if (!rel.startsWith("..") && !isAbsolute(rel) && existsSync(remembered)) {
        void openFileByPath(remembered)
      }
    }

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
              id: "right-preview.toggle-diff-view",
              title: "Toggle diff layout (unified / split)",
              group: "Right Preview",
              bind: "d",
              run: () =>
                updateSettings((d) => {
                  d.diffView = d.diffView === "unified" ? "split" : "unified"
                }),
            },
            {
              id: "right-preview.scroll-down",
              title: "Scroll file view down",
              group: "Right Preview",
              bind: "down",
              enabled: () => panel.focused,
              run: () => scrollBody(1),
            },
            {
              id: "right-preview.scroll-up",
              title: "Scroll file view up",
              group: "Right Preview",
              bind: "up",
              enabled: () => panel.focused,
              run: () => scrollBody(-1),
            },
            {
              id: "right-preview.page-down",
              title: "Scroll file view one page down",
              group: "Right Preview",
              bind: "pagedown",
              enabled: () => panel.focused,
              run: () => scrollBody(10),
            },
            {
              id: "right-preview.page-up",
              title: "Scroll file view one page up",
              group: "Right Preview",
              bind: "pageup",
              enabled: () => panel.focused,
              run: () => scrollBody(-10),
            },
            {
              id: "right-preview.to-top",
              title: "Jump to start of file",
              group: "Right Preview",
              bind: "g",
              enabled: () => panel.focused,
              run: () => jumpBody("top"),
            },
            {
              id: "right-preview.to-bottom",
              title: "Jump to end of file",
              group: "Right Preview",
              bind: "G",
              enabled: () => panel.focused,
              run: () => jumpBody("bottom"),
            },
            {
              id: "right-preview.list-down",
              title: "Scroll file list down",
              group: "Right Preview",
              bind: "ctrl+n",
              enabled: () => panel.focused,
              run: () => scrollList(1),
            },
            {
              id: "right-preview.list-up",
              title: "Scroll file list up",
              group: "Right Preview",
              bind: "ctrl+p",
              enabled: () => panel.focused,
              run: () => scrollList(-1),
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
            <box
              ref={panelBox}
              flexDirection="column"
              width="100%"
              height="100%"
              gap={0}
              onMouseMove={moveDrag}
              onMouseUp={endDrag}
              onMouseDrag={moveDrag}
              onMouseDragEnd={endDrag}
            >
              {/* Tab bar: the active tab sits on a raised pill so the current view
                  is readable at a glance without relying on colour alone. */}
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

              {/* list */}
              <scrollbox
                ref={listRef}
                scrollY
                stickyScroll
                scrollAcceleration={SCROLL_ACCEL}
                flexShrink={0}
                height={`${listPct()}%`}
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

              <Splitter />

              {/* content — the inner scrollbox owns scrolling; this wrapper must not
                  scroll too, or it becomes a nested viewport that squeezes the
                  file header to zero height and overlaps the first code line. */}
              <box flexDirection="column" flexGrow={1} flexShrink={1}>
                <ContentArea />
              </box>
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
              description: "Toggle the panel, or jump straight to a file with /preview <path>",
              group: "Right Preview",
              bind: "<leader>p",
              palette: true,
              suggested: true,
              slash: { name: "preview", aliases: ["preview-file"], arguments: true },
              run: async (input) => {
                const arg = parsePreviewArg(input)
                if (arg) {
                  showInPanel(arg)
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
            /* ---- popup modal: close + scroll, all gated on modalOpen() ---- */
            {
              id: "right-preview.modal-close-esc",
              title: "Close file popup",
              group: "Right Preview",
              bind: "escape",
              enabled: () => modalOpen(),
              run: () => setModalOpen(false),
            },
            {
              id: "right-preview.modal-close-q",
              title: "Close file popup",
              group: "Right Preview",
              bind: "q",
              enabled: () => modalOpen(),
              run: () => setModalOpen(false),
            },
            {
              id: "right-preview.modal-up",
              title: "Scroll popup up",
              group: "Right Preview",
              bind: "up",
              enabled: () => modalOpen(),
              run: () => scrollModal(-1),
            },
            {
              id: "right-preview.modal-down",
              title: "Scroll popup down",
              group: "Right Preview",
              bind: "down",
              enabled: () => modalOpen(),
              run: () => scrollModal(1),
            },
            {
              id: "right-preview.modal-pageup",
              title: "Scroll popup up (page)",
              group: "Right Preview",
              bind: "pageup",
              enabled: () => modalOpen(),
              run: () => scrollModal(-10),
            },
            {
              id: "right-preview.modal-pagedown",
              title: "Scroll popup down (page)",
              group: "Right Preview",
              bind: "pagedown",
              enabled: () => modalOpen(),
              run: () => scrollModal(10),
            },
            {
              id: "right-preview.modal-top",
              title: "Scroll popup to top",
              group: "Right Preview",
              bind: "g",
              enabled: () => modalOpen(),
              run: () => jumpModal("top"),
            },
            {
              id: "right-preview.modal-bottom",
              title: "Scroll popup to bottom",
              group: "Right Preview",
              bind: "G",
              enabled: () => modalOpen(),
              run: () => jumpModal("bottom"),
            },
          ],
          bindings: ["right-preview.toggle"],
        }))
        return <FileModal />
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