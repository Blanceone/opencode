import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import solidPlugin from "vite-plugin-solid"
import tailwindcss from "@tailwindcss/vite"
import { fileURLToPath } from "url"

const theme = fileURLToPath(new URL("./public/oc-theme-preload.js", import.meta.url))

// Resolve @opencode-ai/client from the openwiki package's own dependency tree
// (the workspace-generated client) instead of app's vendored tarball.
const openwikiClientEntry = createRequire(
  fileURLToPath(new URL("../openwiki/src/http-client.js", import.meta.url)),
).resolve("@opencode-ai/client")

const channel = (() => {
  const raw = process.env.OPENCODE_CHANNEL
  if (raw === "dev" || raw === "beta" || raw === "prod") return raw
  if (process.env.OPENCODE_CHANNEL === "latest") return "prod"
  return "dev"
})()

/**
 * @type {import("vite").PluginOption}
 */
export default [
  {
    name: "opencode-desktop:config",
    config() {
      return {
        resolve: {
          alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
          },
        },
        define: {
          "import.meta.env.VITE_OPENCODE_CHANNEL": JSON.stringify(channel),
        },
        worker: {
          format: "es",
        },
      }
    },
  },
  {
    name: "opencode-desktop:theme-preload",
    transformIndexHtml(html) {
      return html.replace(
        '<script id="oc-theme-preload-script" src="/oc-theme-preload.js"></script>',
        `<script id="oc-theme-preload-script">${readFileSync(theme, "utf8")}</script>`,
      )
    },
  },
  {
    // App pins @opencode-ai/client to a vendored tarball that predates the openwiki
    // API. Vite's dependency optimizer dedupes the bare specifier to that copy and
    // strips OpenCode.make(...).openwikis from the wiki panel, so re-resolve the
    // openwiki adapter's import from its own package, which depends on the
    // workspace-generated client that includes the openwiki endpoints.
    name: "opencode-desktop:openwiki-client",
    enforce: "pre",
    resolveId(source, importer) {
      if (source !== "@opencode-ai/client" || !importer) return
      if (!/[\\/]packages[\\/]openwiki[\\/]/.test(importer)) return
      return openwikiClientEntry
    },
  },
  tailwindcss(),
  solidPlugin(),
]
