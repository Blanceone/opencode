/**
 * Built-in format presets. Bodies are English source text; UI localizes titles.
 * Document language is fixed to zh-CN by OpenCode (see language.js); presets
 * still restate that rule in FORMAT.md so seeded control files stay explicit.
 */

/** @typedef {'openwiki-default' | 'architecture-module' | 'api-service' | 'custom'} FormatPresetId */

const LANGUAGE_RULES = [
  '# Language (fixed)',
  '',
  '- Write all wiki prose in Simplified Chinese (zh-CN).',
  '- Keep code identifiers, paths, API names, and commands unchanged.',
  '- Do not switch the wiki language.',
].join('\n');

/** @type {FormatPresetId[]} */
export const FORMAT_PRESET_IDS = [
  'openwiki-default',
  'architecture-module',
  'api-service',
  'custom',
];

export const DEFAULT_FORMAT_PRESET_ID = /** @type {FormatPresetId} */ ('openwiki-default');

/**
 * @param {string} value
 * @returns {value is FormatPresetId}
 */
export const isFormatPresetId = (value) => FORMAT_PRESET_IDS.includes(/** @type {FormatPresetId} */ (value));

/**
 * @param {FormatPresetId} id
 */
export const getPresetBodies = (id) => {
  switch (id) {
    case 'architecture-module':
      return {
        instructions: [
          'Document this repository for engineers and coding agents.',
          'Prefer accurate, evidence-backed pages over speculative coverage.',
          'Prioritize architecture, module boundaries, and change-impact guidance.',
        ].join('\n'),
        format: [
          LANGUAGE_RULES,
          '',
          '# Required structure',
          '',
          '- `index.md` / quickstart: navigation and how to use this wiki',
          '- Architecture overview: system context, major components, runtime topology',
          '- One page (or section) per substantial module/service with:',
          '  - purpose and boundaries',
          '  - key APIs / extension points',
          '  - important invariants',
          '  - primary source files and focused tests',
          '- Cross-cutting concerns (auth, data, ops) when evidence warrants',
          '',
          '# Format rules',
          '',
          '- Use clear Markdown headings; keep page titles stable',
          '- Link related pages with relative `.md` links',
          '- Do not invent APIs or modules you have not inspected',
          '- Do not rewrite `INSTRUCTIONS.md` or `FORMAT.md`',
        ].join('\n'),
      };
    case 'api-service':
      return {
        instructions: [
          'Document this repository with an API/service focus.',
          'Emphasize public contracts, service boundaries, data models, and operations.',
        ].join('\n'),
        format: [
          LANGUAGE_RULES,
          '',
          '# Required structure',
          '',
          '- Quickstart / index',
          '- Service map and ownership boundaries',
          '- Public APIs and request/response contracts',
          '- Data models and persistence notes',
          '- AuthN/AuthZ boundaries when present',
          '- Operations: runbooks, config, failure modes',
          '',
          '# Format rules',
          '',
          '- Prefer concrete endpoint/type names from source',
          '- Link consumers and producers of each contract',
          '- Do not rewrite `INSTRUCTIONS.md` or `FORMAT.md`',
        ].join('\n'),
      };
    case 'custom':
      return {
        instructions: '',
        format: LANGUAGE_RULES,
      };
    case 'openwiki-default':
    default:
      return {
        instructions: '',
        format: [
          LANGUAGE_RULES,
          '',
          '# Format',
          '',
          'Follow OpenWiki’s built-in documentation outline and quality rules for this repository.',
          'Do not invent a custom section taxonomy unless source evidence clearly requires it.',
          'Do not rewrite `INSTRUCTIONS.md` or `FORMAT.md`.',
        ].join('\n'),
      };
  }
};
