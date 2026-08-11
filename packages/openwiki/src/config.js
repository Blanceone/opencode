import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const OPENCODE_CONFIG_DIR = path.join(os.homedir(), ".config", "opencode")

const stripJsonc = (raw) =>
  raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")

const readJsonFile = (filePath) => {
  if (!fs.existsSync(filePath)) return {}
  try {
    const raw = fs.readFileSync(filePath, "utf8")
    const trimmed = raw.trim()
    if (!trimmed) return {}
    return JSON.parse(stripJsonc(trimmed))
  } catch {
    return {}
  }
}

const projectConfigPaths = (workingDirectory) => {
  if (!workingDirectory) return []
  return [
    path.join(workingDirectory, "opencode.json"),
    path.join(workingDirectory, "opencode.jsonc"),
    path.join(workingDirectory, ".opencode", "opencode.json"),
    path.join(workingDirectory, ".opencode", "opencode.jsonc"),
  ]
}

const mergeObjects = (base, overlay) => {
  if (!overlay || typeof overlay !== "object" || Array.isArray(overlay)) return base
  const result = { ...(base && typeof base === "object" ? base : {}) }
  for (const [key, value] of Object.entries(overlay)) {
    if (value && typeof value === "object" && !Array.isArray(value) && result[key] && typeof result[key] === "object" && !Array.isArray(result[key])) {
      result[key] = mergeObjects(result[key], value)
    } else {
      result[key] = value
    }
  }
  return result
}

/** Merge user + project OpenCode config (provider options for gateway). */
export const readConfig = (workingDirectory) => {
  const userJson = readJsonFile(path.join(OPENCODE_CONFIG_DIR, "opencode.json"))
  const userJsonc = readJsonFile(path.join(OPENCODE_CONFIG_DIR, "opencode.jsonc"))
  let merged = mergeObjects(userJson, userJsonc)
  for (const candidate of projectConfigPaths(workingDirectory)) {
    merged = mergeObjects(merged, readJsonFile(candidate))
  }
  return merged
}
