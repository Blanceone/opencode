export * as OpenWiki from "./openwiki"

import { Schema } from "effect"
import { optional } from "./schema"

export const Ownership = Schema.Literals(["absent", "opencode-managed", "foreign", "conflict"]).annotate({
  identifier: "OpenWiki.Ownership",
})
export type Ownership = typeof Ownership.Type

export const ConsentAction = Schema.Literals(["adopt", "backup-rebuild"]).annotate({
  identifier: "OpenWiki.ConsentAction",
})
export type ConsentAction = typeof ConsentAction.Type

export const JobStage = Schema.Literals([
  "queued",
  "preparing",
  "mapping-model",
  "running",
  "writing",
  "completed",
  "failed",
  "cancelled",
]).annotate({ identifier: "OpenWiki.JobStage" })
export type JobStage = typeof JobStage.Type

export const JobCommand = Schema.Literals(["init", "update"]).annotate({
  identifier: "OpenWiki.JobCommand",
})
export type JobCommand = typeof JobCommand.Type

export const FormatPresetId = Schema.Literals([
  "openwiki-default",
  "architecture-module",
  "api-service",
  "custom",
]).annotate({ identifier: "OpenWiki.FormatPresetId" })
export type FormatPresetId = typeof FormatPresetId.Type

export class ModelRef extends Schema.Class<ModelRef>("OpenWiki.ModelRef")({
  providerID: Schema.String,
  modelID: Schema.String,
}) {}

export class Marker extends Schema.Class<Marker>("OpenWiki.Marker")({
  version: Schema.Number,
  managedBy: Schema.Literal("opencode"),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  formatPresetId: optional(Schema.String),
  consentedAt: optional(Schema.String),
  consentAction: optional(ConsentAction),
  backupPath: optional(Schema.String),
}) {}

export class JobError extends Schema.Class<JobError>("OpenWiki.JobError")({
  code: Schema.String,
  message: Schema.String,
  providerID: optional(Schema.String),
}) {}

export class Job extends Schema.Class<Job>("OpenWiki.Job")({
  id: Schema.String,
  directory: Schema.String,
  mode: Schema.Literal("code"),
  command: JobCommand,
  stage: JobStage,
  model: ModelRef,
  mappedProvider: optional(Schema.String),
  startedAt: Schema.Number,
  updatedAt: Schema.Number,
  detail: optional(Schema.String),
  error: optional(JobError),
  cancelRequested: optional(Schema.Boolean),
  childPid: optional(Schema.Number),
}) {}

export class Status extends Schema.Class<Status>("OpenWiki.Status")({
  enabled: Schema.Boolean,
  projectDirectory: Schema.String,
  wikiRoot: Schema.String,
  wikiExists: Schema.Boolean,
  ownership: Ownership,
  consentRequired: Schema.Boolean,
  foreignPaths: Schema.Array(Schema.String),
  marker: Schema.NullOr(Marker),
  job: Schema.NullOr(Job),
  model: Schema.NullOr(ModelRef),
  hasLogin: Schema.Boolean,
}) {}

export class FormatBundle extends Schema.Class<FormatBundle>("OpenWiki.FormatBundle")({
  presetId: FormatPresetId,
  instructions: Schema.String,
  format: Schema.String,
  instructionsPath: Schema.String,
  formatPath: Schema.String,
  wikiRoot: Schema.String,
}) {}

export class FormatPreset extends Schema.Class<FormatPreset>("OpenWiki.FormatPreset")({
  id: FormatPresetId,
  instructions: Schema.String,
  format: Schema.String,
}) {}

export const FormatWriteInput = Schema.Struct({
  presetId: optional(FormatPresetId),
  instructions: optional(Schema.String),
  format: optional(Schema.String),
  applyPreset: optional(Schema.Boolean),
}).annotate({ identifier: "OpenWiki.FormatWriteInput" })
export interface FormatWriteInput extends Schema.Schema.Type<typeof FormatWriteInput> {}

export const ConsentInput = Schema.Struct({
  consent: Schema.Boolean,
  consentAction: ConsentAction,
}).annotate({ identifier: "OpenWiki.ConsentInput" })
export interface ConsentInput extends Schema.Schema.Type<typeof ConsentInput> {}

export const StartJobInput = Schema.Struct({
  // Omitted → follow OpenCode's current model selection.
  model: optional(Schema.Union([ModelRef, Schema.String])),
  consent: optional(Schema.Boolean),
  consentAction: optional(ConsentAction),
  openWikiModelOverride: optional(Schema.NullOr(Schema.String)),
}).annotate({ identifier: "OpenWiki.StartJobInput" })
export interface StartJobInput extends Schema.Schema.Type<typeof StartJobInput> {}

export const StatusQuery = Schema.Struct({
  model: optional(Schema.String),
  openWikiModelOverride: optional(Schema.String),
}).annotate({ identifier: "OpenWiki.StatusQuery" })
export interface StatusQuery extends Schema.Schema.Type<typeof StatusQuery> {}
