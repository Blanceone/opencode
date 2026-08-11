import { Component, For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js"
import { Dialog } from "@opencode-ai/ui/dialog"
import { Button } from "@opencode-ai/ui/button"
import { useSDK } from "@/context/sdk"
import { useLocal } from "@/context/local"
import { useLanguage } from "@/context/language"

type WikiStatus = {
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

async function openwikiFetch<T>(directory: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      "content-type": "application/json",
      "x-opencode-directory": directory,
      ...(init?.headers || {}),
    },
  })
  if (!res.ok) {
    const text = await res.text().catch(() => "")
    throw new Error(text || `${res.status} ${res.statusText}`)
  }
  const json = (await res.json()) as { data?: T } | T
  if (json && typeof json === "object" && "data" in json) return (json as { data: T }).data
  return json as T
}

export const DialogOpenWiki: Component = () => {
  const sdk = useSDK()
  const local = useLocal()
  const language = useLanguage()
  const [status, setStatus] = createSignal<WikiStatus | null>(null)
  const [format, setFormat] = createSignal<FormatBundle | null>(null)
  const [presets, setPresets] = createSignal<FormatPreset[]>([])
  const [error, setError] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [showFormat, setShowFormat] = createSignal(false)

  const directory = () => sdk().directory
  const api = () => sdk().api as Record<string, any>

  const modelRef = createMemo(() => {
    const model = local.model.current()
    if (!model?.provider?.id || !model?.id) return null
    return { providerID: model.provider.id, modelID: model.id }
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
    return jobError.message || null
  }

  const refresh = async () => {
    try {
      const selected = modelRef()
      const client = api()
      const nextStatus: WikiStatus = client.openwikis?.status
        ? (
            await client.openwikis.status({
              location: { directory: directory() },
              ...(selected ? { model: `${selected.providerID}/${selected.modelID}` } : {}),
            })
          ).data
        : await openwikiFetch<WikiStatus>(
            directory(),
            `/api/openwiki/status${
              selected ? `?model=${encodeURIComponent(`${selected.providerID}/${selected.modelID}`)}` : ""
            }`,
          )
      setStatus(nextStatus)

      const nextFormat: FormatBundle = client.openwikis?.formatGet
        ? (await client.openwikis.formatGet({ location: { directory: directory() } })).data
        : await openwikiFetch<FormatBundle>(directory(), "/api/openwiki/format")
      setFormat(nextFormat)

      const nextPresets: FormatPreset[] = client.openwikis?.formatPresets
        ? ((await client.openwikis.formatPresets({ location: { directory: directory() } })).data ?? [])
        : await openwikiFetch<FormatPreset[]>(directory(), "/api/openwiki/format/presets")
      setPresets(nextPresets)

      setError(formatFailure(nextStatus.job?.error))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const run = async (command: "generate" | "update" | "cancel") => {
    setBusy(true)
    setError(null)
    try {
      const selected = modelRef()
      const client = api()
      if (client.openwikis?.[command]) {
        if (command === "cancel") {
          await client.openwikis.cancel({ location: { directory: directory() } })
        } else {
          await client.openwikis[command]({
            location: { directory: directory() },
            ...(selected ? { model: selected } : {}),
          })
        }
      } else if (command === "cancel") {
        await openwikiFetch(directory(), "/api/openwiki/cancel", { method: "POST", body: "{}" })
      } else {
        await openwikiFetch(directory(), `/api/openwiki/${command}`, {
          method: "POST",
          body: JSON.stringify(selected ? { model: selected } : {}),
        })
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const consent = async (consentAction: "adopt" | "backup-rebuild") => {
    setBusy(true)
    setError(null)
    try {
      const client = api()
      if (client.openwikis?.consent) {
        await client.openwikis.consent({
          location: { directory: directory() },
          consent: true,
          consentAction,
        })
      } else {
        await openwikiFetch(directory(), "/api/openwiki/consent", {
          method: "POST",
          body: JSON.stringify({ consent: true, consentAction }),
        })
      }
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
      const client = api()
      if (client.openwikis?.formatPut) {
        const res = await client.openwikis.formatPut({
          location: { directory: directory() },
          ...patch,
        })
        setFormat(res.data)
      } else {
        setFormat(
          await openwikiFetch<FormatBundle>(directory(), "/api/openwiki/format", {
            method: "PUT",
            body: JSON.stringify(patch),
          }),
        )
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  onMount(() => {
    void refresh()
    const timer = setInterval(() => void refresh(), jobActive() ? 1200 : 2500)
    onCleanup(() => clearInterval(timer))
  })

  return (
    <Dialog
      title={language.t("dialog.openwiki.title")}
      description={language.t("dialog.openwiki.description")}
      size="large"
    >
      <div class="flex flex-col gap-3 px-3 pb-3">
        <Show when={status()} fallback={<div class="text-11-regular text-text-weaker">{language.t("common.loading")}</div>}>
          {(s) => (
            <div class="flex flex-col gap-1 text-12-regular">
              <div>
                {language.t("dialog.openwiki.root")}: <span class="text-text-weaker">{s().wikiRoot}</span>
              </div>
              <div>
                {language.t("dialog.openwiki.model")}: <span class="text-text-weaker">{modelLabel()}</span>
              </div>
              <div>
                {language.t("dialog.openwiki.exists")}:{" "}
                {s().wikiExists ? language.t("dialog.openwiki.yes") : language.t("dialog.openwiki.no")} ·{" "}
                {language.t("dialog.openwiki.ownership")}: {s().ownership}
              </div>
              <div>
                {language.t("dialog.openwiki.login")}:{" "}
                {s().hasLogin ? language.t("dialog.openwiki.yes") : language.t("dialog.openwiki.no")}
              </div>
              <Show when={s().job}>
                <div>
                  {language.t("dialog.openwiki.job")}: {s().job!.stage}
                  <Show when={s().job!.detail}> — {s().job!.detail}</Show>
                </div>
              </Show>
              <Show when={formatFailure(s().job?.error) || s().job?.error?.message}>
                <div class="text-text-danger">{formatFailure(s().job?.error) || s().job!.error!.message}</div>
              </Show>
            </div>
          )}
        </Show>

        <Show when={status()?.consentRequired}>
          <div class="flex flex-col gap-2 rounded-md border border-border-weak-base p-2">
            <div class="text-12-regular">{language.t("dialog.openwiki.consent.prompt")}</div>
            <Show when={(status()?.foreignPaths?.length ?? 0) > 0}>
              <div class="text-11-regular text-text-weaker">
                {language.t("dialog.openwiki.consent.foreignPaths")}: {status()!.foreignPaths!.join(", ")}
              </div>
            </Show>
            <div class="flex flex-wrap gap-2">
              <Button size="small" disabled={busy()} onClick={() => void consent("adopt")}>
                {language.t("dialog.openwiki.consent.adopt")}
              </Button>
              <Button size="small" variant="ghost" disabled={busy()} onClick={() => void consent("backup-rebuild")}>
                {language.t("dialog.openwiki.consent.backupRebuild")}
              </Button>
            </div>
          </div>
        </Show>

        <Show when={error()}>
          <div class="text-11-regular text-text-danger">{error()}</div>
        </Show>

        <div class="flex flex-wrap gap-2">
          <Button
            size="small"
            disabled={busy() || !!status()?.consentRequired || status()?.hasLogin === false}
            onClick={() => void run("generate")}
          >
            {language.t("dialog.openwiki.action.generate")}
          </Button>
          <Button
            size="small"
            variant="ghost"
            disabled={busy() || !!status()?.consentRequired || !status()?.wikiExists}
            onClick={() => void run("update")}
          >
            {language.t("dialog.openwiki.action.update")}
          </Button>
          <Button size="small" variant="ghost" disabled={busy() || !jobActive()} onClick={() => void run("cancel")}>
            {language.t("common.cancel")}
          </Button>
          <Button size="small" variant="ghost" disabled={busy()} onClick={() => void refresh()}>
            {language.t("dialog.openwiki.action.refresh")}
          </Button>
          <Button size="small" variant="ghost" disabled={busy()} onClick={() => setShowFormat((v) => !v)}>
            {showFormat()
              ? language.t("dialog.openwiki.format.hide")
              : language.t("dialog.openwiki.format.show")}
          </Button>
        </div>

        <Show when={showFormat() && format()}>
          {(bundle) => (
            <div class="flex flex-col gap-2 border-t border-border-weak-base pt-2">
              <div class="text-12-medium">{language.t("dialog.openwiki.format.title")}</div>
              <label class="flex flex-col gap-1 text-11-regular">
                <span>{language.t("dialog.openwiki.format.preset")}</span>
                <select
                  class="rounded-md border border-border-weak-base bg-transparent px-2 py-1"
                  value={bundle().presetId}
                  disabled={busy() || !!status()?.consentRequired}
                  onChange={(event) => {
                    const presetId = event.currentTarget.value
                    void saveFormat({ presetId, applyPreset: true })
                  }}
                >
                  <For each={presets().length ? presets().map((p) => p.id) : [...PRESET_IDS]}>
                    {(id) => <option value={id}>{id}</option>}
                  </For>
                </select>
              </label>
              <label class="flex flex-col gap-1 text-11-regular">
                <span>{language.t("dialog.openwiki.format.instructions")}</span>
                <textarea
                  class="min-h-24 rounded-md border border-border-weak-base bg-transparent px-2 py-1 font-mono text-11-regular"
                  value={bundle().instructions}
                  disabled={busy() || !!status()?.consentRequired}
                  onInput={(event) =>
                    setFormat({
                      ...bundle(),
                      instructions: event.currentTarget.value,
                      presetId: "custom",
                    })
                  }
                />
              </label>
              <label class="flex flex-col gap-1 text-11-regular">
                <span>{language.t("dialog.openwiki.format.body")}</span>
                <textarea
                  class="min-h-24 rounded-md border border-border-weak-base bg-transparent px-2 py-1 font-mono text-11-regular"
                  value={bundle().format}
                  disabled={busy() || !!status()?.consentRequired}
                  onInput={(event) =>
                    setFormat({
                      ...bundle(),
                      format: event.currentTarget.value,
                      presetId: "custom",
                    })
                  }
                />
              </label>
              <div>
                <Button
                  size="small"
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
            </div>
          )}
        </Show>

        <div class="text-11-regular text-text-weaker">{language.t("dialog.openwiki.tip.references")}</div>
      </div>
    </Dialog>
  )
}
