import { Navigate, useLocation } from "@solidjs/router"
import { createMemo, Show, type ParentProps } from "solid-js"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { wikiHref } from "@/utils/session-route"

// Switching sessions navigates to the session route and unmounts the wiki page.
// Sessions remember that their wiki page was open and redirect back to it when
// selected again; the wiki page's back button clears the flag so an explicit
// close is respected.
export function SessionWikiRedirect(
  props: ParentProps<{
    server: ServerConnection.Key
    sessionID: string | undefined
    directory: () => string | undefined
  }>,
) {
  const tabs = useTabs()
  const location = useLocation()
  const restore = createMemo(() => {
    const sessionID = props.sessionID
    const directory = props.directory()
    if (!tabs.ready() || !sessionID || !directory) return
    if (!tabs.wikiOpen({ type: "session", server: props.server, sessionId: sessionID })) return
    return wikiHref(directory, location.pathname + location.search)
  })
  return (
    <Show when={restore()} keyed fallback={props.children}>
      {(href) => <Navigate href={href} />}
    </Show>
  )
}
