import { base64Encode } from "@opencode-ai/core/util/encode"
import { ServerConnection } from "@/context/server"
import { useServer } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { useServerSync } from "@/context/server-sync"
import { decode64 } from "@/utils/base64"

export function sessionHref(server: ServerConnection.Key, sessionID: string) {
  return `/server/${base64Encode(server)}/session/${sessionID}`
}

export function legacySessionHref(directory: string, sessionID: string) {
  return `/${base64Encode(directory)}/session/${sessionID}`
}

export function wikiHref(directory: string, from?: string) {
  const base = `/${base64Encode(directory)}/wiki`
  if (!from) return base
  return `${base}?from=${encodeURIComponent(from)}`
}

export function openWikiPage(input: {
  navigate: (to: string) => void
  directory: string
  from: string
  sessionID?: string
  promoteSession?: (directory: string, sessionID: string) => void
  // Remember the wiki as open for the originating session so switching back
  // to that session restores the wiki page.
  remember?: () => void
}) {
  if (input.sessionID && input.promoteSession) {
    input.promoteSession(input.directory, input.sessionID)
  }
  input.remember?.()
  input.navigate(wikiHref(input.directory, input.from))
}

// Marks the wiki page as open for the current session so the session route
// restores it when the user switches back to that session's tab. The server
// key must match the one used by the session's tab (route param in the new
// layout, selected server otherwise).
export function useRememberWiki() {
  const server = useServer()
  const tabs = useTabs()
  const serverSync = useServerSync()
  return (sessionID: string | undefined, serverKey?: ServerConnection.Key) => {
    if (!sessionID) return
    tabs.setWiki(
      { type: "session", server: serverKey ?? server.key, sessionId: wikiSessionID(serverSync().session.lineage.peek(sessionID), sessionID) },
      true,
    )
  }
}

// Session tabs are keyed by their root session (see ResolvedTargetSessionRoute),
// so the wiki flag must use the root session id too; otherwise the tabs cleanup
// effect treats the flag as orphaned and discards it immediately.
export function wikiSessionID(lineage: { root: { id: string } } | undefined, sessionID: string) {
  return lineage?.root.id ?? sessionID
}
export function requireServerKey(segment: string | undefined) {
  const key = decode64(segment)
  if (!key || base64Encode(key) !== segment) throw new Error("Invalid server route")
  return ServerConnection.Key.make(key)
}

export function legacySessionServer(
  tabs: readonly { type: "session"; server: ServerConnection.Key; sessionId: string }[],
  sessionID: string,
  active: ServerConnection.Key,
) {
  const matches = tabs.filter((tab) => tab.sessionId === sessionID)
  return matches.find((tab) => tab.server === active)?.server ?? (matches.length === 1 ? matches[0]?.server : active)
}

type SessionParent = { id: string; parentID?: string }

export async function rootSession<T extends SessionParent>(session: T, get: (sessionID: string) => Promise<T>) {
  const seen = new Set([session.id])
  let current = session
  while (current.parentID) {
    if (seen.has(current.parentID)) throw new Error(`Session parent cycle: ${current.parentID}`)
    seen.add(current.parentID)
    current = await get(current.parentID)
  }
  return current
}
