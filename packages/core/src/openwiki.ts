export * as OpenWiki from "./openwiki"

import { OpenWiki as OpenWikiSchema } from "@opencode-ai/schema/openwiki"
import { Context, Effect, Layer, Schema } from "effect"
import { makeLocationNode } from "./effect/app-node"
import { Location } from "./location"
import {
  applyConsentIfNeeded,
  cancelOpenWikiJob,
  FORMAT_PRESET_IDS,
  getJob,
  getOpenWikiStatus,
  getPresetBodies,
  readFormatBundle,
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
}

export class Service extends Context.Service<Service, Interface>()("@opencode/v2/OpenWiki") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const location = yield* Location.Service
    const directory = () => location.project.directory

    return Service.of({
      status: (input) =>
        wrap(
          getOpenWikiStatus({
            directory: directory(),
            model: input?.model,
            openWikiModelOverride: input?.openWikiModelOverride,
          }),
        ) as Effect.Effect<Status, Error>,
      formatGet: () => wrap(readFormatBundle(directory())) as Effect.Effect<FormatBundle, Error>,
      formatPut: (input) => wrap(writeFormatBundle(directory(), input)) as Effect.Effect<FormatBundle, Error>,
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
          }).then(() => getOpenWikiStatus({ directory: directory() })),
        ) as Effect.Effect<Status, Error>,
      generate: (input) =>
        wrap(
          startOpenWikiJob({
            directory: directory(),
            command: "init",
            // undefined → adapter follows OpenCode current model
            model: input.model,
            consent: input.consent,
            consentAction: input.consentAction,
            openWikiModelOverride: input.openWikiModelOverride,
          }),
        ) as Effect.Effect<Job, Error>,
      update: (input) =>
        wrap(
          startOpenWikiJob({
            directory: directory(),
            command: "update",
            model: input.model,
            consent: input.consent,
            consentAction: input.consentAction,
            openWikiModelOverride: input.openWikiModelOverride,
          }),
        ) as Effect.Effect<Job, Error>,
      job: () => Effect.sync(() => getJob(directory()) as Job | null),
      cancel: () => wrap(cancelOpenWikiJob(directory())) as Effect.Effect<Job | null, Error>,
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [Location.node],
})
