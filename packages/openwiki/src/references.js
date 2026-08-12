import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';

const CONFIG_CANDIDATES = ['opencode.json', 'opencode.jsonc'];

/**
 * Ensure project config exposes `references.wiki` → `./.wiki` for @wiki mentions.
 * Creates `opencode.json` when missing. Never overwrites a non-local wiki entry.
 *
 * @param {string} directory
 * @returns {Promise<{ wrote: boolean, path: string | null, reason?: string }>}
 */
export const ensureWikiReference = async (directory) => {
  const root = path.resolve(directory);
  let configPath = null;
  for (const name of CONFIG_CANDIDATES) {
    const candidate = path.join(root, name);
    if (fs.existsSync(candidate)) {
      configPath = candidate;
      break;
    }
  }

  if (!configPath) {
    configPath = path.join(root, 'opencode.json');
    const next = {
      $schema: 'https://opencode.ai/config.json',
      references: {
        wiki: {
          path: './.wiki',
          description: 'Project OpenWiki',
        },
      },
    };
    await fsPromises.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    return { wrote: true, path: configPath };
  }

  const raw = await fsPromises.readFile(configPath, 'utf8');
  let doc;
  try {
    doc = JSON.parse(stripJsonc(raw));
  } catch (error) {
    return {
      wrote: false,
      path: configPath,
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    return { wrote: false, path: configPath, reason: 'config-not-object' };
  }

  const references =
    doc.references && typeof doc.references === 'object' && !Array.isArray(doc.references)
      ? { ...doc.references }
      : {};

  const existing = references.wiki;
  if (existing !== undefined && !isCompatibleWikiReference(existing)) {
    return { wrote: false, path: configPath, reason: 'wiki-reference-conflict' };
  }

  if (isSameWikiReference(existing)) {
    return { wrote: false, path: configPath, reason: 'already-present' };
  }

  references.wiki = {
    path: './.wiki',
    description:
      typeof existing === 'object' && existing && typeof existing.description === 'string'
        ? existing.description
        : 'Project OpenWiki',
  };

  // Never rewrite .jsonc as pretty JSON — that strips comments. Prefer a sibling opencode.json.
  if (configPath.endsWith('.jsonc')) {
    const jsonSibling = path.join(root, 'opencode.json');
    if (!fs.existsSync(jsonSibling)) {
      const nextJson = {
        $schema: 'https://opencode.ai/config.json',
        references: {
          wiki: references.wiki,
        },
      };
      await fsPromises.writeFile(jsonSibling, `${JSON.stringify(nextJson, null, 2)}\n`, 'utf8');
      return { wrote: true, path: jsonSibling, reason: 'jsonc-sibling' };
    }
    return { wrote: false, path: configPath, reason: 'jsonc-skip' };
  }

  const next = { ...doc, references };
  await fsPromises.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return { wrote: true, path: configPath };
};

/**
 * @param {unknown} entry
 */
const isCompatibleWikiReference = (entry) => {
  if (typeof entry === 'string') {
    return entry === './.wiki' || entry === '.wiki' || entry.replace(/\\/g, '/') === './.wiki';
  }
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
  if (!('path' in entry)) return false;
  const value = /** @type {{ path?: unknown }} */ (entry).path;
  if (typeof value !== 'string') return false;
  const normalized = value.replace(/\\/g, '/');
  return normalized === './.wiki' || normalized === '.wiki';
};

/**
 * @param {unknown} entry
 */
const isSameWikiReference = (entry) => {
  if (!isCompatibleWikiReference(entry)) return false;
  if (typeof entry === 'string') return true;
  const description = /** @type {{ description?: unknown }} */ (entry).description;
  return typeof description === 'string' && description.length > 0;
};

/**
 * Minimal JSONC strip: remove line and block comments outside strings.
 * @param {string} text
 */
const stripJsonc = (text) => {
  let out = '';
  let i = 0;
  let inString = false;
  let quote = '';
  let escaped = false;
  while (i < text.length) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === quote) inString = false;
      i += 1;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < text.length && text[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 2;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
};
