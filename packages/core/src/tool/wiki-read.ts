export * as WikiReadTool from "./wiki-read"

import { Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "../effect/app-node"
import path from "path"
import fs from "fs/promises"
import { Location } from "../location"
import { ToolRegistry } from "./registry"
import { Tool } from "./tool"
import { Tools } from "./tools"
import { ToolFailure } from "@opencode-ai/llm"

export const name = "wiki_read"

const Input = Schema.Struct({
  path: Schema.String.annotate({
    description: "Path relative to .wiki/ (e.g. index.md or architecture/overview.md)",
  }),
})

const Output = Schema.Struct({
  path: Schema.String,
  content: Schema.String,
})

const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const tools = yield* Tools.Service
    const location = yield* Location.Service

    yield* tools
      .register({
        [name]: Tool.make({
          description:
            "Read a Markdown page from the project OpenWiki under .wiki/. Paths are relative to .wiki/ and cannot escape that directory.",
          input: Input,
          output: Output,
          execute: (input) =>
            Effect.gen(function* () {
              const wikiRoot = path.join(location.directory, ".wiki")
              const rel = input.path.replace(/^[/\\]+/, "").replace(/\\/g, "/")
              if (!rel || rel.includes("..")) {
                return yield* Effect.fail(new ToolFailure({ message: "Invalid wiki path" }))
              }
              const resolvedRoot = path.resolve(wikiRoot)
              const target = path.resolve(wikiRoot, rel)
              if (target !== resolvedRoot && !target.startsWith(resolvedRoot + path.sep)) {
                return yield* Effect.fail(new ToolFailure({ message: "Path escapes .wiki/" }))
              }
              const content = yield* Effect.tryPromise({
                try: () => fs.readFile(target, "utf8"),
                catch: (error) =>
                  new ToolFailure({
                    message: error instanceof Error ? error.message : String(error),
                  }),
              })
              return { path: rel, content }
            }),
        }),
      })
      .pipe(Effect.orDie)
  }),
)

export const node = makeLocationNode({
  name: "tool/wiki-read",
  layer,
  deps: [ToolRegistry.node, Location.node],
})
