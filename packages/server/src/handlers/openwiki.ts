import { OpenWiki } from "@opencode-ai/core/openwiki"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import {
  OpenWikiConflictError,
  OpenWikiError,
  OpenWikiServerError,
  OpenWikiUnauthorizedError,
} from "@opencode-ai/protocol/groups/openwiki"
import { Api } from "../api"
import { response } from "../location"

const mapError = <A, R>(effect: Effect.Effect<A, OpenWiki.Error, R>) =>
  effect.pipe(Effect.mapError((error) => toError(error)))

function toError(error: OpenWiki.AdapterError) {
  const data = {
    message: error.message,
    ...(error.code ? { code: error.code } : {}),
  }
  if (error.statusCode === 409) {
    return new OpenWikiConflictError({ name: "OpenWikiConflictError", data })
  }
  if (error.statusCode === 401) {
    return new OpenWikiUnauthorizedError({ name: "OpenWikiUnauthorizedError", data })
  }
  if (error.statusCode === 500) {
    return new OpenWikiServerError({ name: "OpenWikiServerError", data })
  }
  return new OpenWikiError({
    name: "OpenWikiError",
    data,
  })
}

export const OpenWikiHandler = HttpApiBuilder.group(Api, "server.openwiki", (handlers) =>
  Effect.succeed(
    handlers
      .handle("openwiki.status", (ctx) =>
        response(
          mapError(
            OpenWiki.Service.use((ow) =>
              ow.status({
                model: ctx.query.model,
                openWikiModelOverride: ctx.query.openWikiModelOverride,
              }),
            ),
          ),
        ),
      )
      .handle("openwiki.format.get", () => response(mapError(OpenWiki.Service.use((ow) => ow.formatGet()))))
      .handle("openwiki.format.put", (ctx) =>
        response(mapError(OpenWiki.Service.use((ow) => ow.formatPut(ctx.payload)))),
      )
      .handle("openwiki.format.presets", () => response(OpenWiki.Service.use((ow) => ow.formatPresets())))
      .handle("openwiki.consent", (ctx) =>
        response(mapError(OpenWiki.Service.use((ow) => ow.consent(ctx.payload)))),
      )
      .handle("openwiki.generate", (ctx) =>
        response(mapError(OpenWiki.Service.use((ow) => ow.generate(ctx.payload)))),
      )
      .handle("openwiki.update", (ctx) => response(mapError(OpenWiki.Service.use((ow) => ow.update(ctx.payload)))))
      .handle("openwiki.job", () => response(OpenWiki.Service.use((ow) => ow.job())))
      .handle("openwiki.cancel", () => response(mapError(OpenWiki.Service.use((ow) => ow.cancel()))))
      .handle("openwiki.referenceSources.list", () =>
        response(mapError(OpenWiki.Service.use((ow) => ow.referenceSourcesList()))),
      )
      .handle("openwiki.referenceSources.add", (ctx) =>
        response(mapError(OpenWiki.Service.use((ow) => ow.referenceSourcesAdd(ctx.payload)))),
      )
      .handle("openwiki.referenceSources.remove", (ctx) =>
        response(mapError(OpenWiki.Service.use((ow) => ow.referenceSourcesRemove(ctx.payload)))),
      )
      .handle("openwiki.format.draft", () => response(mapError(OpenWiki.Service.use((ow) => ow.formatDraft()))))
      .handle("openwiki.format.parse", (ctx) =>
        response(mapError(OpenWiki.Service.use((ow) => ow.formatParse(ctx.payload)))),
      )
      .handle("openwiki.format.merge", (ctx) =>
        response(mapError(OpenWiki.Service.use((ow) => ow.formatMerge(ctx.payload)))),
      )
      .handle("openwiki.format.reset", () => response(mapError(OpenWiki.Service.use((ow) => ow.formatReset()))))
      .handle("openwiki.export.docx", () => response(mapError(OpenWiki.Service.use((ow) => ow.exportDocx())))),
  ),
)
