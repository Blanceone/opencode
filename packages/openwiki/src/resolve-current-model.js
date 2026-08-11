import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseModelRef } from "./model-bridge.js"
import { readConfig } from "./config.js"

const FREE_FALLBACK = { providerID: "opencode", modelID: "big-pickle" }

const dataDirCandidates = () => {
  const list = [path.join(os.homedir(), ".local", "share", "opencode")]
  if (process.env.XDG_DATA_HOME) list.unshift(path.join(process.env.XDG_DATA_HOME, "opencode"))
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, "opencode"))
  if (process.env.XDG_STATE_HOME) list.push(path.join(process.env.XDG_STATE_HOME, "opencode"))
  // OpenCode/xdg-basedir on Windows often uses LocalAppData for state
  if (process.env.LOCALAPPDATA) list.push(path.join(process.env.LOCALAPPDATA, "opencode"))
  return [...new Set(list)]
}

const readJson = (filePath) => {
  try {
    if (!fs.existsSync(filePath)) return null
    const raw = fs.readFileSync(filePath, "utf8").trim()
    if (!raw) return null
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/**
 * Resolve the model OpenCode is currently using for this user/project.
 * Order: explicit override → model.json recent[0] → config.model → free fallback.
 *
 * @param {{
 *   directory?: string,
 *   model?: unknown,
 *   openWikiModelOverride?: string | null,
 *   allowFallback?: boolean,
 * }} [input]
 * @returns {{ providerID: string, modelID: string } | null}
 */
export const resolveOpenCodeCurrentModel = (input = {}) => {
  const fromOverride = parseModelRef(input.openWikiModelOverride)
  if (fromOverride) return fromOverride

  const fromExplicit = parseModelRef(input.model)
  if (fromExplicit) return fromExplicit

  for (const dir of dataDirCandidates()) {
    const store = readJson(path.join(dir, "model.json"))
    const recent = Array.isArray(store?.recent) ? store.recent : []
    for (const item of recent) {
      const parsed = parseModelRef(item)
      if (parsed) return parsed
    }
  }

  const config = readConfig(input.directory || process.cwd())
  const fromConfig = parseModelRef(config?.model)
  if (fromConfig) return fromConfig

  if (input.allowFallback === false) return null
  return { ...FREE_FALLBACK }
}
