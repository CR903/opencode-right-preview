import { build } from "bun"
import solidPlugin from "@opentui/solid/bun-plugin"

/**
 * Compile the plugin to plain JS before publishing.
 *
 * opencode loads npm-published TUI plugins through the package's `exports["./tui"]`
 * subpath. If that points at a `.tsx` file, the host's bundler applies its default
 * (React) JSX runtime and fails with "Cannot find package 'react'". Shipping
 * pre-compiled JS — JSX already lowered to Solid's `jsx()` calls — sidesteps the
 * host bundler entirely and matches the official packaging convention
 * (`packages/plugin/test/host.test.ts` uses `"./tui": "./dist/terminal.js"`).
 */
const result = await build({
  entrypoints: ["index.ts", "tui.tsx"],
  outdir: "dist",
  target: "bun",
  format: "esm",
  packages: "external",
  plugins: [solidPlugin],
})

if (!result.success) {
  for (const log of result.logs) console.error(log)
  process.exit(1)
}
console.log("✓ built dist/index.js dist/tui.js")