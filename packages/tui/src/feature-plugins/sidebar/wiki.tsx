import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { createSignal, onCleanup, Show } from "solid-js"

const id = "internal:sidebar-wiki"

type Status = {
  wikiExists?: boolean
  ownership?: string
  consentRequired?: boolean
  hasLogin?: boolean
  foreignPaths?: string[]
  model?: { providerID?: string; modelID?: string } | null
  job?: { stage?: string; detail?: string; error?: { message?: string; code?: string } } | null
}

const ACTIVE = new Set(["queued", "preparing", "mapping-model", "running", "writing"])

function View(props: { api: TuiPluginApi }) {
  const [open, setOpen] = createSignal(true)
  const [status, setStatus] = createSignal<Status | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const theme = () => props.api.theme.current

  const refresh = async () => {
    try {
      const client = props.api.client as any
      if (client?.openwikis?.status) {
        const res = await client.openwikis.status({})
        setStatus(res?.data ?? res)
        setError(null)
        return
      }
      setError("OpenWiki API unavailable — restart server after client generate")
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
      const client = props.api.client as any
      if (!client?.openwikis?.[command]) {
        setError("OpenWiki client methods missing")
        return
      }
      if (command === "cancel") await client.openwikis.cancel({})
      else await client.openwikis[command]({})
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
      const client = props.api.client as any
      if (!client?.openwikis?.consent) {
        setError("OpenWiki consent API missing")
        return
      }
      await client.openwikis.consent({ consent: true, consentAction })
      await refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const modelLabel = () => {
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
