/**
 * OpenCode locks OpenWiki document language to Simplified Chinese.
 * Clients cannot override this via Settings or request body.
 */
export const OPENWIKI_DOCUMENT_LANGUAGE = 'zh-CN';

/**
 * Injected into every generate/update user message so the agent cannot drift
 * even if OpenWiki's --language flag is ignored or a prior wiki was English.
 */
export const OPENWIKI_DOCUMENT_LANGUAGE_PROMPT = [
  'Document language (mandatory, fixed by OpenCode â€?not user-configurable):',
  '- Write every wiki page body in Simplified Chinese (zh-CN).',
  '- Keep code identifiers, file paths, API/type names, CLI commands, and config keys in their original form.',
  '- Do not generate the wiki in English or any other language.',
  '- On update/regenerate, translate or rewrite existing non-Chinese pages into Simplified Chinese while preserving meaning and structure.',
].join('\n');
