import { Component, For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { createStore } from "solid-js/store"
import { createMediaQuery } from "@solid-primitives/media"
import { createResizeObserver } from "@solid-primitives/resize-observer"
import { Button } from "@opencode-ai/ui/button"
import { Spinner } from "@opencode-ai/ui/spinner"
import { ResizeHandle } from "@opencode-ai/ui/resize-handle"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useModels } from "@/context/models"
import { useLanguage } from "@/context/language"
import { usePlatform } from "@/context/platform"
import { useServerSDK } from "@/context/server-sdk"
import { authTokenFromCredentials } from "@/utils/server"
import { showToast } from "@/utils/toast"
import { Persist, persisted } from "@/utils/persist"
import { OpenWikiFileBrowser } from "@/components/openwiki-file-browser"
import {
  createOpenWikiClient,
  isOpenWikiApiMissing,
  openWikiLocation,
  openWikiModelQuery,
  unwrapOpenWikiData,
} from "@/utils/openwiki-client"

const LEFT_PANEL_MIN = 420
const RIGHT_PANEL_MIN = 360
const LEFT_PANEL_DEFAULT = 560
const SPLIT_GAP = 1

type WikiStatus = {
  projectDirectory?: string
  wikiExists: boolean
  ownership: string
  consentRequired: boolean
  hasLogin: boolean
  wikiRoot: string
  foreignPaths?: string[]
  model: null | { providerID: string; modelID: string }
  job: null | {
    stage: string
    detail?: string
    error?: { message?: string; code?: string; providerID?: string }
  }
}

type FormatBundle = {
  presetId: string
  instructions: string
  format: string
}

type FormatPreset = {
  id: string
  instructions: string
  format: string
}

const PRESET_IDS = ["openwiki-default", "architecture-module", "api-service", "custom"] as const

const ACTIVE_STAGES = new Set(["queued", "preparing", "mapping-model", "running", "writing"])
const DETAIL_DISPLAY_MAX = 160
const POLL_ACTIVE_MS = 1000
const POLL_IDLE_MS = 4000
const POLL_BACKOFF_MAX_MS = 30_000

function truncateDetail(detail: string | undefined) {
  if (!detail) return undefined
  const compact = detail.replace(/\s+/g, " ").trim()
  if (compact.length <= DETAIL_DISPLAY_MAX) return compact
  return `${compact.slice(0, DETAIL_DISPLAY_MAX)}…`
}

function unwrapData<T>(json: { data?: T } | T): T {
  if (json && typeof json === "object" && "data" in json) return (json as { data: T }).data
  return json as T
}

function parseErrorBody(text: string, fallback: string) {
  if (!text) return fallback
  try {
    const json = JSON.parse(text) as { message?: string; data?: { message?: string }; error?: { message?: string } }
    return json.data?.message || json.error?.message || json.message || text
  } catch {
    return text
  }
}

function parseThrownApiError(error: unknown, fallback: string) {
  if (error && typeof error === "object") {
    const record = error as { message?: string; data?: { message?: string }; error?: { message?: string } }
    if (typeof record.data?.message === "string") return record.data.message
    if (typeof record.error?.message === "string") return record.error.message
    if (typeof record.message === "string" && record.message !== "UnexpectedStatus") return record.message
  }
  if (error instanceof Error) return error.message || fallback
  return fallback
}

function isDriveRoot(directory: string) {
  const trimmed = directory.trim()
  if (!trimmed) return false
  if (trimmed === "/" || trimmed === "\\") return true
  return /^[A-Za-z]:[\\/]?$/.test(trimmed)
}

export const OpenWikiPanel: Component = () => {
  const sdk = useSDK()
  const local = useLocal()
  const models = useModels()
  const language = useLanguage()
  const platform = usePlatform()
  const serverSDK = useServerSDK()
  const [status, setStatus] = createSignal<WikiStatus | null>(null)
  const [format, setFormat] = createSignal<FormatBundle | null>(null)
  const [formatDirty, setFormatDirty] = createSignal(false)
  const [formatEpoch, setFormatEpoch] = createSignal(0)
  const [presets, setPresets] = createSignal<FormatPreset[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [activeAction, setActiveAction] = createSignal<"generate" | "update" | null>(null)
  const [pollPaused, setPollPaused] = createSignal(false)
  const [pollDelayMs, setPollDelayMs] = createSignal(POLL_IDLE_MS)
  const [lastNotifiedStage, setLastNotifiedStage] = createSignal<string | null>(null)
  const [filesRefreshToken, setFilesRefreshToken] = createSignal(0)
  const [splitRoot, setSplitRoot] = createSignal<HTMLDivElement>()
  const [splitWidth, setSplitWidth] = createSignal(0)
  const desktopSplit = createMediaQuery("(min-width: 1024px)")
  const [splitStore, setSplitStore] = persisted(
    Persist.global("openwiki-split", ["openwiki-split.v2"]),
    createStore({ leftWidth: LEFT_PANEL_DEFAULT }),
  )

  const clampLeftWidth = (width: number, total: number) => {
    if (total <= 0) return Math.max(LEFT_PANEL_MIN, width)
    const roomy = total >= LEFT_PANEL_MIN + RIGHT_PANEL_MIN + SPLIT_GAP
    if (roomy) {
      const max = total - RIGHT_PANEL_MIN - SPLIT_GAP
      return Math.min(max, Math.max(LEFT_PANEL_MIN, width))
    }
    // Not enough room for both ideal mins: keep a usable right share, give the rest to the left.
    const softRight = Math.max(180, Math.min(RIGHT_PANEL_MIN, Math.floor(total * 0.45)))
    const max = Math.max(240, total - softRight - SPLIT_GAP)
    const min = Math.min(LEFT_PANEL_MIN, max)
    return Math.min(max, Math.max(min, width))
  }

  const leftWidth = createMemo(() => clampLeftWidth(splitStore.leftWidth, splitWidth()))
  const leftMax = createMemo(() => {
    const total = splitWidth()
    if (total <= 0) return LEFT_PANEL_DEFAULT * 2
    const roomy = total >= LEFT_PANEL_MIN + RIGHT_PANEL_MIN + SPLIT_GAP
    if (roomy) return total - RIGHT_PANEL_MIN - SPLIT_GAP
    const softRight = Math.max(180, Math.min(RIGHT_PANEL_MIN, Math.floor(total * 0.45)))
    return Math.max(240, total - softRight - SPLIT_GAP)
  })
  const roomySplit = createMemo(() => {
    const total = splitWidth()
    return total <= 0 || total >= LEFT_PANEL_MIN + RIGHT_PANEL_MIN + SPLIT_GAP
  })
  const resizeMin = createMemo(() => (roomySplit() ? LEFT_PANEL_MIN : Math.min(LEFT_PANEL_MIN, leftMax())))

  createResizeObserver(splitRoot, ({ width }) => {
    const next = Math.floor(width)
    setSplitWidth(next)
    setSplitStore("leftWidth", (current) => clampLeftWidth(current, next))
  })

  const directory = () => sdk().directory

  const workspacePath = createMemo(() => status()?.projectDirectory || directory())

  const modelRef = createMemo(() => {
    const model = local.model.current()
    if (model?.provider?.id && model?.id) {
      return { providerID: model.provider.id, modelID: model.id }
    }
    const recent = models.recent.list()[0]
    if (recent) return recent
    return null
  })

  const modelLabel = createMemo(() => {
    const selected = modelRef()
    if (selected) return `${selected.providerID}/${selected.modelID}`
    const fromStatus = status()?.model
    if (fromStatus) return `${fromStatus.providerID}/${fromStatus.modelID}`
    return language.t("dialog.openwiki.model.followCurrent")
  })

  const jobActive = createMemo(() => {
    const stage = status()?.job?.stage
    return !!stage && ACTIVE_STAGES.has(stage)
  })

  const working = createMemo(() => busy() || jobActive())

  const ownershipLabel = (ownership: string) => {
    if (ownership === "absent") return language.t("dialog.openwiki.ownership.absent")
    if (ownership === "opencode-managed") return language.t("dialog.openwiki.ownership.opencode-managed")
    if (ownership === "foreign") return language.t("dialog.openwiki.ownership.foreign")
    if (ownership === "conflict") return language.t("dialog.openwiki.ownership.conflict")
    return ownership
  }

  const jobStageLabel = (stage: string) => {
    if (stage === "queued") return language.t("dialog.openwiki.job.queued")
    if (stage === "preparing") return language.t("dialog.openwiki.job.preparing")
    if (stage === "mapping-model") return language.t("dialog.openwiki.job.mapping-model")
    if (stage === "running") return language.t("dialog.openwiki.job.running")
    if (stage === "writing") return language.t("dialog.openwiki.job.writing")
    if (stage === "completed") return language.t("dialog.openwiki.job.completed")
    if (stage === "failed") return language.t("dialog.openwiki.job.failed")
    if (stage === "cancelled") return language.t("dialog.openwiki.job.cancelled")
    return stage
  }

  const openwikiApi = () => {
    const server = serverSDK().server.http
    return createOpenWikiClient({
      baseUrl: server.url,
      fetch: platform.fetch,
      username: server.username,
      password: server.password,
    })
  }

  /** Fallback when generated client hits a server without /api/openwiki (stale sidecar). */
  const openwikiFetch = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    const server = serverSDK().server.http
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-opencode-directory": encodeURIComponent(directory()),
    }
    if (server.password) {
      headers.Authorization = `Basic ${authTokenFromCredentials({
        username: server.username,
        password: server.password,
      })}`
    }
    const fetchFn = platform.fetch ?? globalThis.fetch
    const res = await fetchFn(new URL(path, server.url), {
      ...init,
      headers: {
        ...headers,
        ...(init?.headers as Record<string, string> | undefined),
      },
    })
    if (!res.ok) {
      const text = await res.text().catch(() => "")
      if (res.status === 404) throw new Error(language.t("dialog.openwiki.error.apiUnavailable"))
      throw new Error(parseErrorBody(text, `${res.status} ${res.statusText}`))
    }
    return unwrapData(await res.json())
  }

  const withOpenWiki = async <T,>(primary: () => Promise<T>, fallback: () => Promise<T>): Promise<T> => {
    try {
      return await primary()
    } catch (error) {
      if (!isOpenWikiApiMissing(error)) throw error
      return fallback()
    }
  }

  const isRateLimitMessage = (message: string) =>
    /\b429\b|rate[\s_-]?limit|MODEL_RATE_LIMIT|too many requests/i.test(message)

  const formatFailure = (jobError?: WikiStatus["job"] extends null ? never : NonNullable<WikiStatus["job"]>["error"]) => {
    if (!jobError) return null
    if (jobError.code === "no-provider-login" || jobError.code === "provider-unsupported-for-openwiki") {
      const provider = jobError.providerID || modelRef()?.providerID || "—"
      if (provider === "opencode" || provider === "opencode-go") {
        return language.t("dialog.openwiki.error.opencodeLoginRequired")
      }
      if (jobError.code === "no-provider-login") {
        return language.t("dialog.openwiki.error.noProviderLogin", { provider })
      }
      return language.t("dialog.openwiki.error.providerUnsupported", { provider })
    }
    if (jobError.code === "model-required") return language.t("dialog.openwiki.error.modelRequired")
    if (jobError.code === "wiki-consent-required") return language.t("dialog.openwiki.error.consentRequired")
    if (jobError.code === "openwiki-node-required") return language.t("dialog.openwiki.error.nodeRequired")
    if (jobError.code === "openwiki-package-missing") return language.t("dialog.openwiki.error.packageMissing")
    if (jobError.code === "openwiki-worker-missing") return language.t("dialog.openwiki.error.workerMissing")
    if (!jobError.message) return null
    if (isRateLimitMessage(jobError.message)) return language.t("dialog.openwiki.error.rateLimit")
    // Node/Electron stack dumps are huge; keep the actionable Error line for the dialog.
    const firstError = jobError.message.match(/(?:^|\n)Error: ([^\r\n]+)/)
    if (firstError?.[1]) {
      if (isRateLimitMessage(firstError[1])) return language.t("dialog.openwiki.error.rateLimit")
      return firstError[1].trim()
    }
    return jobError.message.length > 400 ? `${jobError.message.slice(0, 400)}…` : jobError.message
  }

  const extractErrorCode = (e: unknown) => {
    if (!e || typeof e !== "object") return undefined
    const record = e as {
      code?: string
      data?: { code?: string }
      error?: { code?: string; data?: { code?: string } }
    }
    return record.data?.code || record.error?.data?.code || record.error?.code || record.code
  }

  const formatCaughtError = (e: unknown) => {
    if (isOpenWikiApiMissing(e)) return language.t("dialog.openwiki.error.apiUnavailable")
    const code = extractErrorCode(e)
    if (code === "openwiki-node-required") return language.t("dialog.openwiki.error.nodeRequired")
    if (code === "openwiki-package-missing") return language.t("dialog.openwiki.error.packageMissing")
    if (code === "openwiki-worker-missing") return language.t("dialog.openwiki.error.workerMissing")
    if (code === "wiki-consent-required") return language.t("dialog.openwiki.error.consentRequired")
    if (code === "model-required") return language.t("dialog.openwiki.error.modelRequired")
    if (code === "no-provider-login") {
      const provider =
        (e as { data?: { providerID?: string } })?.data?.providerID || modelRef()?.providerID || "—"
      if (provider === "opencode" || provider === "opencode-go") {
        return language.t("dialog.openwiki.error.opencodeLoginRequired")
      }
      return language.t("dialog.openwiki.error.noProviderLogin", { provider })
    }
    if (code === "provider-unsupported-for-openwiki") {
      const provider =
        (e as { data?: { providerID?: string } })?.data?.providerID || modelRef()?.providerID || "—"
      return language.t("dialog.openwiki.error.providerUnsupported", { provider })
    }
    const message = parseThrownApiError(e, language.t("dialog.openwiki.error.apiUnavailable")).trim()
    if (!message || message === "Not found" || message === "Not Found" || /\b404\b/.test(message)) {
      return language.t("dialog.openwiki.error.apiUnavailable")
    }
    if (/openwiki-node-required|requires Node\.js|Electron-as-Node/i.test(message)) {
      return language.t("dialog.openwiki.error.nodeRequired")
    }
    if (isRateLimitMessage(message)) return language.t("dialog.openwiki.error.rateLimit")
    return message
  }

  const displayError = createMemo(() => {
    const jobError = status()?.job?.error
    const fromJob = formatFailure(jobError) || jobError?.message
    if (fromJob) return fromJob
    return error()
  })

  const notifyTerminalJob = (stage: string | undefined, jobError?: WikiStatus["job"] extends null
    ? never
    : NonNullable<WikiStatus["job"]>["error"]) => {
    if (!stage || stage === lastNotifiedStage()) return
    if (stage === "completed") {
      setLastNotifiedStage(stage)
      setFilesRefreshToken((n) => n + 1)
      showToast({
        title: language.t("dialog.openwiki.toast.completed.title"),
        description: language.t("dialog.openwiki.toast.completed.description"),
        variant: "success",
      })
      return
    }
    if (stage === "failed") {
      setLastNotifiedStage(stage)
      const message =
        formatFailure(jobError) || jobError?.message || language.t("dialog.openwiki.job.failed")
      showToast({
        title: language.t("dialog.openwiki.toast.failed.title"),
        description: language.t("dialog.openwiki.toast.failed.description", { message }),
        variant: "error",
      })
    }
  }

  const toWikiStatus = (data: {
    projectDirectory: string
    wikiRoot: string
    wikiExists: boolean
    ownership: string
    consentRequired: boolean
    hasLogin: boolean
    foreignPaths: ReadonlyArray<string>
    model: null | { providerID: string; modelID: string }
    job: WikiStatus["job"]
  }): WikiStatus => ({
    projectDirectory: data.projectDirectory,
    wikiRoot: data.wikiRoot,
    wikiExists: data.wikiExists,
    ownership: data.ownership,
    consentRequired: data.consentRequired,
    hasLogin: data.hasLogin,
    foreignPaths: [...data.foreignPaths],
    model: data.model,
    job: data.job
      ? {
          stage: data.job.stage,
          detail: data.job.detail,
          error: data.job.error
            ? {
                message: data.job.error.message,
                code: data.job.error.code,
                providerID: data.job.error.providerID,
              }
            : undefined,
        }
      : null,
  })

  const toFormatBundle = (data: { presetId: string; instructions: string; format: string }): FormatBundle => ({
    presetId: data.presetId,
    instructions: data.instructions,
    format: data.format,
  })

  const presetLabel = (id: string) => {
    if (id === "openwiki-default") return language.t("dialog.openwiki.format.preset.openwiki-default")
    if (id === "architecture-module") return language.t("dialog.openwiki.format.preset.architecture-module")
    if (id === "api-service") return language.t("dialog.openwiki.format.preset.api-service")
    if (id === "custom") return language.t("dialog.openwiki.format.preset.custom")
    return id
  }

  const refresh = async () => {
    try {
      const selected = modelRef()
      const location = openWikiLocation(directory())
      const model = openWikiModelQuery(selected)
      const api = openwikiApi()
      const nextStatus = await withOpenWiki(
        async () => toWikiStatus(unwrapOpenWikiData(await api.status({ location, model }))),
        async () => {
          const modelQuery = model ? `?model=${encodeURIComponent(model)}` : ""
          return openwikiFetch<WikiStatus>(`/api/openwiki/status${modelQuery}`)
        },
      )
      setStatus(nextStatus)
      const formatSnapshot = formatEpoch()
      if (!formatDirty()) {
        const nextFormat = await withOpenWiki(
          async () => toFormatBundle(unwrapOpenWikiData(await api.formatGet({ location }))),
          async () => openwikiFetch<FormatBundle>("/api/openwiki/format"),
        )
        if (!formatDirty() && formatSnapshot === formatEpoch()) setFormat(nextFormat)
      }
      setPresets(
        await withOpenWiki(
          async () =>
            unwrapOpenWikiData(await api.formatPresets({ location })).map((preset) => ({
              id: preset.id,
              instructions: preset.instructions,
              format: preset.format,
            })),
          async () => (await openwikiFetch<FormatPreset[]>("/api/openwiki/format/presets")) ?? [],
        ),
      )
      setError(formatFailure(nextStatus.job?.error))
      notifyTerminalJob(nextStatus.job?.stage, nextStatus.job?.error)
      setPollPaused(false)
      setPollDelayMs(ACTIVE_STAGES.has(nextStatus.job?.stage || "") ? POLL_ACTIVE_MS : POLL_IDLE_MS)
    } catch (e) {
      setError(formatCaughtError(e))
      if (isOpenWikiApiMissing(e)) {
        setPollPaused(true)
        return
      }
      setPollDelayMs((ms) => Math.min(ms * 2, POLL_BACKOFF_MAX_MS))
    }
  }

  const run = async (command: "generate" | "update" | "cancel") => {
    if (command !== "cancel" && working()) return
    if (
      command === "generate" &&
      status()?.ownership === "opencode-managed" &&
      status()?.wikiExists &&
      typeof globalThis.confirm === "function" &&
      !globalThis.confirm(language.t("dialog.openwiki.confirm.regenerate"))
    ) {
      return
    }
    setBusy(true)
    setError(null)
    if (command === "generate" || command === "update") {
      setActiveAction(command)
      setStatus((prev) =>
        prev
          ? {
              ...prev,
              job: {
                stage: "queued",
                detail: undefined,
                error: undefined,
              },
            }
          : prev,
      )
    }
    try {
      const selected = modelRef()
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      if (command === "cancel") {
        await withOpenWiki(
          async () => api.cancel({ location }),
          async () => openwikiFetch("/api/openwiki/cancel", { method: "POST", body: "{}" }),
        )
      } else {
        const body = selected ? { model: selected } : {}
        await withOpenWiki(
          async () => api[command]({ location, ...body }),
          async () =>
            openwikiFetch(`/api/openwiki/${command}`, {
              method: "POST",
              body: JSON.stringify(body),
            }),
        )
      }
      await refresh()
    } catch (e) {
      setError(formatCaughtError(e))
      await refresh()
    } finally {
      setBusy(false)
      if (!ACTIVE_STAGES.has(status()?.job?.stage || "")) setActiveAction(null)
    }
  }

  const consent = async (consentAction: "adopt" | "backup-rebuild") => {
    setBusy(true)
    setError(null)
    try {
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      await withOpenWiki(
        async () => {
          setStatus(toWikiStatus(unwrapOpenWikiData(await api.consent({ location, consent: true, consentAction }))))
        },
        async () => {
          await openwikiFetch("/api/openwiki/consent", {
            method: "POST",
            body: JSON.stringify({ consent: true, consentAction }),
          })
          await refresh()
        },
      )
      await refresh()
    } catch (e) {
      setError(formatCaughtError(e))
    } finally {
      setBusy(false)
    }
  }

  const saveFormat = async (patch: {
    presetId?: string
    instructions?: string
    format?: string
    applyPreset?: boolean
  }) => {
    setBusy(true)
    setError(null)
    try {
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      setFormat(
        await withOpenWiki(
          async () => {
            const presetId = PRESET_IDS.includes(patch.presetId as (typeof PRESET_IDS)[number])
              ? (patch.presetId as (typeof PRESET_IDS)[number])
              : undefined
            return toFormatBundle(
              unwrapOpenWikiData(
                await api.formatPut({
                  location,
                  instructions: patch.instructions,
                  format: patch.format,
                  applyPreset: patch.applyPreset,
                  presetId,
                }),
              ),
            )
          },
          async () =>
            openwikiFetch<FormatBundle>("/api/openwiki/format", {
              method: "PUT",
              body: JSON.stringify(patch),
            }),
        ),
      )
      setFormatDirty(false)
      setFormatEpoch((n) => n + 1)
    } catch (e) {
      setError(formatCaughtError(e))
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    const ref = modelRef()
    if (ref) syncedModelKey = `${ref.providerID}/${ref.modelID}`
    void refresh()
  })

  let syncedModelKey = ""
  createEffect(() => {
    models.recent.list()
    local.model.current()
    const ref = modelRef()
    if (!ref) return
    const key = `${ref.providerID}/${ref.modelID}`
    if (key === syncedModelKey) return
    syncedModelKey = key
    void refresh()
  })

  createEffect(() => {
    if (!working()) setActiveAction(null)
  })

  createEffect(() => {
    if (pollPaused()) return
    const ms = jobActive() ? POLL_ACTIVE_MS : pollDelayMs()
    const timer = setInterval(() => void refresh(), ms)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <div class="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden">
      <div
        ref={setSplitRoot}
        class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden"
      >
        <section
          class="relative flex min-h-0 min-w-0 flex-col overflow-hidden border-b border-border-weak-base lg:border-b-0 lg:shrink-0"
          style={
            desktopSplit()
              ? {
                  width: `${leftWidth()}px`,
                  ...(roomySplit() ? { "min-width": `${LEFT_PANEL_MIN}px` } : undefined),
                }
              : undefined
          }
        >
          <div class="flex shrink-0 flex-col gap-3 border-b border-border-weak-base px-4 py-3 md:px-5">
            <Show when={status()} fallback={<div class="text-12-regular text-text-weaker">{language.t("common.loading")}</div>}>
              {(s) => (
                <div class="flex flex-col gap-3">
                  <div class="flex flex-wrap items-center gap-2">
                    <span class="rounded-full bg-background-stronger px-2.5 py-1 text-11-regular text-text-weak">
                      {language.t("dialog.openwiki.model")}: {modelLabel()}
                    </span>
                    <span
                      class="rounded-full bg-background-stronger px-2.5 py-1 text-11-regular text-text-weak"
                      title={language.t("dialog.openwiki.exists.hint")}
                    >
                      {s().wikiExists ? language.t("dialog.openwiki.exists.yes") : language.t("dialog.openwiki.exists.no")}
                    </span>
                    <span
                      class="rounded-full bg-background-stronger px-2.5 py-1 text-11-regular text-text-weak"
                      title={language.t("dialog.openwiki.ownership.hint")}
                    >
                      {ownershipLabel(s().ownership)}
                    </span>
                    <span class="rounded-full bg-background-stronger px-2.5 py-1 text-11-regular text-text-weak">
                      {language.t("dialog.openwiki.login")}:{" "}
                      {s().hasLogin ? language.t("dialog.openwiki.yes") : language.t("dialog.openwiki.no")}
                    </span>
                    <span class="inline-flex items-center gap-1.5 rounded-full bg-background-stronger px-2.5 py-1 text-11-regular text-text-weak">
                      {s().job ? jobStageLabel(s().job!.stage) : language.t("dialog.openwiki.job.idle")}
                      <Show when={truncateDetail(s().job?.detail)}>
                        <span class="max-w-[280px] truncate text-text-weaker">— {truncateDetail(s().job!.detail)}</span>
                      </Show>
                      <Show when={jobActive()}>
                        <Spinner class="size-3 shrink-0 text-text-weaker" />
                      </Show>
                    </span>
                  </div>

                  <div class="grid gap-1 text-12-regular text-text-weaker">
                    <div class="min-w-0 truncate" title={workspacePath()}>
                      <span class="text-text-weak">{language.t("dialog.openwiki.workspace")}: </span>
                      {workspacePath()}
                    </div>
                    <div class="min-w-0 truncate" title={s().wikiRoot}>
                      <span class="text-text-weak">{language.t("dialog.openwiki.wikiPath")}: </span>
                      {s().wikiRoot}
                    </div>
                  </div>

                  <Show when={isDriveRoot(workspacePath())}>
                    <div class="text-12-regular text-text-danger">{language.t("dialog.openwiki.driveRootWarning")}</div>
                  </Show>
                </div>
              )}
            </Show>

            <Show when={status()?.consentRequired}>
              <div class="flex flex-col gap-2 rounded-lg border border-border-weak-base bg-background-stronger/40 p-3">
                <div class="text-12-regular">{language.t("dialog.openwiki.consent.prompt")}</div>
                <Show when={(status()?.foreignPaths?.length ?? 0) > 0}>
                  <div class="text-11-regular text-text-weaker">
                    {language.t("dialog.openwiki.consent.foreignPaths")}: {status()!.foreignPaths!.join(", ")}
                  </div>
                </Show>
                <div class="flex flex-wrap gap-2">
                  <Button size="small" disabled={working()} onClick={() => void consent("adopt")}>
                    {language.t("dialog.openwiki.consent.adopt")}
                  </Button>
                  <Button size="small" variant="ghost" disabled={working()} onClick={() => void consent("backup-rebuild")}>
                    {language.t("dialog.openwiki.consent.backupRebuild")}
                  </Button>
                </div>
              </div>
            </Show>

            <Show when={displayError()}>
              <div class="rounded-md border border-border-weak-base bg-background-stronger/40 px-3 py-2 text-12-regular text-text-danger">
                {displayError()}
              </div>
            </Show>

            <div class="flex flex-wrap items-center gap-2">
              <Button
                size="normal"
                variant="primary"
                disabled={
                  working() ||
                  !!status()?.consentRequired ||
                  status()?.hasLogin === false ||
                  isDriveRoot(workspacePath())
                }
                onClick={() => void run("generate")}
              >
                <Show when={activeAction() === "generate"} fallback={language.t("dialog.openwiki.action.generate")}>
                  <span class="inline-flex items-center gap-1.5">
                    <Spinner class="size-3.5" />
                    {language.t("dialog.openwiki.action.generating")}
                  </span>
                </Show>
              </Button>
              <Button
                size="normal"
                variant="secondary"
                disabled={
                  working() ||
                  !!status()?.consentRequired ||
                  !status()?.wikiExists ||
                  status()?.hasLogin === false ||
                  isDriveRoot(workspacePath())
                }
                onClick={() => void run("update")}
              >
                <Show when={activeAction() === "update"} fallback={language.t("dialog.openwiki.action.update")}>
                  <span class="inline-flex items-center gap-1.5">
                    <Spinner class="size-3.5" />
                    {language.t("dialog.openwiki.action.updating")}
                  </span>
                </Show>
              </Button>
              <Button size="normal" variant="ghost" disabled={busy() || !jobActive()} onClick={() => void run("cancel")}>
                {language.t("common.cancel")}
              </Button>
              <Button
                size="normal"
                variant="ghost"
                disabled={busy()}
                onClick={() => {
                  setFilesRefreshToken((n) => n + 1)
                  void refresh()
                }}
              >
                {language.t("dialog.openwiki.action.refresh")}
              </Button>
              <span class="basis-full text-11-regular text-text-weaker">
                {language.t("dialog.openwiki.tip.references")}
              </span>
            </div>
          </div>

          <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto px-4 py-4 md:px-5">
            <Show
              when={format()}
              fallback={
                <div class="flex flex-1 items-center justify-center text-12-regular text-text-weaker">
                  {language.t("common.loading")}
                </div>
              }
            >
              {(bundle) => (
                <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-4">
                  <div class="flex shrink-0 flex-wrap items-end gap-2">
                    <label class="flex w-full min-w-[180px] max-w-xs flex-col gap-1.5 text-12-regular sm:w-auto sm:min-w-[220px]">
                      <span class="text-text-weak">{language.t("dialog.openwiki.format.preset")}</span>
                      <select
                        class="h-9 w-full rounded-md border border-border-weak-base bg-transparent px-3 text-12-regular"
                        value={bundle().presetId}
                        disabled={busy() || !!status()?.consentRequired}
                        onChange={(event) => {
                          const presetId = event.currentTarget.value
                          void saveFormat({ presetId, applyPreset: true })
                        }}
                      >
                        <For each={presets().length ? presets().map((p) => p.id) : [...PRESET_IDS]}>
                          {(id) => <option value={id}>{presetLabel(id)}</option>}
                        </For>
                      </select>
                    </label>
                    <Button
                      size="normal"
                      variant="secondary"
                      disabled={busy() || !!status()?.consentRequired}
                      onClick={() =>
                        void saveFormat({
                          presetId: bundle().presetId,
                          instructions: bundle().instructions,
                          format: bundle().format,
                        })
                      }
                    >
                      {language.t("common.save")}
                    </Button>
                  </div>

                  <label class="flex min-h-[180px] min-w-0 flex-1 flex-col gap-1.5 text-12-regular">
                    <span class="shrink-0 text-text-weak">{language.t("dialog.openwiki.format.instructions")}</span>
                    <textarea
                      class="min-h-[160px] w-full flex-1 resize-y overflow-auto rounded-lg border border-border-weak-base bg-transparent px-3 py-3 font-mono text-12-regular leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong-base"
                      value={bundle().instructions}
                      disabled={busy() || !!status()?.consentRequired}
                      onInput={(event) => {
                        setFormatDirty(true)
                        setFormat({
                          ...bundle(),
                          instructions: event.currentTarget.value,
                          presetId: "custom",
                        })
                      }}
                    />
                  </label>
                  <label class="flex min-h-[220px] min-w-0 flex-[1.4] flex-col gap-1.5 text-12-regular">
                    <span class="shrink-0 text-text-weak">{language.t("dialog.openwiki.format.body")}</span>
                    <textarea
                      class="min-h-[200px] w-full flex-1 resize-y overflow-auto rounded-lg border border-border-weak-base bg-transparent px-3 py-3 font-mono text-12-regular leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong-base"
                      value={bundle().format}
                      disabled={busy() || !!status()?.consentRequired}
                      onInput={(event) => {
                        setFormatDirty(true)
                        setFormat({
                          ...bundle(),
                          format: event.currentTarget.value,
                          presetId: "custom",
                        })
                      }}
                    />
                  </label>
                </div>
              )}
            </Show>
          </div>

          <Show when={desktopSplit()}>
            <div class="pointer-events-none absolute inset-y-0 end-0 z-[9] w-px bg-border-strong-base" aria-hidden="true" />
            <ResizeHandle
              direction="horizontal"
              size={leftWidth()}
              min={resizeMin()}
              max={leftMax()}
              onResize={(width) => setSplitStore("leftWidth", clampLeftWidth(width, splitWidth()))}
            />
          </Show>
        </section>

        <section class="flex min-h-[360px] min-w-0 flex-1 flex-col overflow-hidden lg:min-h-0">
          <OpenWikiFileBrowser wikiExists={!!status()?.wikiExists} refreshToken={filesRefreshToken()} />
        </section>
      </div>
    </div>
  )
}
