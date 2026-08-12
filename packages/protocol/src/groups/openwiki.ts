import { OpenWiki } from "@opencode-ai/schema/openwiki"
import { Location } from "@opencode-ai/schema/location"
import { Schema } from "effect"
import { HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"
import { InvalidRequestError } from "../errors"
import { LocationQuery, locationQueryOpenApi } from "./location"

const OpenWikiErrorData = Schema.Struct({
  message: Schema.String,
  code: Schema.optional(Schema.String),
})

export class OpenWikiError extends Schema.ErrorClass<OpenWikiError>("OpenWikiError")(
  {
    name: Schema.Literal("OpenWikiError"),
    data: OpenWikiErrorData,
  },
  { httpApiStatus: 400 },
) {}

/** Consent / ownership conflicts (adapter statusCode 409). */
export class OpenWikiConflictError extends Schema.ErrorClass<OpenWikiConflictError>("OpenWikiConflictError")(
  {
    name: Schema.Literal("OpenWikiConflictError"),
    data: OpenWikiErrorData,
  },
  { httpApiStatus: 409 },
) {}

/** Login / auth gaps for the selected model (adapter statusCode 401). */
export class OpenWikiUnauthorizedError extends Schema.ErrorClass<OpenWikiUnauthorizedError>("OpenWikiUnauthorizedError")(
  {
    name: Schema.Literal("OpenWikiUnauthorizedError"),
    data: OpenWikiErrorData,
  },
  { httpApiStatus: 401 },
) {}

/** Missing package / worker / node (adapter statusCode 500). */
export class OpenWikiServerError extends Schema.ErrorClass<OpenWikiServerError>("OpenWikiServerError")(
  {
    name: Schema.Literal("OpenWikiServerError"),
    data: OpenWikiErrorData,
  },
  { httpApiStatus: 500 },
) {}

export type OpenWikiHttpError =
  | OpenWikiError
  | OpenWikiConflictError
  | OpenWikiUnauthorizedError
  | OpenWikiServerError

export const OpenWikiHttpErrors = [
  OpenWikiError,
  OpenWikiConflictError,
  OpenWikiUnauthorizedError,
  OpenWikiServerError,
] as const

const StatusQuery = Schema.Struct({
  location: LocationQuery.fields.location,
  model: Schema.optional(Schema.String),
  openWikiModelOverride: Schema.optional(Schema.String),
}).annotate({ identifier: "OpenWikiStatusQuery" })

export const OpenWikiGroup = HttpApiGroup.make("server.openwiki")
  .add(
    HttpApiEndpoint.get("openwiki.status", "/api/openwiki/status", {
      query: StatusQuery,
      success: Location.response(OpenWiki.Status),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.openwiki.status",
          summary: "OpenWiki status",
          description: "Ownership, job, and login readiness for the project wiki.",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("openwiki.format.get", "/api/openwiki/format", {
      query: LocationQuery,
      success: Location.response(OpenWiki.FormatBundle),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.format.get", summary: "Get wiki format bundle" })),
  )
  .add(
    HttpApiEndpoint.put("openwiki.format.put", "/api/openwiki/format", {
      query: LocationQuery,
      payload: OpenWiki.FormatWriteInput,
      success: Location.response(OpenWiki.FormatBundle),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.format.put", summary: "Write wiki format bundle" })),
  )
  .add(
    HttpApiEndpoint.get("openwiki.format.presets", "/api/openwiki/format/presets", {
      query: LocationQuery,
      success: Location.response(Schema.Array(OpenWiki.FormatPreset)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.format.presets", summary: "List format presets" })),
  )
  .add(
    HttpApiEndpoint.post("openwiki.consent", "/api/openwiki/consent", {
      query: LocationQuery,
      payload: OpenWiki.ConsentInput,
      success: Location.response(OpenWiki.Status),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.openwiki.consent", summary: "Consent to manage existing wiki" }),
      ),
  )
  .add(
    HttpApiEndpoint.post("openwiki.generate", "/api/openwiki/generate", {
      query: LocationQuery,
      payload: OpenWiki.StartJobInput,
      success: Location.response(OpenWiki.Job),
      error: [...OpenWikiHttpErrors, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.generate", summary: "Generate wiki (init)" })),
  )
  .add(
    HttpApiEndpoint.post("openwiki.update", "/api/openwiki/update", {
      query: LocationQuery,
      payload: OpenWiki.StartJobInput,
      success: Location.response(OpenWiki.Job),
      error: [...OpenWikiHttpErrors, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.update", summary: "Update wiki incrementally" })),
  )
  .add(
    HttpApiEndpoint.get("openwiki.job", "/api/openwiki/job", {
      query: LocationQuery,
      success: Location.response(Schema.NullOr(OpenWiki.Job)),
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.job", summary: "Get active or last wiki job" })),
  )
  .add(
    HttpApiEndpoint.post("openwiki.cancel", "/api/openwiki/cancel", {
      query: LocationQuery,
      success: Location.response(Schema.NullOr(OpenWiki.Job)),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.cancel", summary: "Cancel wiki job" })),
  )
  .add(
    HttpApiEndpoint.get("openwiki.referenceSources.list", "/api/openwiki/reference-sources", {
      query: LocationQuery,
      success: Location.response(OpenWiki.ReferenceSourcesList),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.openwiki.referenceSources.list", summary: "List wiki reference sources" }),
      ),
  )
  .add(
    HttpApiEndpoint.post("openwiki.referenceSources.add", "/api/openwiki/reference-sources", {
      query: LocationQuery,
      payload: OpenWiki.ReferenceSourcesAddInput,
      success: Location.response(OpenWiki.ReferenceSourcesList),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.openwiki.referenceSources.add", summary: "Import wiki reference sources" }),
      ),
  )
  .add(
    HttpApiEndpoint.post("openwiki.referenceSources.remove", "/api/openwiki/reference-sources/remove", {
      query: LocationQuery,
      payload: OpenWiki.ReferenceSourcesRemoveInput,
      success: Location.response(OpenWiki.ReferenceSourcesList),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({
          identifier: "v2.openwiki.referenceSources.remove",
          summary: "Remove a wiki reference source",
        }),
      ),
  )
  .add(
    HttpApiEndpoint.get("openwiki.format.draft", "/api/openwiki/format/draft", {
      query: LocationQuery,
      success: Location.response(OpenWiki.FormatDraftEnvelope),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.format.draft", summary: "Get format draft" })),
  )
  .add(
    HttpApiEndpoint.post("openwiki.format.parse", "/api/openwiki/format/parse", {
      query: LocationQuery,
      payload: OpenWiki.StartJobInput,
      success: Location.response(OpenWiki.Job),
      error: [...OpenWikiHttpErrors, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.openwiki.format.parse", summary: "Parse references into a format draft" }),
      ),
  )
  .add(
    HttpApiEndpoint.post("openwiki.format.merge", "/api/openwiki/format/merge", {
      query: LocationQuery,
      payload: OpenWiki.StartJobInput,
      success: Location.response(OpenWiki.FormatMergeResult),
      error: [...OpenWikiHttpErrors, InvalidRequestError],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(
        OpenApi.annotations({ identifier: "v2.openwiki.format.merge", summary: "Merge format draft into active prompts" }),
      ),
  )
  .add(
    HttpApiEndpoint.post("openwiki.format.reset", "/api/openwiki/format/reset", {
      query: LocationQuery,
      success: Location.response(OpenWiki.FormatBundle),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.format.reset", summary: "Reset format to default preset" })),
  )
  .add(
    HttpApiEndpoint.post("openwiki.export.docx", "/api/openwiki/export/docx", {
      query: LocationQuery,
      success: Location.response(OpenWiki.DocxExport),
      error: [...OpenWikiHttpErrors],
    })
      .annotateMerge(locationQueryOpenApi)
      .annotateMerge(OpenApi.annotations({ identifier: "v2.openwiki.export.docx", summary: "Export wiki pages as DOCX" })),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "openwiki",
      description: "Project OpenWiki generation, format tooling, and export.",
    }),
  )
