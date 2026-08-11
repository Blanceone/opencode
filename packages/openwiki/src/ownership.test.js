import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { classifyWikiOwnership } from "./ownership.js"
import { writeMarker } from "./marker.js"
import { getWikiRoot } from "./paths.js"

describe("openwiki ownership", () => {
  test("absent when no .wiki", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-"))
    const result = classifyWikiOwnership(dir)
    expect(result.ownership).toBe("absent")
    expect(result.consentRequired).toBe(false)
  })

  test("opencode-managed when marker present", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-"))
    await writeMarker(dir, { formatPresetId: "openwiki-default" })
    fs.writeFileSync(path.join(getWikiRoot(dir), "index.md"), "# hi\n")
    const result = classifyWikiOwnership(dir)
    expect(result.ownership).toBe("opencode-managed")
    expect(result.consentRequired).toBe(false)
  })

  test("foreign when .wiki exists without marker", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ow-"))
    const wiki = getWikiRoot(dir)
    fs.mkdirSync(wiki, { recursive: true })
    fs.writeFileSync(path.join(wiki, "index.md"), "# foreign\n")
    const result = classifyWikiOwnership(dir)
    expect(result.ownership).toBe("foreign")
    expect(result.consentRequired).toBe(true)
  })
})
