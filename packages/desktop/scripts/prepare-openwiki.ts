#!/usr/bin/env bun
/**
 * Stage OpenWiki bundle into desktop resources for packaging.
 * Source: repo depends/openwiki-bundle (gitignored). Destination: packages/desktop/resources/openwiki
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const desktopRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(desktopRoot, "../..")
const version = process.env.OPENWIKI_VERSION || "0.3.1"
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
  console.warn(`[prepare-openwiki] bundle missing under depends/openwiki-bundle/${version}`)
  console.warn("Run: bun run --cwd packages/openwiki prepare:openwiki")
  process.exit(0)
}

fs.rmSync(dest, { recursive: true, force: true })
fs.mkdirSync(path.dirname(dest), { recursive: true })

if (process.platform === "win32") {
  // Prefer junction for large trees; fall back to copy.
  const result = spawnSync("cmd.exe", ["/c", "mklink", "/J", dest, src], { windowsHide: true })
  if (result.status !== 0 || !fs.existsSync(dest)) {
    fs.cpSync(src, dest, { recursive: true })
  }
} else {
  fs.symlinkSync(src, dest, "dir")
}

// Also stage hoisted deps when src is node_modules/openwiki
const hoisted = path.join(src, "..")
const vendorProbe = path.join(hoisted, "@anthropic-ai", "vertex-sdk", "package.json")
if (fs.existsSync(vendorProbe)) {
  const vendorDest = path.join(dest, "vendor_modules")
  if (!fs.existsSync(vendorDest)) {
    if (process.platform === "win32") {
      spawnSync("cmd.exe", ["/c", "mklink", "/J", vendorDest, hoisted], { windowsHide: true })
      if (!fs.existsSync(vendorDest)) fs.cpSync(hoisted, vendorDest, { recursive: true })
    } else {
      fs.symlinkSync(hoisted, vendorDest, "dir")
    }
  }
}

console.log(`[prepare-openwiki] staged ${src} -> ${dest}`)
