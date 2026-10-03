import { Plugin } from "@opencode/plugin"

/**
 * Server-side plugin entry.
 *
 * This plugin is TUI-only; the server stub exists so the package is
 * registered as a plugin and shows up in `opencode --print-logs plugin list`.
 */
export default Plugin.define({
  id: "right-preview.server",
  setup() {},
})