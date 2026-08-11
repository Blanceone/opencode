#!/usr/bin/env bun
/**
 * Backfill missing OpenWiki i18n keys into non-English app locale files.
 * Preserves existing newlines; inserts English (or zh) values before the closing brace.
 */
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { dict as en } from "../src/i18n/en"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const i18nDir = path.resolve(__dirname, "../src/i18n")

const KEYS = Object.keys(en).filter(
  (key) => key.startsWith("dialog.openwiki.") || key.startsWith("command.wiki."),
)

const ZH: Record<string, string> = {
  "command.wiki.open": "OpenWiki",
  "command.wiki.open.description": "生成或更新项目 .wiki 知识库",
  "dialog.openwiki.title": "OpenWiki",
  "dialog.openwiki.description": "使用 OpenCode 当前选中的模型",
  "dialog.openwiki.root": "根目录",
  "dialog.openwiki.model": "模型",
  "dialog.openwiki.model.followCurrent": "OpenCode 当前模型",
  "dialog.openwiki.exists": "是否存在",
  "dialog.openwiki.ownership": "归属",
  "dialog.openwiki.login": "登录就绪",
  "dialog.openwiki.job": "任务",
  "dialog.openwiki.yes": "是",
  "dialog.openwiki.no": "否",
  "dialog.openwiki.action.generate": "生成",
  "dialog.openwiki.action.update": "更新",
  "dialog.openwiki.action.refresh": "刷新",
  "dialog.openwiki.consent.prompt": "已有 wiki 内容需要同意后，OpenCode 才能管理。",
  "dialog.openwiki.consent.foreignPaths": "路径",
  "dialog.openwiki.consent.adopt": "接管现有内容",
  "dialog.openwiki.consent.backupRebuild": "备份并重建",
  "dialog.openwiki.format.show": "编辑格式",
  "dialog.openwiki.format.hide": "隐藏格式",
  "dialog.openwiki.format.title": "格式",
  "dialog.openwiki.format.preset": "预设",
  "dialog.openwiki.format.instructions": "说明",
  "dialog.openwiki.format.body": "FORMAT.md",
  "dialog.openwiki.tip.references": "生成成功后会把 references.wiki -> ./.wiki 写入 opencode.json，便于 @wiki 引用。",
  "dialog.openwiki.error.modelRequired": "请先在 OpenCode 中选择模型。",
  "dialog.openwiki.error.consentRequired": "需要先同意后才能生成或编辑此 wiki。",
  "dialog.openwiki.error.noProviderLogin": "提供商 {{provider}} 尚未登录。",
  "dialog.openwiki.error.providerUnsupported": "提供商 {{provider}} 不支持 OpenWiki。",
  "dialog.openwiki.error.opencodeLoginRequired": "此 OpenCode 模型需要 Zen 登录，或改选可匿名使用的免费模型。",
}

const files = fs
  .readdirSync(i18nDir)
  .filter(
    (name) =>
      name.endsWith(".ts") &&
      name !== "en.ts" &&
      !name.includes("desktop") &&
      !name.includes("parity") &&
      !name.includes("test"),
  )

for (const file of files) {
  const locale = path.basename(file, ".ts")
  const full = path.join(i18nDir, file)
  const buf = fs.readFileSync(full)
  const nl = buf.includes(0x0d) ? "\r\n" : "\n"
  let text = buf.toString("utf8")
  const missing = KEYS.filter((key) => !text.includes(`"${key}":`))
  if (missing.length === 0) continue

  const block =
    missing
      .map((key) => {
        const value = locale === "zh" && ZH[key] ? ZH[key] : en[key as keyof typeof en]
        return `  ${JSON.stringify(key)}: ${JSON.stringify(value)},`
      })
      .join(nl) + nl

  const marker = text.lastIndexOf(`}${nl}satisfies`)
  const alt = text.lastIndexOf("} satisfies")
  const insertAt = marker >= 0 ? marker : alt >= 0 ? alt : text.lastIndexOf(`${nl}}`)
  if (insertAt < 0) {
    console.error(`skip ${file}: cannot find insertion point`)
    continue
  }
  text = `${text.slice(0, insertAt)}${block}${text.slice(insertAt)}`
  fs.writeFileSync(full, text, "utf8")
  console.log(`${file}: +${missing.length}`)
}
