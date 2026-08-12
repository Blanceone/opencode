/**
 * OpenWiki API via generated `@opencode-ai/client` openwikis.* (through `@opencode-ai/openwiki/http-client`).
 * App's main `@opencode-ai/client` dependency remains the vendored tarball for session/compat types.
 */
import { ClientError, OpenCode } from "@opencode-ai/openwiki/http-client"
import { authTokenFromCredentials } from "./server"

export { ClientError }

export type OpenWikiModelRef = { providerID: string; modelID: string }

export type OpenWikiClient = ReturnType<typeof OpenCode.make>["openwikis"]

export function createOpenWikiClient(input: {
  baseUrl: string
  fetch?: typeof globalThis.fetch
  username?: string
  password?: string
  directory?: string
}): OpenWikiClient {
  const headers: Record<string, string> = {}
  if (input.password) {
    headers.Authorization = `Basic ${authTokenFromCredentials({
      username: input.username,
      password: input.password,
    })}`
  }
  if (input.directory) {
    headers["x-opencode-directory"] = encodeURIComponent(input.directory)
  }
  return OpenCode.make({
    baseUrl: input.baseUrl,
    fetch: input.fetch,
    headers,
  }).openwikis
}

export function openWikiLocation(directory: string) {
  return { directory }
}

export function openWikiModelQuery(model: OpenWikiModelRef | null | undefined) {
  if (!model?.providerID || !model?.modelID) return undefined
  return `${model.providerID}/${model.modelID}`
}

export function unwrapOpenWikiData<T>(output: { data: T }): T {
  return output.data
}

export function isOpenWikiApiMissing(error: unknown) {
  if (error instanceof ClientError && error.reason === "UnexpectedStatus") {
    const cause = error.cause as { status?: number } | undefined
    if (cause?.status === 404) return true
  }
  if (error instanceof Error) {
    const message = error.message.trim()
    return message === "Not found" || message === "Not Found" || /\b404\b/.test(message)
  }
  return false
}
