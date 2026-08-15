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

type ReferenceSourceFile = {
  id: string
  name: string
  size: number
  extension: string
  modifiedAt: number
}

type FormatDraft = {
  instructions: string
  format: string
  warnings: string[]
  sourceFiles: string[]
}

const PRESET_IDS = ["openwiki-default", "architecture-module", "api-service", "custom"] as const

const ACTIVE_STAGES = new Set(["queued", "preparing", "mapping-model", "running", "writing"])
const DETAIL_DISPLAY_MAX = 160
const POLL_ACTIVE_MS = 1000
const POLL_IDLE_MS = 4000
const POLL_BACKOFF_MAX_MS = 30_000
const REFERENCE_CONFIRM_BYTES = 10 * 1024 * 1024
const REFERENCE_ACCEPT =
  ".md,.doc,.docx,text/markdown,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document"

function truncateDetail(detail: string | undefined) {
  if (!detail) return undefined
  const compact = detail.replace(/\s+/g, " ").trim()
  if (compact.length <= DETAIL_DISPLAY_MAX) return compact
  return `${compact.slice(0, DETAIL_DISPLAY_MAX)}…`
}

function fileToBase64(file: File) {
  return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer)
    let binary = ""
    const chunk = 0x8000
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk))
    }
    return btoa(binary)
  })
}

function downloadBase64File(fileName: string, contentBase64: string, mime: string) {
  const binary = atob(contentBase64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  const blob = new Blob([bytes], { type: mime })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
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
  const [activeAction, setActiveAction] = createSignal<"generate" | "update" | "parse" | "export" | null>(null)
  const [pollPaused, setPollPaused] = createSignal(false)
  const [pollDelayMs, setPollDelayMs] = createSignal(POLL_IDLE_MS)
  const [lastNotifiedStage, setLastNotifiedStage] = createSignal<string | null>(null)
  const [filesRefreshToken, setFilesRefreshToken] = createSignal(0)
  const [references, setReferences] = createSignal<ReferenceSourceFile[]>([])
  const [draft, setDraft] = createSignal<FormatDraft | null>(null)
  let referenceInput: HTMLInputElement | undefined
  const REFERENCE_EXTENSIONS = ["md", "doc", "docx"]

  // Desktop: use the platform's native attachment picker (IPC-based Electron
  // dialog) which reliably reads file content in the sandboxed renderer. HTML
  // <input type="file"> can silently fail under Electron's sandbox.
  const pickReferenceFiles = async () => {
    if (platform.openAttachmentPickerDialog) {
      const files: File[] = []
      try {
        await platform.openAttachmentPickerDialog(
          {
            multiple: true,
            extensions: REFERENCE_EXTENSIONS,
            title: language.t("dialog.openwiki.references.import"),
          },
          async (file: File) => {
            files.push(file)
          },
        )
      } catch (e) {
        setError(formatCaughtError(e))
        return
      }
      if (files.length > 0) await importReferenceFiles(files)
      return
    }
    referenceInput?.click()
  }

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

  const workspacePath = createMemo(() => directory())

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
      directory: directory(),
    })
  }

  /** Fallback when generated client hits a server without /api/openwiki (stale sidecar). */
  const openwikiFetch = async <T,>(path: string, init?: RequestInit): Promise<T> => {
    if (!directory()) throw new Error("OpenWiki requires the current workspace directory")
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

  const toReferenceFiles = (
    data: {
      files: ReadonlyArray<{
        id: string
        name: string
        size: number | string
        extension: string
        modifiedAt: number | string
      }>
    },
  ): ReferenceSourceFile[] =>
    data.files.map((file) => ({
      id: file.id,
      name: file.name,
      size: Number(file.size),
      extension: file.extension,
      modifiedAt: Number(file.modifiedAt),
    }))

  const toFormatDraft = (
    data: null | undefined | {
      instructions: string
      format: string
      warnings?: ReadonlyArray<string>
      sourceFiles?: ReadonlyArray<string>
    },
  ): FormatDraft | null => {
    if (!data) return null
    return {
      instructions: data.instructions,
      format: data.format,
      warnings: [...(data.warnings ?? [])],
      sourceFiles: [...(data.sourceFiles ?? [])],
    }
  }

  const presetLabel = (id: string) => {
    if (id === "openwiki-default") return language.t("dialog.openwiki.format.preset.openwiki-default")
    if (id === "architecture-module") return language.t("dialog.openwiki.format.preset.architecture-module")
    if (id === "api-service") return language.t("dialog.openwiki.format.preset.api-service")
    if (id === "custom") return language.t("dialog.openwiki.format.preset.custom")
    return id
  }

  // Single-flight guard: the poll interval can fire while requests are still
  // in flight; overlapping refreshes would interleave and let a stale response
  // overwrite newer state.
  let refreshInFlight = false
  const refresh = async () => {
    if (refreshInFlight) return
    refreshInFlight = true
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
      const nextRefs = await withOpenWiki(
        async () => toReferenceFiles(unwrapOpenWikiData(await api.referenceSourcesList({ location }))),
        async () =>
          toReferenceFiles(await openwikiFetch<{ files: ReferenceSourceFile[] }>("/api/openwiki/reference-sources")),
      )
      setReferences(nextRefs)
      const nextDraft = await withOpenWiki(
        async () => toFormatDraft(unwrapOpenWikiData(await api.formatDraft({ location })).draft),
        async () =>
          toFormatDraft(
            (await openwikiFetch<{ draft: FormatDraft | null }>("/api/openwiki/format/draft")).draft,
          ),
      )
      setDraft(nextDraft)
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
    } finally {
      refreshInFlight = false
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

  const importReferenceFiles = async (fileList: FileList | File[]) => {
    const files = Array.from(fileList).filter((file) => /\.(md|doc|docx)$/i.test(file.name))
    if (files.length === 0) {
      setError(language.t("dialog.openwiki.references.typeHint"))
      return
    }
    const needsConfirm = files.some((file) => file.size > REFERENCE_CONFIRM_BYTES)
    if (
      needsConfirm &&
      typeof globalThis.confirm === "function" &&
      !globalThis.confirm(language.t("dialog.openwiki.references.confirmLarge"))
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const payload = {
        confirmLarge: needsConfirm,
        files: await Promise.all(
          files.map(async (file) => ({
            name: file.name,
            contentBase64: await fileToBase64(file),
            confirmLarge: file.size > REFERENCE_CONFIRM_BYTES,
          })),
        ),
      }
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      const listed = await withOpenWiki(
        async () => toReferenceFiles(unwrapOpenWikiData(await api.referenceSourcesAdd({ location, ...payload }))),
        async () =>
          toReferenceFiles(
            await openwikiFetch<{ files: ReferenceSourceFile[] }>("/api/openwiki/reference-sources", {
              method: "POST",
              body: JSON.stringify(payload),
            }),
          ),
      )
      setReferences(listed)
      showToast({
        title: language.t("dialog.openwiki.references.title"),
        description: language.t("dialog.openwiki.references.imported", { count: files.length }),
        variant: "success",
      })
    } catch (e) {
      setError(formatCaughtError(e))
    } finally {
      setBusy(false)
    }
  }

  const removeReference = async (id: string) => {
    setBusy(true)
    setError(null)
    try {
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      const listed = await withOpenWiki(
        async () => toReferenceFiles(unwrapOpenWikiData(await api.referenceSourcesRemove({ location, id }))),
        async () =>
          toReferenceFiles(
            await openwikiFetch<{ files: ReferenceSourceFile[] }>("/api/openwiki/reference-sources/remove", {
              method: "POST",
              body: JSON.stringify({ id }),
            }),
          ),
      )
      setReferences(listed)
    } catch (e) {
      setError(formatCaughtError(e))
    } finally {
      setBusy(false)
    }
  }

  const parseReferences = async () => {
    if (working() || references().length === 0) return
    setBusy(true)
    setActiveAction("parse")
    setError(null)
    try {
      const selected = modelRef()
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      const body = selected ? { model: selected } : {}
      await withOpenWiki(
        async () => api.formatParse({ location, ...body }),
        async () =>
          openwikiFetch("/api/openwiki/format/parse", {
            method: "POST",
            body: JSON.stringify(body),
          }),
      )
      await refresh()
    } catch (e) {
      setError(formatCaughtError(e))
      await refresh()
    } finally {
      setBusy(false)
      if (!ACTIVE_STAGES.has(status()?.job?.stage || "")) setActiveAction(null)
    }
  }

  const mergeDraft = async () => {
    if (working() || !draft()) return
    setBusy(true)
    setError(null)
    try {
      const selected = modelRef()
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      const body = selected ? { model: selected } : {}
      const result = await withOpenWiki(
        async () => {
          const data = unwrapOpenWikiData(await api.formatMerge({ location, ...body }))
          return {
            bundle: toFormatBundle(data.bundle),
            draft: toFormatDraft(data.draft)!,
          }
        },
        async () => {
          const data = await openwikiFetch<{
            bundle: FormatBundle
            draft: FormatDraft
          }>("/api/openwiki/format/merge", {
            method: "POST",
            body: JSON.stringify(body),
          })
          return {
            bundle: toFormatBundle(data.bundle),
            draft: toFormatDraft(data.draft)!,
          }
        },
      )
      setFormat(result.bundle)
      setFormatDirty(false)
      setFormatEpoch((n) => n + 1)
      setDraft(result.draft)
      showToast({
        title: language.t("dialog.openwiki.format.title"),
        description: language.t("dialog.openwiki.merge.done"),
        variant: "success",
      })
    } catch (e) {
      setError(formatCaughtError(e))
    } finally {
      setBusy(false)
    }
  }

  const resetFormat = async () => {
    if (
      typeof globalThis.confirm === "function" &&
      !globalThis.confirm(language.t("dialog.openwiki.format.reset.confirm"))
    ) {
      return
    }
    setBusy(true)
    setError(null)
    try {
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      setFormat(
        await withOpenWiki(
          async () => toFormatBundle(unwrapOpenWikiData(await api.formatReset({ location }))),
          async () =>
            openwikiFetch<FormatBundle>("/api/openwiki/format/reset", {
              method: "POST",
              body: "{}",
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

  const exportDocx = async () => {
    if (working() || !status()?.wikiExists) return
    setBusy(true)
    setActiveAction("export")
    setError(null)
    try {
      const location = openWikiLocation(directory())
      const api = openwikiApi()
      const payload = await withOpenWiki(
        async () => {
          const data = unwrapOpenWikiData(await api.exportDocx({ location }))
          return data.files.map((file) => ({
            fileName: file.fileName,
            contentBase64: file.contentBase64,
          }))
        },
        async () =>
          (
            await openwikiFetch<{
              files: Array<{ fileName: string; contentBase64: string }>
            }>("/api/openwiki/export/docx", { method: "POST", body: "{}" })
          ).files,
      )
      if (!payload.length) {
        setError(language.t("dialog.openwiki.export.empty"))
        return
      }
      for (const file of payload) {
        downloadBase64File(
          file.fileName,
          file.contentBase64,
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
      }
      showToast({
        title: language.t("dialog.openwiki.action.exportDocx"),
        description: language.t("dialog.openwiki.export.done", { count: payload.length }),
        variant: "success",
      })
    } catch (e) {
      setError(formatCaughtError(e))
    } finally {
      setBusy(false)
      setActiveAction(null)
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
          class="relative flex min-h-0 min-w-0 flex-col border-b border-border-weak-base lg:border-b-0 lg:shrink-0"
          style={
            desktopSplit()
              ? {
                  width: `${leftWidth()}px`,
                  ...(roomySplit() ? { "min-width": `${LEFT_PANEL_MIN}px` } : undefined),
                }
              : undefined
          }
        >
          <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
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
                disabled={busy() || !status()?.wikiExists || working()}
                onClick={() => void exportDocx()}
              >
                <Show when={activeAction() === "export"} fallback={language.t("dialog.openwiki.action.exportDocx")}>
                  <span class="inline-flex items-center gap-1.5">
                    <Spinner class="size-3.5" />
                    {language.t("dialog.openwiki.export.preparing")}
                  </span>
                </Show>
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
                <div class="flex min-h-0 min-w-0 flex-1 flex-col gap-5">
                  <div class="flex shrink-0 flex-wrap items-center gap-2">
                    <Button
                      size="normal"
                      variant="secondary"
                      disabled={busy() || !!status()?.consentRequired || !formatDirty()}
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
                    <Button
                      size="normal"
                      variant="ghost"
                      disabled={busy() || !!status()?.consentRequired}
                      onClick={() => void resetFormat()}
                    >
                      {language.t("dialog.openwiki.format.reset")}
                    </Button>
                    <label class="ms-auto flex min-w-[160px] max-w-xs flex-col gap-1 text-11-regular text-text-weaker">
                      <span>{language.t("dialog.openwiki.format.preset")}</span>
                      <select
                        class="h-8 w-full rounded-md border border-border-weak-base bg-transparent px-2 text-12-regular text-text-weak"
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
                  </div>

                  <label class="flex min-h-[160px] min-w-0 flex-1 flex-col gap-1.5 text-12-regular">
                    <span class="shrink-0 text-text-weak">{language.t("dialog.openwiki.format.instructions")}</span>
                    <textarea
                      class="min-h-[140px] w-full flex-1 resize-y overflow-auto rounded-lg border border-border-weak-base bg-transparent px-3 py-3 font-mono text-12-regular leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong-base"
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
                  <label class="flex min-h-[200px] min-w-0 flex-[1.2] flex-col gap-1.5 text-12-regular">
                    <span class="shrink-0 text-text-weak">{language.t("dialog.openwiki.format.body")}</span>
                    <textarea
                      class="min-h-[180px] w-full flex-1 resize-y overflow-auto rounded-lg border border-border-weak-base bg-transparent px-3 py-3 font-mono text-12-regular leading-5 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-border-strong-base"
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

                  <div class="flex shrink-0 flex-col gap-2 border-t border-border-weak-base pt-4">
                    <div class="text-12-medium text-text-weak">{language.t("dialog.openwiki.references.title")}</div>
                    <div class="text-11-regular text-text-weaker">{language.t("dialog.openwiki.references.typeHint")}</div>
                    <div class="text-11-regular text-text-weaker">{language.t("dialog.openwiki.references.limitHint")}</div>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={busy() || !!status()?.consentRequired}
                        onClick={() => void pickReferenceFiles()}
                      >
                        {language.t("dialog.openwiki.references.import")}
                      </Button>
                      <input
                        ref={(el) => {
                          referenceInput = el
                        }}
                        type="file"
                        class="hidden"
                        multiple
                        accept={REFERENCE_ACCEPT}
                        onChange={(event) => {
                          const list = event.currentTarget.files
                          event.currentTarget.value = ""
                          if (list?.length) void importReferenceFiles(list)
                        }}
                      />
                    </div>
                    <Show
                      when={references().length > 0}
                      fallback={
                        <div class="text-11-regular text-text-weaker">{language.t("dialog.openwiki.references.empty")}</div>
                      }
                    >
                      <ul class="flex flex-col gap-1.5">
                        <For each={references()}>
                          {(file) => (
                            <li class="flex items-center gap-2 rounded-md border border-border-weak-base px-2.5 py-1.5 text-12-regular">
                              <span class="min-w-0 flex-1 truncate" title={file.name}>
                                {file.name}
                              </span>
                              <Button
                                size="small"
                                variant="ghost"
                                disabled={busy() || !!status()?.consentRequired}
                                onClick={() => void removeReference(file.id)}
                              >
                                {language.t("dialog.openwiki.references.remove")}
                              </Button>
                            </li>
                          )}
                        </For>
                      </ul>
                    </Show>
                  </div>

                  <div class="flex shrink-0 flex-col gap-2 border-t border-border-weak-base pt-4">
                    <div class="text-12-medium text-text-weak">{language.t("dialog.openwiki.parse.title")}</div>
                    <div class="text-11-regular text-text-weaker">{language.t("dialog.openwiki.parse.info")}</div>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        size="small"
                        variant="secondary"
                        disabled={
                          working() ||
                          !!status()?.consentRequired ||
                          status()?.hasLogin === false ||
                          references().length === 0
                        }
                        onClick={() => void parseReferences()}
                      >
                        <Show when={activeAction() === "parse"} fallback={language.t("dialog.openwiki.parse.action")}>
                          <span class="inline-flex items-center gap-1.5">
                            <Spinner class="size-3" />
                            {language.t("dialog.openwiki.parse.parsing")}
                          </span>
                        </Show>
                      </Button>
                      <Button
                        size="small"
                        variant="ghost"
                        disabled={working() || !!status()?.consentRequired || !draft()}
                        onClick={() => void mergeDraft()}
                      >
                        {language.t("dialog.openwiki.merge.action")}
                      </Button>
                    </div>
                    <Show
                      when={draft()}
                      fallback={
                        <div class="text-11-regular text-text-weaker">{language.t("dialog.openwiki.draft.empty")}</div>
                      }
                    >
                      {(d) => (
                        <div class="flex flex-col gap-2">
                          <div class="text-12-medium text-text-weak">{language.t("dialog.openwiki.draft.title")}</div>
                          <Show when={d().warnings.length > 0}>
                            <div class="text-11-regular text-text-danger">
                              {language.t("dialog.openwiki.draft.warnings")}: {d().warnings.join(" · ")}
                            </div>
                          </Show>
                          <label class="flex flex-col gap-1 text-12-regular">
                            <span class="text-text-weak">{language.t("dialog.openwiki.draft.instructions")}</span>
                            <textarea
                              class="min-h-[100px] w-full resize-y rounded-lg border border-border-weak-base bg-transparent px-3 py-2 font-mono text-12-regular leading-5"
                              value={d().instructions}
                              readOnly
                            />
                          </label>
                          <label class="flex flex-col gap-1 text-12-regular">
                            <span class="text-text-weak">{language.t("dialog.openwiki.draft.format")}</span>
                            <textarea
                              class="min-h-[120px] w-full resize-y rounded-lg border border-border-weak-base bg-transparent px-3 py-2 font-mono text-12-regular leading-5"
                              value={d().format}
                              readOnly
                            />
                          </label>
                        </div>
                      )}
                    </Show>
                  </div>
                </div>
              )}
            </Show>
          </div>
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
