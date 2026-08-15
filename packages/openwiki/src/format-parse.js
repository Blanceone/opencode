import fsPromises from 'node:fs/promises';
import {
  getFormatDraftPath,
  getWikiRoot,
  pathExists,
} from './paths.js';
import { readFormatBundle, writeFormatBundle } from './format.js';
import { DEFAULT_FORMAT_PRESET_ID, getPresetBodies } from './presets.js';
import { OPENWIKI_DOCUMENT_LANGUAGE_PROMPT } from './language.js';
import { readReferenceSourceTexts } from './reference-sources.js';
import { assertOpenWikiModelGatewayReady } from './model-bridge.js';
import { resolveOpenCodeCurrentModel } from './resolve-current-model.js';
import { resolveLlmUpstreamAsync } from './llm-upstream.js';
import { completeChatOnce } from './llm-chat.js';
import { acquireJobAdmission, createJob, getJob, isJobActive, updateJob } from './job-store.js';
import { classifyWikiOwnership } from './ownership.js';

const DRAFT_MARKER_START = '<<<OPENCODE_INSTRUCTIONS>>>';
const DRAFT_MARKER_MID = '<<<OPENCODE_FORMAT>>>';
const DRAFT_MARKER_END = '<<<OPENCODE_END>>>';
// Accept Chamber markers so drafts from OpenChamber still merge.
const LEGACY_MARKER_START = '<<<OPENCHAMBER_INSTRUCTIONS>>>';
const LEGACY_MARKER_MID = '<<<OPENCHAMBER_FORMAT>>>';
const LEGACY_MARKER_END = '<<<OPENCHAMBER_END>>>';

const MERMAID_RULE_PROMPT = [
  'Diagram rule (mandatory default):',
  '- For business process flows and any diagram or chart, require Mermaid fenced code blocks unless the user later edits the brief/format to say otherwise.',
].join('\n');

/**
 * @param {string} text
 * @param {string} start
 * @param {string} mid
 * @param {string} end
 * @returns {{ instructions: string, format: string } | null}
 */
const parseWithMarkers = (text, start, mid, end) => {
  const raw = String(text || '');
  const startIdx = raw.indexOf(start);
  const midIdx = raw.indexOf(mid);
  const endIdx = raw.indexOf(end);
  if (startIdx < 0 || midIdx < 0 || endIdx < 0 || !(startIdx < midIdx && midIdx < endIdx)) {
    return null;
  }
  const instructions = raw.slice(startIdx + start.length, midIdx).trim();
  const format = raw.slice(midIdx + mid.length, endIdx).trim();
  if (!instructions && !format) return null;
  return { instructions, format };
};

/**
 * @param {string} text
 * @returns {{ instructions: string, format: string } | null}
 */
export const parseDraftMarkers = (text) =>
  parseWithMarkers(text, DRAFT_MARKER_START, DRAFT_MARKER_MID, DRAFT_MARKER_END)
  || parseWithMarkers(text, LEGACY_MARKER_START, LEGACY_MARKER_MID, LEGACY_MARKER_END);

/**
 * @param {string} projectDirectory
 */
export const readFormatDraft = async (projectDirectory) => {
  const draftPath = getFormatDraftPath(projectDirectory);
  if (!pathExists(draftPath)) return null;
  try {
    const raw = await fsPromises.readFile(draftPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return null;
    return {
      instructions: typeof parsed.instructions === 'string' ? parsed.instructions : '',
      format: typeof parsed.format === 'string' ? parsed.format : '',
      createdAt: typeof parsed.createdAt === 'number' ? parsed.createdAt : null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : null,
      model: parsed.model && typeof parsed.model === 'object' ? parsed.model : null,
      sourceFiles: Array.isArray(parsed.sourceFiles)
        ? parsed.sourceFiles.filter((name) => typeof name === 'string')
        : [],
      warnings: Array.isArray(parsed.warnings)
        ? parsed.warnings.filter((item) => typeof item === 'string')
        : [],
    };
  } catch {
    return null;
  }
};

/**
 * @param {string} projectDirectory
 * @param {{
 *   instructions: string,
 *   format: string,
 *   model?: { providerID: string, modelID: string } | null,
 *   sourceFiles?: string[],
 *   warnings?: string[],
 * }} draft
 */
export const writeFormatDraft = async (projectDirectory, draft) => {
  await fsPromises.mkdir(getWikiRoot(projectDirectory), { recursive: true });
  const previous = await readFormatDraft(projectDirectory);
  const now = Date.now();
  const payload = {
    instructions: draft.instructions || '',
    format: draft.format || '',
    createdAt: previous?.createdAt || now,
    updatedAt: now,
    model: draft.model || previous?.model || null,
    sourceFiles: draft.sourceFiles || previous?.sourceFiles || [],
    warnings: draft.warnings || [],
  };
  await fsPromises.writeFile(getFormatDraftPath(projectDirectory), `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  return payload;
};

/**
 * @param {string} projectDirectory
 */
export const clearFormatDraft = async (projectDirectory) => {
  const draftPath = getFormatDraftPath(projectDirectory);
  if (pathExists(draftPath)) {
    await fsPromises.unlink(draftPath);
  }
};

/**
 * @param {string} projectDirectory
 */
export const resetFormatBundle = async (projectDirectory) => {
  const ownership = classifyWikiOwnership(projectDirectory);
  if (ownership.consentRequired) {
    throw Object.assign(new Error('Existing wiki content requires explicit consent before resetting format files'), {
      statusCode: 409,
      code: 'wiki-consent-required',
      ownership: ownership.ownership,
      foreignPaths: ownership.foreignPaths,
    });
  }
  const bodies = getPresetBodies(DEFAULT_FORMAT_PRESET_ID);
  const bundle = await writeFormatBundle(projectDirectory, {
    presetId: DEFAULT_FORMAT_PRESET_ID,
    instructions: bodies.instructions,
    format: bodies.format,
  });
  await clearFormatDraft(projectDirectory);
  return bundle;
};

const buildParsePrompt = (documents, current) => {
  const docsBlock = documents.map((doc, index) => {
    const body = doc.text?.trim()
      ? doc.text.trim().slice(0, 24_000)
      : `(no extractable text${doc.warning ? `; ${doc.warning}` : ''})`;
    return `### Source ${index + 1}: ${doc.name}\n${body}`;
  }).join('\n\n');

  return [
    'You help OpenCode configure OpenWiki prompt files for a software repository wiki.',
    OPENWIKI_DOCUMENT_LANGUAGE_PROMPT,
    MERMAID_RULE_PROMPT,
    'Read the user reference documents and produce two Markdown files:',
    '1) INSTRUCTIONS.md — brief/scope/priorities for wiki generation',
    '2) FORMAT.md — required structure, section rules, and writing conventions',
    'Keep FORMAT.md explicit about Simplified Chinese prose and Mermaid diagrams.',
    'Do not invent repository APIs that are not evidenced by the sources.',
    'Return ONLY the two files using these exact markers (no other wrapper text):',
    DRAFT_MARKER_START,
    '...INSTRUCTIONS.md body...',
    DRAFT_MARKER_MID,
    '...FORMAT.md body...',
    DRAFT_MARKER_END,
    '',
    'Current prompts (may be empty):',
    '--- INSTRUCTIONS ---',
    current.instructions || '(empty)',
    '--- FORMAT ---',
    current.format || '(empty)',
    '',
    'Reference documents:',
    docsBlock || '(none)',
  ].join('\n');
};

const buildMergePrompt = (current, draft) => [
  'You merge OpenWiki prompt drafts into the currently active prompts.',
  OPENWIKI_DOCUMENT_LANGUAGE_PROMPT,
  MERMAID_RULE_PROMPT,
  'Soft-merge the draft into the current prompts: keep useful current guidance, incorporate improvements from the draft, and remove contradictions by preferring clearer draft rules when they conflict.',
  'Do not hard-replace the current prompts with the draft wholesale.',
  'Return ONLY the merged files using these exact markers:',
  DRAFT_MARKER_START,
  '...merged INSTRUCTIONS.md...',
  DRAFT_MARKER_MID,
  '...merged FORMAT.md...',
  DRAFT_MARKER_END,
  '',
  'Current INSTRUCTIONS.md:',
  current.instructions || '(empty)',
  '',
  'Current FORMAT.md:',
  current.format || '(empty)',
  '',
  'Draft INSTRUCTIONS.md:',
  draft.instructions || '(empty)',
  '',
  'Draft FORMAT.md:',
  draft.format || '(empty)',
].join('\n');

/**
 * @param {{
 *   directory: string,
 *   model?: unknown,
 *   openWikiModelOverride?: string | null,
 * }} input
 */
export const startFormatParseJob = async (input) => {
  const directory = input.directory;
  // Hold the admission gate until createJob() lands so concurrent parses
  // cannot both pass the active-job check during the awaits below.
  const releaseAdmission = acquireJobAdmission(directory);
  try {
    const model = resolveOpenCodeCurrentModel({
      directory,
      model: input.model,
      openWikiModelOverride: input.openWikiModelOverride,
      allowFallback: false,
    });
    if (!model) {
      throw Object.assign(new Error('Model is required'), {
        statusCode: 400,
        code: 'model-required',
      });
    }

    const documents = await readReferenceSourceTexts(directory);
    if (documents.length === 0) {
      throw Object.assign(new Error('Import at least one reference document before parsing'), {
        statusCode: 400,
        code: 'reference-empty',
      });
    }

    await assertOpenWikiModelGatewayReady({ directory, model });
    const current = await readFormatBundle(directory);
    const job = createJob({
      directory,
      command: 'parse-format',
      model,
      stage: 'queued',
      detail: 'Parsing reference documents',
    });

    void (async () => {
      try {
        updateJob(directory, { stage: 'mapping-model', detail: 'Resolving model gateway' });
        const upstream = await resolveLlmUpstreamAsync({ directory, model });
        updateJob(directory, { stage: 'running', detail: 'Generating format draft', mappedProvider: 'openai-compatible' });
        if (getJob(directory)?.cancelRequested) {
          updateJob(directory, { stage: 'cancelled', detail: 'Cancelled' });
          return;
        }
        const { text } = await completeChatOnce({
          upstream,
          messages: [{ role: 'user', content: buildParsePrompt(documents, current) }],
        });
        if (getJob(directory)?.cancelRequested || getJob(directory)?.stage === 'cancelled') {
          updateJob(directory, { stage: 'cancelled', detail: 'Cancelled' });
          return;
        }
        const parsed = parseDraftMarkers(text);
        if (!parsed) {
          throw Object.assign(new Error('Model response did not include INSTRUCTIONS/FORMAT markers'), {
            statusCode: 502,
            code: 'format-draft-parse-failed',
          });
        }
        updateJob(directory, { stage: 'writing', detail: 'Saving format draft' });
        const warnings = documents
          .filter((doc) => doc.warning)
          .map((doc) => `${doc.name}: ${doc.warning}`);
        await writeFormatDraft(directory, {
          instructions: parsed.instructions,
          format: parsed.format,
          model,
          sourceFiles: documents.map((doc) => doc.name),
          warnings,
        });
        if (getJob(directory)?.cancelRequested || getJob(directory)?.stage === 'cancelled') {
          updateJob(directory, { stage: 'cancelled', detail: 'Cancelled' });
          return;
        }
        updateJob(directory, { stage: 'completed', detail: 'Format draft ready' });
      } catch (error) {
        updateJob(directory, {
          stage: 'failed',
          detail: error instanceof Error ? error.message : String(error),
          error: {
            code: typeof error?.code === 'string' ? error.code : 'format-parse-failed',
            message: error instanceof Error ? error.message : String(error),
            providerID: model.providerID,
          },
        });
      }
    })();

    return job;
  } finally {
    releaseAdmission();
  }
};

/**
 * Soft-merge the stored draft into the active format files via the LLM.
 * @param {{
 *   directory: string,
 *   model?: unknown,
 *   openWikiModelOverride?: string | null,
 * }} input
 */
export const mergeFormatDraft = async (input) => {
  const directory = input.directory;
  if (isJobActive(directory)) {
    throw Object.assign(new Error('An OpenWiki job is already running for this project'), {
      statusCode: 409,
      code: 'job-in-progress',
      job: getJob(directory),
    });
  }
  const draft = await readFormatDraft(directory);
  if (!draft) {
    throw Object.assign(new Error('No format draft is available to merge'), {
      statusCode: 404,
      code: 'format-draft-missing',
    });
  }
  const model = resolveOpenCodeCurrentModel({
    directory,
    model: input.model || draft.model,
    openWikiModelOverride: input.openWikiModelOverride,
    allowFallback: false,
  });
  if (!model) {
    throw Object.assign(new Error('Model is required'), {
      statusCode: 400,
      code: 'model-required',
    });
  }
  await assertOpenWikiModelGatewayReady({ directory, model });
  const current = await readFormatBundle(directory);
  const upstream = await resolveLlmUpstreamAsync({ directory, model });
  const { text } = await completeChatOnce({
    upstream,
    messages: [{ role: 'user', content: buildMergePrompt(current, draft) }],
  });
  const parsed = parseDraftMarkers(text);
  if (!parsed) {
    throw Object.assign(new Error('Model response did not include merged INSTRUCTIONS/FORMAT markers'), {
      statusCode: 502,
      code: 'format-merge-parse-failed',
    });
  }
  const bundle = await writeFormatBundle(directory, {
    instructions: parsed.instructions,
    format: parsed.format,
    presetId: 'custom',
  });
  return { bundle, draft };
};
