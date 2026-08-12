import { Component } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { useLanguage } from "@/context/language"
import { OpenWikiPanel } from "@/components/openwiki-panel"

/** @deprecated Prefer navigating to `/:dir/wiki` via `wikiHref`. Kept for compatibility. */
export const DialogOpenWiki: Component = () => {
  const language = useLanguage()
  return (
    <Dialog
      title={language.t("dialog.openwiki.title")}
      description={language.t("dialog.openwiki.description")}
      size="large"
    >
      <div class="max-h-[min(80vh,720px)] overflow-auto px-3 pb-3">
        <OpenWikiPanel />
      </div>
    </Dialog>
  )
}
