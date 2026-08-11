import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import {
  FORMAT_FILE_NAME,
  INSTRUCTIONS_FILE_NAME,
  MARKER_FILE_NAME,
  MARKER_VERSION,
  getMarkerPath,
  getWikiRoot,
  pathExists,
} from './paths.js';

/**
 * @typedef {{
 *   version: number,
 *   managedBy: 'opencode',
 *   createdAt: string,
 *   updatedAt: string,
 *   formatPresetId?: string,
 *   consentedAt?: string,
 *   consentAction?: 'adopt' | 'backup-rebuild',
 *   backupPath?: string,
 * }} OpenWikiMarker
 */

/**
 * @param {string} projectDirectory
 * @returns {OpenWikiMarker | null}
 */
export const readMarker = (projectDirectory) => {
  const markerPath = getMarkerPath(projectDirectory);
  if (!pathExists(markerPath)) return null;
  try {
    const raw = fs.readFileSync(markerPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || parsed.managedBy !== 'opencode') {
      return null;
    }
    if (Number(parsed.version) !== MARKER_VERSION) {
      return null;
    }
    return /** @type {OpenWikiMarker} */ (parsed);
  } catch {
    return null;
  }
};

/**
 * @param {string} projectDirectory
 * @param {Partial<OpenWikiMarker>} patch
 */
export const writeMarker = async (projectDirectory, patch = {}) => {
  const wikiRoot = getWikiRoot(projectDirectory);
  await fsPromises.mkdir(wikiRoot, { recursive: true });
  const existing = readMarker(projectDirectory);
  const now = new Date().toISOString();
  /** @type {OpenWikiMarker} */
  const next = {
    version: MARKER_VERSION,
    managedBy: 'opencode',
    createdAt: existing?.createdAt || now,
    updatedAt: now,
    formatPresetId: existing?.formatPresetId || 'openwiki-default',
    consentedAt: existing?.consentedAt,
    consentAction: existing?.consentAction,
    backupPath: existing?.backupPath,
    ...patch,
  };
  // Enforce invariants after patch merge.
  next.version = MARKER_VERSION;
  next.managedBy = 'opencode';
  next.updatedAt = now;
  if (!next.createdAt) next.createdAt = now;

  await fsPromises.writeFile(getMarkerPath(projectDirectory), `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
};

export const CONTROL_FILE_NAMES = new Set([
  MARKER_FILE_NAME,
  INSTRUCTIONS_FILE_NAME,
  FORMAT_FILE_NAME,
]);
