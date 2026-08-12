import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { applyEdits, modify, parse } from 'jsonc-parser';

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
  // OpenCode reads config as JSONC (comments / trailing commas allowed), so
  // parse tolerantly and apply a minimal edit instead of re-serializing the
  // whole document — rewriting would silently strip user comments.
  const errors = [];
  const doc = parse(raw, errors, { allowTrailingComma: true });
  if (errors.length > 0 && (doc === undefined || doc === null)) {
    return {
      wrote: false,
      path: configPath,
      reason: 'config-parse-error',
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

  const wikiReference = {
    path: './.wiki',
    description:
      typeof existing === 'object' && existing && typeof existing.description === 'string'
        ? existing.description
        : 'Project OpenWiki',
  };

  // In-place minimal edit keeps comments, ordering, and formatting intact for
  // both opencode.json and opencode.jsonc.
  const edits = modify(raw, ['references', 'wiki'], wikiReference, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  });
  await fsPromises.writeFile(configPath, applyEdits(raw, edits), 'utf8');
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
