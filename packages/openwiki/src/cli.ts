#!/usr/bin/env bun
/**
 * CLI for OpenWiki adapter.
 *
 * Model defaults to OpenCode's current selection (model.json / config).
 * Pass --model only to override.
 *
 * Usage:
 *   bun run --cwd packages/openwiki openwiki status --dir <project>
 *   bun run --cwd packages/openwiki openwiki generate --dir <project> --wait
 *   bun run --cwd packages/openwiki openwiki update --dir <project> --wait
 *   bun run --cwd packages/openwiki openwiki cancel --dir <project>
 */
import path from "node:path"
import {
  getOpenWikiStatus,
  startOpenWikiJob,
  cancelOpenWikiJob,
  getJob,
  resolveOpenWikiPackageRoot,
  resolveOpenCodeCurrentModel,
} from "./index.js"

const args = process.argv.slice(2)
const cmd = args[0] || "status"

const flag = (name: string) => {
  const i = args.indexOf(name)
  if (i < 0) return null
  return args[i + 1] ?? null
}

const has = (name: string) => args.includes(name)

const directory = path.resolve(flag("--dir") || process.cwd())
const modelRaw = flag("--model")
const consent = has("--consent")
const consentAction = (flag("--consent-action") as "adopt" | "backup-rebuild" | null) || (consent ? "adopt" : undefined)

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

const printJson = (value: unknown) => {
  console.log(JSON.stringify(value, null, 2))
}

if (cmd === "resolve-package") {
  printJson({ packageRoot: resolveOpenWikiPackageRoot() })
  process.exit(0)
}

if (cmd === "status") {
  const status = await getOpenWikiStatus({
    directory,
    model: modelRaw || undefined,
  })
  printJson(status)
  process.exit(0)
}

if (cmd === "cancel") {
  printJson(await cancelOpenWikiJob(directory))
  process.exit(0)
}

if (cmd === "generate" || cmd === "update" || cmd === "init") {
  const model = resolveOpenCodeCurrentModel({
    directory,
    model: modelRaw || undefined,
  })
  if (!model) {
    console.error("No OpenCode model selected. Pick a model in OpenCode or pass --model provider/model")
    process.exit(1)
  }
  const command = cmd === "update" ? "update" : "init"
  process.stderr.write(`[openwiki] using model ${model.providerID}/${model.modelID}\n`)
  const job = await startOpenWikiJob({
    directory,
    command,
    model,
    consent: consent || undefined,
    consentAction,
  })
  printJson(job)

  if (has("--wait")) {
    while (true) {
      const current = getJob(directory)
      if (!current) break
      process.stderr.write(`\r[openwiki] ${current.stage}${current.detail ? ` — ${current.detail.slice(0, 80)}` : ""}    `)
      if (["completed", "failed", "cancelled"].includes(current.stage)) {
        process.stderr.write("\n")
        printJson(current)
        process.exit(current.stage === "completed" ? 0 : 1)
      }
      await sleep(1000)
    }
  }
  process.exit(0)
}

console.error(`Unknown command: ${cmd}
Commands: status | generate | update | cancel | resolve-package
Flags: --dir <path> [--model provider/model] --consent --consent-action adopt|backup-rebuild --wait
Model defaults to OpenCode's current selection when --model is omitted.`)
process.exit(1)
