import fsPromises from 'node:fs/promises';
import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  getReferenceSourcesRoot,
  getWikiRoot,
  pathExists,
} from './paths.js';
import { writeMarker } from './marker.js';
import { DEFAULT_FORMAT_PRESET_ID } from './presets.js';
import { classifyWikiOwnership } from './ownership.js';

export const REFERENCE_SOURCE_EXTENSIONS = new Set(['.md', '.doc', '.docx']);
export const REFERENCE_SOURCE_MAX_FILES = 10;
export const REFERENCE_SOURCE_CONFIRM_BYTES = 10 * 1024 * 1024;
export const REFERENCE_SOURCE_HARD_MAX_BYTES = 50 * 1024 * 1024;

/**
 * @param {string} fileName
 */
export const referenceSourceExtension = (fileName) => path.extname(fileName || '').toLowerCase();

/**
 * @param {string} fileName
 */
export const isAllowedReferenceSourceName = (fileName) => {
  const base = path.basename(fileName || '');
  if (!base || base === '.' || base === '..') return false;
  if (base.includes('/') || base.includes('\\') || base.includes('\0')) return false;
  return REFERENCE_SOURCE_EXTENSIONS.has(referenceSourceExtension(base));
};

/**
 * @param {Buffer} bytes
 */
const stripXmlTags = (bytes) => bytes
  .toString('utf8')
  .replace(/<w:tab\b[^/]*\/>/gi, '\t')
  .replace(/<\/w:p>/gi, '\n')
  .replace(/<[^>]+>/g, '')
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/\n{3,}/g, '\n\n')
  .trim();

/**
 * @param {Buffer} bytes
 * @param {string} ext
 * @returns {{ text: string, warning?: string }}
 */
export const extractReferenceSourceText = (bytes, ext) => {
  if (ext === '.md') {
    return { text: bytes.toString('utf8') };
  }
  if (ext === '.docx') {
    try {
      const zip = new AdmZip(bytes);
      const entry = zip.getEntry('word/document.xml');
      if (!entry) {
        return { text: '', warning: 'docx-missing-document-xml' };
      }
      return { text: stripXmlTags(entry.getData()) };
    } catch {
      return { text: '', warning: 'docx-parse-failed' };
    }
  }
  if (ext === '.doc') {
    // Legacy OLE .doc has no reliable parser here. Keep a best-effort text scrape
    // so parse can still use short ASCII/Unicode runs when present.
    const utf16 = bytes.toString('utf16le');
    const asciiRuns = utf16
      .replace(/[^\x09\x0A\x0D\x20-\x7E\u4E00-\u9FFF]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (asciiRuns.length >= 40) {
      return { text: asciiRuns, warning: 'doc-best-effort-extract' };
    }
    return {
      text: '',
      warning: 'doc-text-unavailable',
    };
  }
  return { text: '', warning: 'unsupported-extension' };
};

/**
 * @param {string} projectDirectory
 */
export const ensureReferenceSourcesRoot = async (projectDirectory) => {
  const ownership = classifyWikiOwnership(projectDirectory);
  if (ownership.consentRequired) {
    throw Object.assign(new Error('Existing wiki content requires explicit consent before importing reference documents'), {
      statusCode: 409,
      code: 'wiki-consent-required',
      ownership: ownership.ownership,
      foreignPaths: ownership.foreignPaths,
    });
  }
  await fsPromises.mkdir(getWikiRoot(projectDirectory), { recursive: true });
  await fsPromises.mkdir(getReferenceSourcesRoot(projectDirectory), { recursive: true });
  if (!ownership.marker) {
    await writeMarker(projectDirectory, { formatPresetId: DEFAULT_FORMAT_PRESET_ID });
  }
  return getReferenceSourcesRoot(projectDirectory);
};

/**
 * @param {string} projectDirectory
 */
export const listReferenceSources = async (projectDirectory) => {
  const root = getReferenceSourcesRoot(projectDirectory);
  if (!pathExists(root)) {
    return { root, files: [], count: 0, maxFiles: REFERENCE_SOURCE_MAX_FILES };
  }
  const entries = await fsPromises.readdir(root, { withFileTypes: true });
  /** @type {Array<{ id: string, name: string, size: number, extension: string, modifiedAt: number }>} */
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!isAllowedReferenceSourceName(entry.name)) continue;
    const full = path.join(root, entry.name);
    const stat = await fsPromises.stat(full);
    files.push({
      id: entry.name,
      name: entry.name,
      size: stat.size,
      extension: referenceSourceExtension(entry.name),
      modifiedAt: stat.mtimeMs,
    });
  }
  files.sort((a, b) => a.name.localeCompare(b.name));
  return {
    root,
    files,
    count: files.length,
    maxFiles: REFERENCE_SOURCE_MAX_FILES,
  };
};

/**
 * @param {string} name
 * @param {Set<string>} used
 */
const uniqueStoredName = (name, used) => {
  const ext = referenceSourceExtension(name);
  const stem = path.basename(name, ext).replace(/[^\w.\-()+@\u4e00-\u9fff ]+/g, '_').trim() || 'document';
  let candidate = `${stem}${ext}`;
  let index = 1;
  while (used.has(candidate.toLowerCase())) {
    candidate = `${stem}-${index}${ext}`;
    index += 1;
  }
  used.add(candidate.toLowerCase());
  return candidate;
};

/**
 * @param {string} projectDirectory
 * @param {{
 *   files: Array<{ name: string, contentBase64: string, confirmLarge?: boolean }>,
 *   confirmLarge?: boolean,
 * }} input
 */
export const addReferenceSources = async (projectDirectory, input) => {
  const incoming = Array.isArray(input?.files) ? input.files : [];
  if (incoming.length === 0) {
    throw Object.assign(new Error('At least one reference document is required'), {
      statusCode: 400,
      code: 'reference-empty',
    });
  }

  const current = await listReferenceSources(projectDirectory);
  if (current.count + incoming.length > REFERENCE_SOURCE_MAX_FILES) {
    throw Object.assign(new Error(`At most ${REFERENCE_SOURCE_MAX_FILES} reference documents are allowed`), {
      statusCode: 400,
      code: 'reference-limit',
      maxFiles: REFERENCE_SOURCE_MAX_FILES,
      currentCount: current.count,
      attempted: incoming.length,
    });
  }

  const used = new Set(current.files.map((file) => file.name.toLowerCase()));
  /** @type {Array<{ name: string, bytes: Buffer, confirmLarge: boolean }>} */
  const prepared = [];
  for (const file of incoming) {
    const name = typeof file?.name === 'string' ? path.basename(file.name.trim()) : '';
    if (!isAllowedReferenceSourceName(name)) {
      throw Object.assign(new Error(`Unsupported reference file type: ${name || '(missing)'}`), {
        statusCode: 400,
        code: 'reference-type-unsupported',
      });
    }
    const contentBase64 = typeof file?.contentBase64 === 'string' ? file.contentBase64 : '';
    let bytes;
    try {
      bytes = Buffer.from(contentBase64, 'base64');
    } catch {
      throw Object.assign(new Error(`Invalid file payload for ${name}`), {
        statusCode: 400,
        code: 'reference-payload-invalid',
      });
    }
    if (!bytes.length) {
      throw Object.assign(new Error(`Empty reference file: ${name}`), {
        statusCode: 400,
        code: 'reference-empty-file',
      });
    }
    if (bytes.length > REFERENCE_SOURCE_HARD_MAX_BYTES) {
      throw Object.assign(new Error(`Reference file exceeds 50MB: ${name}`), {
        statusCode: 413,
        code: 'reference-too-large',
      });
    }
    const confirmLarge = input.confirmLarge === true || file?.confirmLarge === true;
    if (bytes.length > REFERENCE_SOURCE_CONFIRM_BYTES && !confirmLarge) {
      throw Object.assign(new Error(`Reference file is larger than 10MB and needs confirmation: ${name}`), {
        statusCode: 413,
        code: 'reference-size-confirm-required',
        fileName: name,
        size: bytes.length,
      });
    }
    prepared.push({ name: uniqueStoredName(name, used), bytes, confirmLarge });
  }

  const root = await ensureReferenceSourcesRoot(projectDirectory);
  /** @type {string[]} */
  const saved = [];
  for (const file of prepared) {
    await fsPromises.writeFile(path.join(root, file.name), file.bytes);
    saved.push(file.name);
  }
  return listReferenceSources(projectDirectory).then((list) => ({
    ...list,
    saved,
  }));
};

/**
 * @param {string} projectDirectory
 * @param {string} fileId
 */
export const removeReferenceSource = async (projectDirectory, fileId) => {
  const name = path.basename(typeof fileId === 'string' ? fileId.trim() : '');
  if (!isAllowedReferenceSourceName(name)) {
    throw Object.assign(new Error('Invalid reference document id'), {
      statusCode: 400,
      code: 'reference-id-invalid',
    });
  }
  const full = path.join(getReferenceSourcesRoot(projectDirectory), name);
  if (!pathExists(full)) {
    throw Object.assign(new Error('Reference document not found'), {
      statusCode: 404,
      code: 'reference-not-found',
    });
  }
  await fsPromises.unlink(full);
  return listReferenceSources(projectDirectory);
};

/**
 * @param {string} projectDirectory
 */
export const readReferenceSourceTexts = async (projectDirectory) => {
  const list = await listReferenceSources(projectDirectory);
  /** @type {Array<{ id: string, name: string, extension: string, text: string, warning?: string }>} */
  const documents = [];
  for (const file of list.files) {
    const bytes = await fsPromises.readFile(path.join(list.root, file.name));
    const extracted = extractReferenceSourceText(bytes, file.extension);
    documents.push({
      id: file.id,
      name: file.name,
      extension: file.extension,
      text: extracted.text,
      warning: extracted.warning,
    });
  }
  return documents;
};
