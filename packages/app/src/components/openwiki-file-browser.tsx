import { Component, createEffect, createMemo, createSignal, For, onMount, Show } from "solid-js"
import { Dynamic } from "solid-js/web"
import type { FileNode } from "@opencode-ai/sdk/v2"
import { FileIcon } from "@opencode-ai/ui/file-icon"
import { Icon } from "@opencode-ai/ui/icon"
import { ScrollView } from "@opencode-ai/ui/scroll-view"
import { useFileComponent } from "@opencode-ai/ui/context/file"
import { SessionFilePanelV2, SessionFilePanelV2Empty } from "@opencode-ai/session-ui/v2/session-file-panel-v2"
import { SessionReviewV2Sidebar } from "@opencode-ai/session-ui/v2/session-review-v2"
import "@opencode-ai/ui/v2/file-tree-v2.css"
import "@opencode-ai/session-ui/v2/session-review-v2.css"
import { createVirtualizer, defaultRangeExtractor } from "@tanstack/solid-virtual"
import { useFile } from "@/context/file"
import { useLanguage } from "@/context/language"
import { sampledChecksum } from "@opencode-ai/core/util/encode"
import {
  flattenFileTreeV2,
  flattenLiveFileTreeV2FromRoot,
  buildFileTreeV2Model,
  normalizeFileTreeV2Path,
  type FileTreeV2Node,
} from "@/components/file-tree-v2-model"
import { virtualScrollElement } from "@/components/virtual-scroll-element"

const WIKI_ROOT = ".wiki"
const SIDEBAR_WIDTH = 260

function WikiFileTreeRow(props: {
  node: FileTreeV2Node
  level: number
  active?: string
  onSelect: (node: FileNode) => void
}) {
  const file = useFile()
  const expanded = () => file.tree.state(props.node.originalPath)?.expanded ?? false
  const indent = 8 + props.level * 16

  return (
    <Show
      when={props.node.type === "directory"}
      fallback={
        <button
          type="button"
          data-slot="file-tree-v2-row"
          data-path={props.node.path}
          data-selected={props.node.path === props.active ? "" : undefined}
          class="relative flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left"
          style={`padding-inline-start: ${indent}px`}
          onClick={() =>
            props.onSelect({
              ...props.node,
              path: props.node.originalPath,
              absolute: props.node.originalPath,
            })
          }
        >
          <span class="filetree-iconpair size-4 shrink-0">
            <FileIcon node={props.node} class="size-4 filetree-icon filetree-icon--color" />
            <FileIcon node={props.node} class="size-4 filetree-icon filetree-icon--mono" mono />
          </span>
          <span class="min-w-0 flex-1 truncate text-12-medium">
            <bdi dir="auto">{props.node.name}</bdi>
          </span>
        </button>
      }
    >
      <button
        type="button"
        data-slot="file-tree-v2-row"
        data-path={props.node.path}
        class="relative flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left"
        style={`padding-inline-start: ${indent}px`}
        onClick={() => {
          if (expanded()) file.tree.collapse(props.node.originalPath)
          else file.tree.expand(props.node.originalPath)
        }}
      >
        <div
          data-slot="file-tree-v2-chevron"
          data-expanded={expanded() ? "" : undefined}
          class="flex size-4 shrink-0 items-center justify-center"
        >
          <Icon name="chevron-down" class="size-3.5 text-text-weaker" />
        </div>
        <span class="filetree-iconpair size-4 shrink-0">
          <FileIcon node={props.node} class="size-4 filetree-icon filetree-icon--color" />
          <FileIcon node={props.node} class="size-4 filetree-icon filetree-icon--mono" mono />
        </span>
        <span class="min-w-0 flex-1 truncate text-12-medium">
          <bdi dir="auto">{props.node.name}</bdi>
        </span>
      </button>
    </Show>
  )
}

function collectWikiPaths(file: ReturnType<typeof useFile>, root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length > 0) {
    const dir = stack.pop()!
    for (const node of file.tree.children(dir)) {
      out.push(node.path)
      if (node.type === "directory") stack.push(node.path)
    }
  }
  return out
}

function WikiFileTree(props: {
  active?: string
  filter: string
  onSelect: (node: FileNode) => void
}) {
  const file = useFile()
  const query = createMemo(() => props.filter.trim().toLowerCase())
  const expanded = (path: string) => file.tree.state(path)?.expanded ?? path === WIKI_ROOT
  const rows = createMemo(() => {
    const needle = query()
    if (!needle) {
      return flattenLiveFileTreeV2FromRoot(WIKI_ROOT, (path) => file.tree.children(path), (path) => expanded(path))
    }
    const matched = collectWikiPaths(file, WIKI_ROOT).filter((path) => {
      const normalized = normalizeFileTreeV2Path(path).toLowerCase()
      return normalized.includes(needle) || path.toLowerCase().includes(needle)
    })
    if (matched.length === 0) return []
    return flattenFileTreeV2(buildFileTreeV2Model(matched), () => true)
  })
  const [root, setRoot] = createSignal<HTMLDivElement>()
  const virtualizer = createVirtualizer<HTMLDivElement, HTMLDivElement>({
    get count() {
      return rows().length
    },
    getScrollElement: () => virtualScrollElement(root()),
    initialRect: { width: 0, height: 400 },
    estimateSize: () => 28,
    gap: 2,
    overscan: 8,
    get getItemKey() {
      const current = rows()
      return (index: number) => current[index]?.node.path ?? index
    },
    rangeExtractor: defaultRangeExtractor,
  })
  const rowByKey = createMemo(() => new Map(rows().map((row) => [row.node.path, row] as const)))
  const virtualItemByKey = createMemo(
    () => new Map(virtualizer.getVirtualItems().map((item) => [item.key, item] as const)),
  )

  return (
    <div
      ref={setRoot}
      data-component="file-tree-v2"
      class="group/file-tree-v2 min-h-0 flex-1"
      style={{ position: "relative", height: `${virtualizer.getTotalSize()}px` }}
    >
      <For each={virtualizer.getVirtualItems().map((item) => item.key)}>
        {(key) => (
          <Show when={virtualItemByKey().get(key)}>
            {(item) => (
              <div
                style={{
                  position: "absolute",
                  top: "0",
                  "inset-inline-start": "0",
                  width: "100%",
                  height: `${item().size}px`,
                  transform: `translateY(${item().start}px)`,
                }}
              >
                <Show when={rowByKey().get(key as string)}>
                  {(row) => (
                    <WikiFileTreeRow
                      node={row().node}
                      level={row().level}
                      active={props.active}
                      onSelect={props.onSelect}
                    />
                  )}
                </Show>
              </div>
            )}
          </Show>
        )}
      </For>
    </div>
  )
}

function WikiFilePreview(props: { path: string }) {
  const file = useFile()
  const fileComponent = useFileComponent()
  const language = useLanguage()
  const state = createMemo(() => file.get(props.path))
  const contents = createMemo(() => state()?.content?.content ?? "")
  const cacheKey = createMemo(() => sampledChecksum(contents()))

  createEffect(() => {
    void file.load(props.path)
  })

  return (
    <ScrollView class="h-full min-h-0">
      <Show
        when={state()?.loaded}
        fallback={
          <div class="flex h-full items-center justify-center px-4 py-8 text-12-regular text-text-weaker">
            {language.t("common.loading")}
          </div>
        }
      >
        <Show
          when={contents()}
          fallback={
            <div class="flex h-full items-center justify-center px-4 py-8 text-12-regular text-text-weaker">
              {language.t("page.openwiki.files.emptyFile")}
            </div>
          }
        >
          {(source) => (
            <div class="min-h-0 p-3">
              <Dynamic
                component={fileComponent}
                mode="text"
                file={{
                  name: props.path,
                  contents: source(),
                  cacheKey: cacheKey(),
                }}
                class="select-text"
              />
            </div>
          )}
        </Show>
      </Show>
    </ScrollView>
  )
}

export const OpenWikiFileBrowser: Component<{
  wikiExists: boolean
  refreshToken: number
}> = (props) => {
  const file = useFile()
  const language = useLanguage()
  const [selected, setSelected] = createSignal<string>()
  const [filter, setFilter] = createSignal("")
  const [loading, setLoading] = createSignal(false)
  const [listed, setListed] = createSignal(false)

  const refreshExpanded = async (path: string) => {
    await file.tree.refresh(path)
    for (const node of file.tree.children(path)) {
      if (node.type !== "directory") continue
      if (!file.tree.state(node.path)?.expanded) continue
      await refreshExpanded(node.path)
    }
  }

  const primeWikiTree = async () => {
    if (!props.wikiExists) {
      setListed(true)
      return
    }
    setLoading(true)
    try {
      file.tree.expand(WIKI_ROOT)
      await refreshExpanded(WIKI_ROOT)
      setListed(true)
    } catch {
      setListed(true)
    } finally {
      setLoading(false)
    }
  }

  onMount(() => {
    void primeWikiTree()
  })

  createEffect(() => {
    props.refreshToken
    props.wikiExists
    setListed(false)
    setSelected(undefined)
    void primeWikiTree()
  })

  const active = createMemo(() => {
    const path = selected()
    if (!path) return
    return normalizeFileTreeV2Path(path)
  })
  const hasEntries = createMemo(() => listed() && file.tree.children(WIKI_ROOT).length > 0)

  return (
    <div class="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
      <div class="shrink-0 border-b border-border-weak-base px-4 py-2.5">
        <div class="text-13-medium">{language.t("page.openwiki.files.title")}</div>
        <div class="mt-0.5 text-11-regular text-text-weaker">{language.t("page.openwiki.files.description")}</div>
      </div>
      <div class="min-h-0 min-w-0 flex-1 overflow-hidden">
        <Show
          when={props.wikiExists}
          fallback={
            <div class="flex h-full items-center justify-center px-6 py-10 text-center text-12-regular text-text-weaker">
              {language.t("page.openwiki.files.notGenerated")}
            </div>
          }
        >
          <Show
            when={!loading()}
            fallback={
              <div class="flex h-full items-center justify-center px-4 py-8 text-12-regular text-text-weaker">
                {language.t("common.loading")}
              </div>
            }
          >
            <Show
              when={hasEntries()}
              fallback={
                <div class="flex h-full items-center justify-center px-6 py-10 text-center text-12-regular text-text-weaker">
                  {language.t("page.openwiki.files.empty")}
                </div>
              }
            >
              <SessionFilePanelV2
                toolbar={false}
                sidebar={
                  <SessionReviewV2Sidebar
                    open
                    transition={false}
                    filter={filter()}
                    onFilterChange={setFilter}
                    width={SIDEBAR_WIDTH}
                  >
                    <WikiFileTree
                      active={active()}
                      filter={filter()}
                      onSelect={(node) => {
                        if (node.type !== "file") return
                        setSelected(node.path)
                      }}
                    />
                  </SessionReviewV2Sidebar>
                }
              >
                <Show
                  when={selected()}
                  fallback={
                    <SessionFilePanelV2Empty>
                      <div class="flex flex-col items-center gap-3 text-center text-text-weaker">
                        <Icon name="file-tree" size="large" />
                        <div class="text-14-medium text-text-strong">{language.t("page.openwiki.files.selectTitle")}</div>
                        <div class="text-13-regular">{language.t("page.openwiki.files.selectDescription")}</div>
                      </div>
                    </SessionFilePanelV2Empty>
                  }
                >
                  {(path) => <WikiFilePreview path={path()} />}
                </Show>
              </SessionFilePanelV2>
            </Show>
          </Show>
        </Show>
      </div>
    </div>
  )
}
