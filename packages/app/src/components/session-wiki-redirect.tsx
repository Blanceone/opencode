import { useLocation, useNavigate } from "@solidjs/router"
import { createEffect, createMemo, type ParentProps } from "solid-js"
import { ServerConnection } from "@/context/server"
import { useTabs } from "@/context/tabs"
import { wikiHref } from "@/utils/session-route"

// Switching sessions navigates to the session route and unmounts the wiki page.
// Sessions remember that their wiki page was open and redirect back to it when
// selected again; the wiki page's back button clears the flag so an explicit
// close is respected.
//
// The redirect is driven by createEffect (not a memo + <Navigate>) so it fires
// reliably after all reactive dependencies settle. A pure memo + <Navigate>
// can miss the redirect when the session lineage (directory) resolves one tick
// after the component mounts: the memo returns undefined on first render,
// children render, and when directory arrives the memo re-evaluates but the
// <Navigate> has already been bypassed by the <Show> fallback path.
export function SessionWikiRedirect(
  props: ParentProps<{
    server: ServerConnection.Key
    sessionID: string | undefined
    directory: () => string | undefined
  }>,
) {
  const tabs = useTabs()
  const location = useLocation()
  const navigate = useNavigate()

  const wikiHrefForSession = createMemo(() => {
    const sessionID = props.sessionID
    const directory = props.directory()
    if (!tabs.ready() || !sessionID || !directory) return
    if (!tabs.wikiOpen({ type: "session", server: props.server, sessionId: sessionID })) return
    return wikiHref(directory, location.pathname + location.search)
  })

  createEffect(() => {
    const href = wikiHrefForSession()
    if (href) navigate(href, { replace: true })
  })

  return <>{props.children}</>
}
