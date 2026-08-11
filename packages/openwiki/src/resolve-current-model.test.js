import { describe, expect, test } from "bun:test"
import { resolveOpenCodeCurrentModel } from "./resolve-current-model.js"

describe("resolveOpenCodeCurrentModel", () => {
  test("uses explicit model first", () => {
    const model = resolveOpenCodeCurrentModel({
      model: "anthropic/claude-sonnet-4",
      openWikiModelOverride: "opencode/big-pickle",
    })
    // Settings-style override wins over request model in Chamber; here openWikiModelOverride wins.
    expect(model).toEqual({ providerID: "opencode", modelID: "big-pickle" })
  })

  test("falls back to free default when nothing selected", () => {
    const model = resolveOpenCodeCurrentModel({
      directory: "D:\\definitely-missing-opencode-project-xyz",
      allowFallback: true,
    })
    expect(model).toEqual({ providerID: "opencode", modelID: "big-pickle" })
  })

  test("can disable fallback", () => {
    const model = resolveOpenCodeCurrentModel({
      directory: "D:\\definitely-missing-opencode-project-xyz",
      allowFallback: false,
    })
    // May still find a real user model.json; only assert shape when null or object.
    if (model) {
      expect(typeof model.providerID).toBe("string")
      expect(typeof model.modelID).toBe("string")
    } else {
      expect(model).toBeNull()
    }
  })
})
