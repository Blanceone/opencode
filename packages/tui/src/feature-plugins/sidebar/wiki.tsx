import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { OpenCode } from "@opencode-ai/openwiki/http-client"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onCleanup, Show } from "solid-js"
import { useLocal } from "../../context/local"
import { useSDK } from "../../context/sdk"

const id = "internal:sidebar-wiki"

type Status = {
  wikiExists?: boolean
  ownership?: string
  consentRequired?: boolean
  hasLogin?: boolean
  foreignPaths?: readonly string[]
  model?: { providerID?: string; modelID?: string } | null
  job?: { stage?: string; detail?: string; error?: { message?: string; code?: string } } | null
}

const ACTIVE = new Set(["queued", "preparing", "mapping-model", "running", "writing"])

function View(props: { api: TuiPluginApi }) {
  const sdk = useSDK()
  const local = useLocal()
  const [open, setOpen] = createSignal(true)
  const [status, setStatus] = createSignal<Status | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const theme = () => props.api.theme.current

  const selectedModel = () => {
    const model = local.model.current()
    if (!model?.providerID || !model?.modelID) return null
    return { providerID: model.providerID, modelID: model.modelID }
  }

  const openwiki = () =>
    OpenCode.make({
      baseUrl: sdk.url,
      fetch: sdk.fetch,
    }).openwikis

  const location = () => {
    const directory = sdk.directory ?? props.api.state.path.directory
    return directory ? { directory } : undefined
  }

  const refresh = async () => {
    const loc = location()
    // Never omit location: the server would fall back to process.cwd() and
    // operate on a directory other than the open workspace.
    if (!loc) {
      setError("workspace directory unavailable")
      return
    }
    try {
      const model = selectedModel()
      const res = await openwiki().status({
        location: loc,
        model: model ? `${model.providerID}/${model.modelID}` : undefined,
      })
      setStatus(res.data)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  void refresh()
  const timer = setInterval(() => void refresh(), 3000)
  onCleanup(() => clearInterval(timer))

  const run = async (command: "generate" | "update" | "cancel") => {
    setBusy(true)
    setError(null)
    try {
      const api = openwiki()
      const loc = location()
      if (!loc) throw new Error("workspace directory unavailable")
      if (command === "cancel") {
        await api.cancel({ location: loc })
      } else {
        const model = selectedModel()
        await api[command]({
          location: loc,
          ...(model ? { model } : {}),
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
      const loc = location()
      if (!loc) throw new Error("workspace directory unavailable")
      await openwiki().consent({ location: loc, consent: true, consentAction })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const modelLabel = () => {
    const selected = selectedModel()
    if (selected) return `model: ${selected.providerID}/${selected.modelID}`
    const model = status()?.model
    if (!model?.providerID || !model?.modelID) return "model: (OpenCode current)"
    return `model: ${model.providerID}/${model.modelID}`
  }

  const jobActive = () => {
    const stage = status()?.job?.stage
    return !!stage && ACTIVE.has(stage)
  }

  return (
    <box>
      <box flexDirection="row" gap={1} onMouseDown={() => setOpen((x) => !x)}>
        <text fg={theme().text}>{open() ? "▼" : "▶"}</text>
        <text fg={theme().text}>
          <b>Wiki</b>
        </text>
        <Show when={status()?.job?.stage}>
          <text fg={theme().textMuted}> {status()?.job?.stage}</text>
        </Show>
      </box>
      <Show when={open()}>
        <box>
          <text fg={theme().textMuted}>
            {status()?.wikiExists ? `ownership: ${status()?.ownership}` : "no .wiki yet"}
            {status()?.consentRequired ? " (consent required)" : ""}
          </text>
          <text fg={theme().textMuted}>{modelLabel()}</text>
          <Show when={status()?.hasLogin === false}>
            <text fg={theme().error}>login required for selected model</text>
          </Show>
          <Show when={status()?.job?.detail}>
            <text fg={theme().textMuted}>{status()?.job?.detail}</text>
          </Show>
          <Show when={status()?.job?.error?.message}>
            <text fg={theme().error}>{status()?.job?.error?.message}</text>
          </Show>
          <Show when={error()}>
            <text fg={theme().error}>{error()}</text>
          </Show>
          <Show when={status()?.consentRequired}>
            <box flexDirection="row" gap={1}>
              <text
                fg={busy() ? theme().textMuted : theme().primary}
                onMouseDown={() => !busy() && void consent("adopt")}
              >
                [adopt]
              </text>
              <text
                fg={busy() ? theme().textMuted : theme().warning}
                onMouseDown={() => !busy() && void consent("backup-rebuild")}
              >
                [backup-rebuild]
              </text>
            </box>
          </Show>
          <box flexDirection="row" gap={1}>
            <text
              fg={busy() || status()?.consentRequired ? theme().textMuted : theme().primary}
              onMouseDown={() => !busy() && !status()?.consentRequired && void run("generate")}
            >
              [generate]
            </text>
            <text
              fg={busy() || status()?.consentRequired || !status()?.wikiExists ? theme().textMuted : theme().primary}
              onMouseDown={() =>
                !busy() && !status()?.consentRequired && status()?.wikiExists && void run("update")
              }
            >
              [update]
            </text>
            <text
              fg={busy() || !jobActive() ? theme().textMuted : theme().warning}
              onMouseDown={() => !busy() && jobActive() && void run("cancel")}
            >
              [cancel]
            </text>
            <text fg={theme().textMuted} onMouseDown={() => void refresh()}>
              [refresh]
            </text>
          </box>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api) => {
  api.slots.register({
    order: 250,
    slots: {
      sidebar_content() {
        return <View api={api} />
      },
    },
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
