import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readAuthFile, writeAuthFile } from "./auth.js"
import { readConfig } from "./config.js"

const COPILOT_MODELS_TIMEOUT_MS = 5_000
const CODEX_TOKEN_URL = "https://auth.openai.com/oauth/token"
const CODEX_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"
export const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const OPENCODE_LLM_USER_AGENT = "opencode/1.0 openwiki"

const AUTH_PROVIDER_ALIASES = {
  "github-copilot": ["github-copilot", "copilot"],
}

export const getAuthEntryForProvider = (auth, providerID) => {
  const aliases = AUTH_PROVIDER_ALIASES[providerID] || [providerID]
  for (const alias of aliases) {
    const entry = auth?.[alias]
    if (entry && typeof entry === "object") return entry
  }
  return null
}

const decodeJwtClaims = (token) => {
  try {
    const payload = token.split(".")[1]
    return JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
  } catch {
    return null
  }
}

export const extractChatgptAccountIdFromToken = (accessToken) => {
  const claims = decodeJwtClaims(accessToken)
  const auth = claims?.["https://api.openai.com/auth"]
  const value = auth?.chatgpt_account_id
  return typeof value === "string" && value ? value : null
}

let openaiRefreshPromise = null

const refreshOpenaiOauth = async (entry) => {
  if (!openaiRefreshPromise) {
    openaiRefreshPromise = (async () => {
      const response = await fetch(CODEX_TOKEN_URL, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: entry.refresh,
          client_id: CODEX_CLIENT_ID,
        }),
        signal: AbortSignal.timeout(30_000),
      })
      if (!response.ok) {
        const body = await response.text().catch(() => "")
        throw new Error(`OpenAI token refresh failed with ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`)
      }
      const payload = await response.json()
      const access = typeof payload?.access_token === "string" ? payload.access_token : ""
      if (!access) throw new Error("OpenAI token refresh returned no access token")
      const refreshed = {
        ...entry,
        type: "oauth",
        access,
        refresh: typeof payload?.refresh_token === "string" && payload.refresh_token ? payload.refresh_token : entry.refresh,
        expires: Date.now() + (Number(payload?.expires_in) > 0 ? Number(payload.expires_in) : 3600) * 1000,
      }
      const auth = readAuthFile()
      auth.openai = refreshed
      writeAuthFile(auth)
      return refreshed
    })().finally(() => {
      openaiRefreshPromise = null
    })
  }
  return openaiRefreshPromise
}

export const ensureFreshOpenaiOauth = async (entry) => {
  if (entry.access && Number(entry.expires) > Date.now()) return entry
  if (!entry.refresh) throw new Error("OpenAI OAuth entry has no refresh token")
  return refreshOpenaiOauth(entry)
}

export const getCopilotEndpoint = async ({ baseURL, headers, modelID }) => {
  const trimmedBase = baseURL.replace(/\/+$/, "")
  const response = await fetch(`${trimmedBase}/models`, {
    headers: { Accept: "application/json", ...headers },
    signal: AbortSignal.timeout(COPILOT_MODELS_TIMEOUT_MS),
  })
  if (!response.ok) {
    const body = await response.text().catch(() => "")
    throw Object.assign(new Error(`GitHub Copilot models failed with ${response.status}${body ? `: ${body.slice(0, 300)}` : ""}`), {
      status: response.status,
    })
  }
  const payload = await response.json()
  if (!Array.isArray(payload?.data)) throw new Error("GitHub Copilot models returned an invalid model list")
  const model = payload.data.find((item) => item && typeof item === "object" && item.id === modelID)
  if (!model) throw new Error(`GitHub Copilot model "${modelID}" was not returned by /models`)
  if (model.capabilities?.type === "responses" || model.supported_endpoints?.includes?.("/responses")) return "responses"
  if (model.capabilities?.type === "messages" || model.supported_endpoints?.includes?.("/messages")) return "messages"
  return "chat"
}

const resolveConfigApiKey = (value, workingDirectory) => {
  if (typeof value !== "string") return null
  const fileMatch = value.match(/^\{file:(.+)\}$/i)
  if (!fileMatch) return value
  const configuredPath = fileMatch[1].trim()
  let resolvedPath
  if (configuredPath === "~" || configuredPath.startsWith("~/") || configuredPath.startsWith("~\\")) {
    resolvedPath = path.join(os.homedir(), configuredPath.slice(2))
  } else if (path.isAbsolute(configuredPath)) {
    resolvedPath = configuredPath
  } else {
    resolvedPath = path.resolve(workingDirectory || process.cwd(), configuredPath)
  }
  const key = fs.readFileSync(resolvedPath, "utf8").trim()
  if (!key) throw new Error("empty file")
  return key
}

const readProviderConfig = (workingDirectory, providerID) => {
  try {
    const config = readConfig(workingDirectory)
    const providerCfg = config?.provider?.[providerID]
    if (!providerCfg || typeof providerCfg !== "object") return null
    const baseURL = typeof providerCfg?.options?.baseURL === "string" ? providerCfg.options.baseURL.trim() : null
    const rawApiKey = typeof providerCfg?.options?.apiKey === "string" ? providerCfg.options.apiKey.trim() : null
    const apiKey = rawApiKey ? resolveConfigApiKey(rawApiKey, workingDirectory) : null
    return {
      baseURL,
      auth: apiKey ? { type: "api", key: apiKey } : null,
    }
  } catch {
    return null
  }
}

export const resolveProviderLogin = ({ auth, workingDirectory, providerID }) => {
  const providerConfig = readProviderConfig(workingDirectory, providerID)
  return providerConfig?.auth || getAuthEntryForProvider(auth, providerID) || null
}

export const getModelCatalog = async () => null

export const getCatalogProvider = (catalog, providerID) => {
  const entry = catalog?.[providerID]
  return entry && typeof entry === "object" ? entry : null
}
