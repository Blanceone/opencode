import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const dataCandidates = () => {
  const list = [
    path.join(os.homedir(), ".local", "share", "opencode"),
  ]
  if (process.env.XDG_DATA_HOME) list.unshift(path.join(process.env.XDG_DATA_HOME, "opencode"))
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, "opencode"))
  return list
}

export const resolveOpenCodeDataDir = () => {
  for (const dir of dataCandidates()) {
    if (fs.existsSync(path.join(dir, "auth.json"))) return dir
  }
  return dataCandidates()[0]
}

export const OPENCODE_DATA_DIR = resolveOpenCodeDataDir()
export const AUTH_FILE = path.join(OPENCODE_DATA_DIR, "auth.json")

export const readAuthFile = () => {
  for (const dir of dataCandidates()) {
    const file = path.join(dir, "auth.json")
    if (!fs.existsSync(file)) continue
    try {
      const content = fs.readFileSync(file, "utf8").trim()
      if (!content) return {}
      return JSON.parse(content)
    } catch (error) {
      throw new Error(`Failed to read OpenCode auth configuration: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  return {}
}

export const writeAuthFile = (auth) => {
  const dir = resolveOpenCodeDataDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "auth.json"), `${JSON.stringify(auth, null, 2)}\n`, "utf8")
}
