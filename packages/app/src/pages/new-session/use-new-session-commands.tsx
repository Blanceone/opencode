import { useLocation, useNavigate } from "@solidjs/router"
import { useDialog } from "@opencode-ai/ui/context/dialog"
import { useSettingsCommand } from "@/components/settings-dialog"
import { useCommand } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useSDK } from "@/context/sdk"
import { wikiHref } from "@/utils/session-route"

export function useNewSessionCommands(input: {
  restoreFocus: () => void
  project: {
    empty: () => boolean
    open: () => void
  }
}) {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const navigate = useNavigate()
  const location = useLocation()
  const sdk = useSDK()

  useSettingsCommand()
  command.register("new-session", () => [
    {
      id: "command.palette",
      title: language.t("command.palette"),
      hidden: true,
      onSelect: async () => {
        const { DialogSelectFile } = await import("@/components/dialog-select-file")
        void dialog.show(() => <DialogSelectFile />)
      },
    },
    {
      id: "input.focus",
      title: language.t("command.input.focus"),
      category: language.t("command.category.view"),
      keybind: "ctrl+l",
      onSelect: input.restoreFocus,
    },
    {
      id: "project.select",
      title: language.t("session.new.project.search"),
      category: language.t("command.category.project"),
      keybind: "mod+shift+o",
      disabled: input.project.empty(),
      onSelect: input.project.open,
    },
    {
      id: "wiki.open",
      title: language.t("command.wiki.open"),
      description: language.t("command.wiki.open.description"),
      category: language.t("command.category.project"),
      slash: "wiki",
      disabled: input.project.empty(),
      onSelect: () => {
        const directory = sdk().directory
        if (!directory) return
        navigate(wikiHref(directory, location.pathname + location.search))
        input.restoreFocus()
      },
    },
  ])
}
