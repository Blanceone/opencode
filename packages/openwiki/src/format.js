import fsPromises from 'node:fs/promises';
import {
  getFormatPath,
  getInstructionsPath,
  getWikiRoot,
  pathExists,
} from './paths.js';
import { readMarker, writeMarker } from './marker.js';
import {
  DEFAULT_FORMAT_PRESET_ID,
  getPresetBodies,
  isFormatPresetId,
} from './presets.js';
import { OPENWIKI_DOCUMENT_LANGUAGE_PROMPT } from './language.js';
import { classifyWikiOwnership } from './ownership.js';

/**
 * @param {string} projectDirectory
 */
export const readFormatBundle = async (projectDirectory) => {
  const marker = readMarker(projectDirectory);
  const presetId = isFormatPresetId(marker?.formatPresetId || '')
    ? marker.formatPresetId
    : DEFAULT_FORMAT_PRESET_ID;

  const instructionsPath = getInstructionsPath(projectDirectory);
  const formatPath = getFormatPath(projectDirectory);

  const [instructions, format] = await Promise.all([
    pathExists(instructionsPath)
      ? fsPromises.readFile(instructionsPath, 'utf8')
      : Promise.resolve(''),
    pathExists(formatPath)
      ? fsPromises.readFile(formatPath, 'utf8')
      : Promise.resolve(''),
  ]);

  return {
    presetId,
    instructions,
    format,
    instructionsPath,
    formatPath,
    wikiRoot: getWikiRoot(projectDirectory),
  };
};

/**
 * @param {string} projectDirectory
 * @param {{
 *   presetId?: string,
 *   instructions?: string,
 *   format?: string,
 *   applyPreset?: boolean,
 * }} input
 */
export const writeFormatBundle = async (projectDirectory, input = {}) => {
  const ownership = classifyWikiOwnership(projectDirectory);
  if (ownership.consentRequired) {
    throw Object.assign(new Error('Existing wiki content requires explicit consent before editing format files'), {
      statusCode: 409,
      code: 'wiki-consent-required',
      ownership: ownership.ownership,
      foreignPaths: ownership.foreignPaths,
    });
  }

  await fsPromises.mkdir(getWikiRoot(projectDirectory), { recursive: true });

  let presetId = isFormatPresetId(input.presetId || '')
    ? input.presetId
    : (readMarker(projectDirectory)?.formatPresetId || DEFAULT_FORMAT_PRESET_ID);

  let instructions = typeof input.instructions === 'string' ? input.instructions : null;
  let format = typeof input.format === 'string' ? input.format : null;

  if (input.applyPreset === true && isFormatPresetId(presetId)) {
    const bodies = getPresetBodies(presetId);
    instructions = bodies.instructions;
    format = bodies.format;
  }

  if (instructions === null || format === null) {
    const current = await readFormatBundle(projectDirectory);
    if (instructions === null) instructions = current.instructions;
    if (format === null) format = current.format;
  }

  await fsPromises.writeFile(getInstructionsPath(projectDirectory), instructions, 'utf8');
  await fsPromises.writeFile(getFormatPath(projectDirectory), format, 'utf8');
  await writeMarker(projectDirectory, { formatPresetId: presetId });

  return readFormatBundle(projectDirectory);
};

/**
 * Ensure control files exist for a first generate. Does not overwrite non-empty user files.
 * @param {string} projectDirectory
 * @param {string} [presetId]
 */
export const ensureFormatSeeded = async (projectDirectory, presetId = DEFAULT_FORMAT_PRESET_ID) => {
  const id = isFormatPresetId(presetId) ? presetId : DEFAULT_FORMAT_PRESET_ID;
  const bodies = getPresetBodies(id);
  await fsPromises.mkdir(getWikiRoot(projectDirectory), { recursive: true });

  const instructionsPath = getInstructionsPath(projectDirectory);
  const formatPath = getFormatPath(projectDirectory);

  if (!pathExists(instructionsPath)) {
    await fsPromises.writeFile(instructionsPath, bodies.instructions, 'utf8');
  }
  if (!pathExists(formatPath)) {
    await fsPromises.writeFile(formatPath, bodies.format, 'utf8');
  }
  await writeMarker(projectDirectory, { formatPresetId: id });
  return readFormatBundle(projectDirectory);
};

/**
 * @param {{ instructions: string, format: string }} bundle
 */
export const buildFormatUserMessage = (bundle) => {
  const parts = [OPENWIKI_DOCUMENT_LANGUAGE_PROMPT];
  if (bundle.instructions.trim()) {
    parts.push('Repository OpenWiki brief (INSTRUCTIONS.md):\n' + bundle.instructions.trim());
  }
  if (bundle.format.trim()) {
    parts.push(
      'OpenCode structure and format requirements (FORMAT.md). Follow these when creating or updating wiki pages:\n'
        + bundle.format.trim(),
    );
  }
  if (!bundle.instructions.trim() && !bundle.format.trim()) {
    parts.push('Generate or update the repository wiki using OpenWiki defaults. Do not modify INSTRUCTIONS.md or FORMAT.md.');
  } else {
    parts.push('Do not rewrite INSTRUCTIONS.md or FORMAT.md unless the user explicitly asked to change the brief/format.');
  }
  return parts.join('\n\n');
};
