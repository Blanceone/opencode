import { Show, createMemo } from "solid-js"
import { useNavigate, useSearchParams } from "@solidjs/router"
import { Button } from "@opencode-ai/ui/button"
import { Icon } from "@opencode-ai/ui/icon"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { FileProvider } from "@/context/file"
import { OpenWikiPanel } from "@/components/openwiki-panel"
function safeReturnPath(from: string | undefined) {
  if (!from) return
  if (!from.startsWith("/") || from.startsWith("//")) return
  if (from.includes("://")) return
  return from
}

export default function WikiPage() {
  const language = useLanguage()
  const navigate = useNavigate()
  const sdk = useSDK()
  const [search] = useSearchParams<{ from?: string }>()

  const directory = createMemo(() => sdk().directory)

  const back = () => {
    const from = safeReturnPath(search.from)
    if (from) {
      navigate(from)
      return
    }
    navigate(-1)
  }

  return (
    <div
      class={`
        m-2 flex min-h-0 min-w-0 flex-1 flex-col self-stretch overflow-hidden
        rounded-[10px] bg-v2-background-bg-base shadow-[var(--v2-elevation-raised)]
      `}
    >
      <header class="flex shrink-0 flex-col gap-3 border-b border-border-weak-base px-4 py-3 md:px-6 md:py-4">
        <div class="flex flex-wrap items-center gap-2">
          <Button size="small" variant="ghost" onClick={back} aria-label={language.t("page.openwiki.back")}>
            <span class="inline-flex items-center gap-1.5">
              <Icon name="arrow-left" class="size-3.5" />
              {language.t("page.openwiki.back")}
            </span>
          </Button>
        </div>
        <div class="flex min-w-0 flex-col gap-1 sm:flex-row sm:items-end sm:justify-between sm:gap-4">
          <div class="min-w-0">
            <h1 class="text-18-medium tracking-tight">{language.t("page.openwiki.title")}</h1>
            <p class="mt-1 text-12-regular text-text-weaker">{language.t("page.openwiki.description")}</p>
          </div>
          <Show when={directory()}>
            {(dir) => (
              <div
                class="max-w-full truncate rounded-md bg-background-stronger/60 px-2.5 py-1 font-mono text-11-regular text-text-weaker"
                title={dir()}
              >
                {dir()}
              </div>
            )}
          </Show>
        </div>
      </header>
      <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        <FileProvider>
          <OpenWikiPanel />
        </FileProvider>
      </div>
    </div>
  )
}
