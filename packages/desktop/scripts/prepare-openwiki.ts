#!/usr/bin/env bun
/**
 * Stage OpenWiki bundle into desktop resources for packaging.
 * Source: repo depends/openwiki-bundle (gitignored). Destination: packages/desktop/resources/openwiki
 *
 * Important: do not junction vendor_modules to the whole hoisted node_modules —
 * that includes `openwiki` itself and creates an infinite vendor_modules loop for electron-builder.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(desktopRoot, "../..")
const version = process.env.OPENWIKI_VERSION || "0.3.1"
const VENDOR_DIR = "vendor_modules"
const REQUIRED = ["@anthropic-ai/vertex-sdk", "deepagents", "@langchain/core", "@langchain/openai"]

const srcCandidates = [
  path.join(repoRoot, "depends", "openwiki-bundle", version, "node_modules", "openwiki"),
  path.join(repoRoot, "depends", "openwiki-bundle", version),
]
const dest = path.join(desktopRoot, "resources", "openwiki")

const src = srcCandidates.find(
  (candidate) =>
    fs.existsSync(path.join(candidate, "package.json")) &&
    fs.existsSync(path.join(candidate, "dist", "agent", "index.js")),
)

if (!src) {
  const channel = process.env.OPENCODE_CHANNEL || "dev"
  const allowMissing = process.env.OPENWIKI_ALLOW_MISSING_BUNDLE === "1" || channel === "dev"
  const message = `[prepare-openwiki] bundle missing under depends/openwiki-bundle/${version}`
  if (allowMissing) {
    console.warn(message)
    console.warn("Run: bun run --cwd packages/openwiki prepare:openwiki")
    console.warn("Dev channel continues without OpenWiki resources (set OPENCODE_CHANNEL=prod/beta to require bundle).")
    process.exit(0)
  }
  console.error(message)
  console.error("Run: bun run --cwd packages/openwiki prepare:openwiki")
  console.error("Release packaging cannot continue without resources/openwiki.")
  process.exit(1)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(path.dirname(dest), { recursive: true })
fs.cpSync(src, dest, { recursive: true, force: true })

// Remove any stale nested vendor link copied from a previous broken stage.
fs.rmSync(path.join(dest, VENDOR_DIR), { recursive: true, force: true })
fs.rmSync(path.join(dest, "node_modules"), { recursive: true, force: true })

const hoisted = path.basename(path.dirname(src)) === "node_modules" ? path.dirname(src) : null
if (hoisted && fs.existsSync(path.join(hoisted, "@anthropic-ai", "vertex-sdk", "package.json"))) {
  const vendorDest = path.join(dest, VENDOR_DIR)
  fs.mkdirSync(vendorDest, { recursive: true })
  for (const entry of fs.readdirSync(hoisted)) {
    if (entry === "openwiki" || entry === ".bin" || entry === ".package-lock.json") continue
    fs.cpSync(path.join(hoisted, entry), path.join(vendorDest, entry), { recursive: true, force: true })
  }

  const missing = REQUIRED.filter((name) => !fs.existsSync(path.join(vendorDest, ...name.split("/"), "package.json")))
  if (missing.length > 0) {
    console.warn(`[prepare-openwiki] vendor_modules missing: ${missing.join(", ")}`)
  }
}

const entry = path.join(dest, "dist", "agent", "index.js")
if (!fs.existsSync(entry)) {
  console.error(`[prepare-openwiki] agent entry missing after stage: ${entry}`)
  process.exit(1)
}

// Adapter worker must ship outside app.asar — runner is bundled into Electron chunks.
const workerSrc = path.join(repoRoot, "packages", "openwiki", "src", "worker.mjs")
const workerDest = path.join(dest, "worker.mjs")
if (!fs.existsSync(workerSrc)) {
  console.error(`[prepare-openwiki] adapter worker missing: ${workerSrc}`)
  process.exit(1)
}
fs.cpSync(workerSrc, workerDest, { force: true })

console.log(`[prepare-openwiki] staged ${src} -> ${dest}`)
console.log(`[prepare-openwiki] staged worker ${workerSrc} -> ${workerDest}`)
