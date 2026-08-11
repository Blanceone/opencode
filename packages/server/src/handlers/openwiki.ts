import { OpenWiki } from "@opencode-ai/core/openwiki"
import { Effect } from "effect"
import { HttpApiBuilder } from "effect/unstable/httpapi"
import { OpenWikiError } from "@opencode-ai/protocol/groups/openwiki"
import { Api } from "../api"
import { response } from "../location"

const mapError = <A, R>(effect: Effect.Effect<A, OpenWiki.Error, R>) =>
  effect.pipe(Effect.mapError((error) => toError(error)))

function toError(error: OpenWiki.AdapterError) {
  return new OpenWikiError({
    name: "OpenWikiError",
    data: {
      message: error.message,
      ...(error.code ? { code: error.code } : {}),
    },
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
      .handle("openwiki.cancel", () => response(mapError(OpenWiki.Service.use((ow) => ow.cancel())))),
  ),
)
