# OpenWiki (OpenCode)

Embeds the npm `openwiki` documentation agent for **code-mode** wikis under `<project>/.wiki/`.

## Local paths (do not upload)

- Toolchains: `D:\work\ai\builder_tools` (`OPENCODE_BUILDER_TOOLS`)
- Caches / tarball / staged bundle: repo `depends/` (gitignored)
  - `depends/npm-packs/openwiki-0.3.1.tgz`
  - `depends/openwiki-bundle/0.3.1/`
  - `depends/npm-cache/`, `depends/bun-cache/`

## Contracts

- Durable artifacts live in `.wiki/` only (plus a job-scoped `openwiki` junction).
- Child-process worker runs the agent; telemetry forced off.
- LLM via job-scoped loopback OpenAI-compatible gateway; secrets stay in the parent process.
- Marker: `.wiki/.opencode-openwiki.json` (`managedBy: "opencode"`).
- Document language fixed to `zh-CN` in v1.

## Agent consumption

- Tools: `wiki_read`, `wiki_search` (sandboxed to `.wiki/`)
- Mentions: successful generate/update auto-merges into project `opencode.json`:

```json
{
  "references": {
    "wiki": { "path": "./.wiki", "description": "Project OpenWiki" }
  }
}
```

If `references.wiki` already points elsewhere, OpenWiki leaves it unchanged.

## Consent

Foreign or conflict `.wiki` content requires an explicit consent action before generate/update/format writes:

- `adopt` — keep content, write OpenCode marker
- `backup-rebuild` — rename foreign paths with `.bak-<timestamp>`, then manage `.wiki/`

App `/wiki` and TUI Wiki sidebar expose both actions.

## Format

`INSTRUCTIONS.md` / `FORMAT.md` under `.wiki/` are editable via App format panel or:

- `GET/PUT /api/openwiki/format`
- `GET /api/openwiki/format/presets`

Presets: `openwiki-default`, `architecture-module`, `api-service`, `custom`.

## Model selection

OpenWiki **follows OpenCode's current model** by default:

1. Explicit request `model` / Settings override (if provided)
2. OpenCode `model.json` recent selection
3. Project/user `opencode.json` `model`
4. Free fallback `opencode/big-pickle` (anonymous Zen when no login)

App `/wiki` and TUI Wiki sidebar pass the UI-selected model; CLI omits `--model` to use the same resolution.

## Runtime

The CLI may be started with Bun, but the OpenWiki **worker child always runs under Node.js** (`better-sqlite3`). Set `OPENWIKI_NODE_BINARY` if `node` is not on PATH / under `OPENCODE_BUILDER_TOOLS`.

## CLI

```bash
bun run --cwd packages/openwiki openwiki resolve-package
bun run --cwd packages/openwiki openwiki status --dir <project>
bun run --cwd packages/openwiki openwiki generate --dir <project> --wait
# optional override:
# bun run --cwd packages/openwiki openwiki generate --dir <project> --model provider/model --wait
```

Prepare bundle from tarball:

```bash
bun run --cwd packages/openwiki prepare:openwiki
```

Desktop staging: `bun ./scripts/prepare-openwiki.ts` from `packages/desktop` (also hooked from prebuild).
