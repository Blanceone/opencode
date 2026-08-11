import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import { OpenWiki } from "./openwiki"

describe("OpenWiki.Status wire shape", () => {
  test("plain adapter status decodes then encodes for HttpApi", () => {
    const plain = {
      enabled: true,
      projectDirectory: "D:\\work\\demo",
      wikiRoot: "D:\\work\\demo\\.wiki",
      wikiExists: true,
      ownership: "opencode-managed" as const,
      consentRequired: false,
      foreignPaths: [] as string[],
      marker: {
        version: 1,
        managedBy: "opencode" as const,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        formatPresetId: "openwiki-default",
      },
      job: {
        id: "job-1",
        directory: "D:\\work\\demo",
        mode: "code" as const,
        command: "init" as const,
        stage: "failed" as const,
        model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
        startedAt: 1,
        updatedAt: 2,
        error: {
          code: "openwiki-run-failed",
          message: "Cannot find module 'worker.mjs'",
        },
        cancelRequested: false,
      },
      model: { providerID: "opencode", modelID: "deepseek-v4-flash-free" },
      hasLogin: true,
    }

    const decoded = Schema.decodeUnknownSync(OpenWiki.Status)(plain)
    expect(decoded).toBeInstanceOf(OpenWiki.Status)
    const encoded = Schema.encodeSync(OpenWiki.Status)(decoded)
    expect(encoded.job?.stage).toBe("failed")
    expect(encoded.job?.error?.code).toBe("openwiki-run-failed")
  })

  test("rejects encode of plain object without decode", () => {
    expect(() =>
      Schema.encodeUnknownSync(OpenWiki.Status)({
        enabled: true,
        projectDirectory: "x",
        wikiRoot: "y",
        wikiExists: false,
        ownership: "absent",
        consentRequired: false,
        foreignPaths: [],
        marker: null,
        job: null,
        model: null,
        hasLogin: false,
      }),
    ).toThrow(/Expected OpenWiki\.Status/)
  })
})
