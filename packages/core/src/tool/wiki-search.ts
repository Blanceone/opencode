export * as WikiSearchTool from "./wiki-search"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import path from "path"
import fs from "fs/promises"
import { Location } from "../location"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolFailure } from "@opencode-ai/llm"

export const name = "wiki_search"

const Input = Schema.Struct({
  query: Schema.String.annotate({ description: "Case-insensitive substring to find in .wiki Markdown files" }),
  limit: Schema.optional(Schema.Number).annotate({ description: "Max matches (default 20)" }),
})

const Hit = Schema.Struct({
  path: Schema.String,
  line: Schema.Number,
  text: Schema.String,
})

const Output = Schema.Struct({
  hits: Schema.Array(Hit),
})

async function listMarkdown(root: string): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()!
    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === "." || entry.name === ".." || entry.name === "node_modules" || entry.name === ".git") continue
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (entry.isFile() && entry.name.toLowerCase().endsWith(".md")) out.push(full)
    }
  }
  return out
}

async function searchWiki(wikiRoot: string, needle: string, limit: number) {
  const hits: { path: string; line: number; text: string }[] = []
  let files: string[] = []
  try {
    files = await listMarkdown(wikiRoot)
  } catch {
    return hits
  }
  for (const file of files) {
    if (hits.length >= limit) break
    let text = ""
    try {
      text = await fs.readFile(file, "utf8")
    } catch {
      continue
    }
    const rel = path.relative(wikiRoot, file).replace(/\\/g, "/")
    const lines = text.split(/\r?\n/)
    for (let i = 0; i < lines.length; i++) {
      if (hits.length >= limit) break
      const line = lines[i]!
      if (line.toLowerCase().includes(needle)) {
        hits.push({ path: rel, line: i + 1, text: line.slice(0, 240) })
      }
    }
  }
  return hits
}

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Search Markdown under the project OpenWiki (.wiki/) for a substring. Returns matching lines with relative paths.",
          input: Input,
          output: Output,
          execute: (input) =>
            Effect.gen(function* () {
              const wikiRoot = path.join(location.directory, ".wiki")
              const needle = input.query.trim().toLowerCase()
              if (!needle) return { hits: [] }
              const limit = Math.min(Math.max(Number(input.limit) || 20, 1), 100)
              const hits = yield* Effect.tryPromise({
                try: () => searchWiki(wikiRoot, needle, limit),
                catch: () => new ToolFailure({ message: "Unable to search wiki" }),
              })
              return { hits }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/wiki-search",
  layer,
  deps: [ToolRegistry.node, Location.node],
})
