export * as OpenWiki from "./openwiki"

import { OpenWiki as OpenWikiSchema } from "@opencode-ai/schema/openwiki"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import {
  addReferenceSources,
  applyConsentIfNeeded,
  buildWikiDocxExport,
  cancelOpenWikiJob,
  FORMAT_PRESET_IDS,
  getJob,
  getOpenWikiStatus,
  getPresetBodies,
  listReferenceSources,
  mergeFormatDraft,
  readFormatBundle,
  readFormatDraft,
  removeReferenceSource,
  resetFormatBundle,
  startFormatParseJob,
  startOpenWikiJob,
  writeFormatBundle,
} from "@opencode-ai/openwiki"

export const Status = OpenWikiSchema.Status
export type Status = OpenWikiSchema.Status
export const Job = OpenWikiSchema.Job
export type Job = OpenWikiSchema.Job
export const FormatBundle = OpenWikiSchema.FormatBundle
export type FormatBundle = OpenWikiSchema.FormatBundle
export const FormatPreset = OpenWikiSchema.FormatPreset
export type FormatPreset = OpenWikiSchema.FormatPreset
export const ReferenceSourcesList = OpenWikiSchema.ReferenceSourcesList
export type ReferenceSourcesList = OpenWikiSchema.ReferenceSourcesList
export const FormatDraftEnvelope = OpenWikiSchema.FormatDraftEnvelope
export type FormatDraftEnvelope = OpenWikiSchema.FormatDraftEnvelope
export const FormatMergeResult = OpenWikiSchema.FormatMergeResult
export type FormatMergeResult = OpenWikiSchema.FormatMergeResult
export const DocxExport = OpenWikiSchema.DocxExport
export type DocxExport = OpenWikiSchema.DocxExport

export class AdapterError extends Schema.TaggedErrorClass<AdapterError>()("OpenWikiAdapterError", {
  message: Schema.String,
  code: Schema.optional(Schema.String),
  statusCode: Schema.optional(Schema.Number),
}) {}

export type Error = AdapterError

const wrap = <A>(promise: Promise<A>) =>
  Effect.tryPromise({
    try: () => promise,
    catch: (error) =>
      new AdapterError({
        message: error instanceof globalThis.Error ? error.message : String(error),
        code: typeof (error as { code?: unknown })?.code === "string" ? (error as { code: string }).code : undefined,
        statusCode:
          typeof (error as { statusCode?: unknown })?.statusCode === "number"
            ? (error as { statusCode: number }).statusCode
            : undefined,
      }),
  })

/** Adapter returns plain JSON; HttpApi encode requires Schema.Class instances. */
const asJson = (raw: unknown) => JSON.parse(JSON.stringify(raw)) as unknown
const decodeStatus = (raw: unknown) => Schema.decodeUnknownSync(Status)(asJson(raw))
const decodeJob = (raw: unknown) => Schema.decodeUnknownSync(Job)(asJson(raw))
const decodeFormat = (raw: unknown) => Schema.decodeUnknownSync(FormatBundle)(asJson(raw))
const decodeJobOrNull = (raw: unknown) => (raw == null ? null : decodeJob(raw))
const decodeRefs = (raw: unknown) => Schema.decodeUnknownSync(ReferenceSourcesList)(asJson(raw))
const decodeDraftEnvelope = (raw: unknown) => Schema.decodeUnknownSync(FormatDraftEnvelope)(asJson(raw))
const decodeMerge = (raw: unknown) => Schema.decodeUnknownSync(FormatMergeResult)(asJson(raw))
const decodeDocx = (raw: unknown) => Schema.decodeUnknownSync(DocxExport)(asJson(raw))

export interface Interface {
  readonly status: (input?: {
    model?: unknown
    openWikiModelOverride?: string | null
  }) => Effect.Effect<Status, Error>
  readonly formatGet: () => Effect.Effect<FormatBundle, Error>
  readonly formatPut: (input: OpenWikiSchema.FormatWriteInput) => Effect.Effect<FormatBundle, Error>
  readonly formatPresets: () => Effect.Effect<FormatPreset[], never>
  readonly consent: (input: OpenWikiSchema.ConsentInput) => Effect.Effect<Status, Error>
  readonly generate: (input: OpenWikiSchema.StartJobInput) => Effect.Effect<Job, Error>
  readonly update: (input: OpenWikiSchema.StartJobInput) => Effect.Effect<Job, Error>
  readonly job: () => Effect.Effect<Job | null, never>
  readonly cancel: () => Effect.Effect<Job | null, Error>
  readonly referenceSourcesList: () => Effect.Effect<ReferenceSourcesList, Error>
  readonly referenceSourcesAdd: (
    input: OpenWikiSchema.ReferenceSourcesAddInput,
  ) => Effect.Effect<ReferenceSourcesList, Error>
  readonly referenceSourcesRemove: (
    input: OpenWikiSchema.ReferenceSourcesRemoveInput,
  ) => Effect.Effect<ReferenceSourcesList, Error>
  readonly formatDraft: () => Effect.Effect<FormatDraftEnvelope, Error>
  readonly formatParse: (input: OpenWikiSchema.StartJobInput) => Effect.Effect<Job, Error>
  readonly formatMerge: (input: OpenWikiSchema.StartJobInput) => Effect.Effect<FormatMergeResult, Error>
  readonly formatReset: () => Effect.Effect<FormatBundle, Error>
  readonly exportDocx: () => Effect.Effect<DocxExport, Error>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/OpenWiki") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    // Use the opened workspace directory, not project.directory.
    // For non-git folders Project.resolve falls back to the drive root (e.g. D:\).
    const directory = () => location.directory

    return Service.of({
      status: (input) =>
        wrap(
          getOpenWikiStatus({
            directory: directory(),
            model: input?.model,
            openWikiModelOverride: input?.openWikiModelOverride,
          }).then(decodeStatus),
        ),
      formatGet: () => wrap(readFormatBundle(directory()).then(decodeFormat)),
      formatPut: (input) => wrap(writeFormatBundle(directory(), input).then(decodeFormat)),
      formatPresets: () =>
        Effect.succeed(
          FORMAT_PRESET_IDS.map((id) => {
            const bodies = getPresetBodies(id)
            return new OpenWikiSchema.FormatPreset({
              id,
              instructions: bodies.instructions,
              format: bodies.format,
            })
          }),
        ),
      consent: (input) =>
        wrap(
          applyConsentIfNeeded(directory(), {
            consent: input.consent,
            consentAction: input.consentAction,
          })
            .then(() => getOpenWikiStatus({ directory: directory() }))
            .then(decodeStatus),
        ),
      generate: (input) =>
        wrap(
          startOpenWikiJob({
            directory: directory(),
            command: "init",
            model: input.model,
            consent: input.consent,
            consentAction: input.consentAction,
            openWikiModelOverride: input.openWikiModelOverride,
          }).then(decodeJob),
        ),
      update: (input) =>
        wrap(
          startOpenWikiJob({
            directory: directory(),
            command: "update",
            model: input.model,
            consent: input.consent,
            consentAction: input.consentAction,
            openWikiModelOverride: input.openWikiModelOverride,
          }).then(decodeJob),
        ),
      job: () => Effect.sync(() => decodeJobOrNull(getJob(directory()))),
      cancel: () => wrap(cancelOpenWikiJob(directory()).then(decodeJobOrNull)),
      referenceSourcesList: () => wrap(listReferenceSources(directory()).then(decodeRefs)),
      referenceSourcesAdd: (input) =>
        wrap(
          addReferenceSources(directory(), {
            files: input.files.map((file) => ({
              name: file.name,
              contentBase64: file.contentBase64,
              confirmLarge: file.confirmLarge,
            })),
            confirmLarge: input.confirmLarge,
          }).then(decodeRefs),
        ),
      referenceSourcesRemove: (input) => wrap(removeReferenceSource(directory(), input.id).then(decodeRefs)),
      formatDraft: () =>
        wrap(
          readFormatDraft(directory()).then((draft) => decodeDraftEnvelope({ draft })),
        ),
      formatParse: (input) =>
        wrap(
          startFormatParseJob({
            directory: directory(),
            model: input.model,
            openWikiModelOverride: input.openWikiModelOverride,
          }).then(decodeJob),
        ),
      formatMerge: (input) =>
        wrap(
          mergeFormatDraft({
            directory: directory(),
            model: input.model,
            openWikiModelOverride: input.openWikiModelOverride,
          }).then(decodeMerge),
        ),
      formatReset: () => wrap(resetFormatBundle(directory()).then(decodeFormat)),
      exportDocx: () => wrap(buildWikiDocxExport(directory()).then(decodeDocx)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node],
})
