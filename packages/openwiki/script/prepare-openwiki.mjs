import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const packageRoot = path.resolve(__dirname, "..")
const repoRoot = path.resolve(packageRoot, "../..")
const dependsRoot = path.join(repoRoot, "depends")
const version = "0.3.1"
const tarballPath = path.join(dependsRoot, "npm-packs", `openwiki-${version}.tgz`)
const cacheRoot = path.join(dependsRoot, "openwiki-bundle", version)
const npmCache = path.join(dependsRoot, "npm-cache")
const builderTools = process.env.OPENCODE_BUILDER_TOOLS || "D:\\work\\ai\\builder_tools"

const findNpm = () => {
  const candidates = [
    path.join(builderTools, "nodejs", "npm.cmd"),
    path.join(builderTools, "node", "npm.cmd"),
    path.join(builderTools, "nodejs", "bin", "npm"),
    path.join(builderTools, "node", "bin", "npm"),
  ]
  for (const c of candidates) {
    if (fs.existsSync(c)) return c
  }
  return process.platform === "win32" ? "npm.cmd" : "npm"
}

if (!fs.existsSync(tarballPath)) {
  console.error(`Missing tarball: ${tarballPath}`)
  console.error("Place openwiki-*.tgz under depends/npm-packs/ (gitignored).")
  process.exit(1)
}

fs.mkdirSync(cacheRoot, { recursive: true })
fs.mkdirSync(npmCache, { recursive: true })

const npm = findNpm()
console.log(`Installing openwiki@${version} into ${cacheRoot}`)
console.log(`Using npm: ${npm}`)

const result = spawnSync(
  npm,
  ["install", "--omit=dev", "--ignore-scripts", "--prefix", cacheRoot, tarballPath],
  {
    stdio: "inherit",
    env: {
      ...process.env,
      npm_config_cache: npmCache,
    },
    shell: process.platform === "win32" && npm.endsWith(".cmd"),
  },
)

if (result.status !== 0) {
  process.exit(result.status || 1)
}

// Flatten: npm --prefix puts package under node_modules/openwiki
const nested = path.join(cacheRoot, "node_modules", "openwiki")
if (fs.existsSync(path.join(nested, "package.json"))) {
  const pkg = JSON.parse(fs.readFileSync(path.join(nested, "package.json"), "utf8"))
  fs.writeFileSync(path.join(cacheRoot, "package.json"), JSON.stringify(pkg, null, 2))
  // Keep node_modules as deps tree; also expose agent via nested path — resolve-package
  // expects package.json at cacheRoot. Copy essential fields by linking package files.
  for (const name of ["dist", "bin", "README.md", "LICENSE"]) {
    const from = path.join(nested, name)
    const to = path.join(cacheRoot, name)
    if (!fs.existsSync(from)) continue
    fs.rmSync(to, { recursive: true, force: true })
    if (process.platform === "win32") {
      spawnSync("cmd.exe", ["/c", "mklink", "/J", to, from], { stdio: "ignore", windowsHide: true })
      if (!fs.existsSync(to)) {
        fs.cpSync(from, to, { recursive: true })
      }
    } else {
      fs.symlinkSync(from, to, "dir")
    }
  }
}

const entry = path.join(cacheRoot, "dist", "agent", "index.js")
if (!fs.existsSync(entry)) {
  console.error(`Agent entry missing after install: ${entry}`)
  process.exit(1)
}

console.log(`Ready: ${cacheRoot}`)
