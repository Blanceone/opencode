import fs from 'node:fs';
import {
  directoryHasMarkdown,
  getBindPath,
  getWikiRoot,
  isDirectory,
  isSymlinkOrJunction,
  pathExists,
  MARKER_FILE_NAME,
} from './paths.js';
import { readMarker } from './marker.js';

/**
 * @typedef {'absent' | 'opencode-managed' | 'foreign' | 'conflict'} WikiOwnership
 */

/**
 * @param {string} wikiRoot
 */
const hasNonMarkerEntries = (wikiRoot) => {
  try {
    const entries = fs.readdirSync(wikiRoot);
    return entries.some((name) => name !== MARKER_FILE_NAME && name !== '.' && name !== '..');
  } catch {
    return false;
  }
};

/**
 * @param {string} projectDirectory
 * @returns {{
 *   ownership: WikiOwnership,
 *   wikiRoot: string,
 *   wikiExists: boolean,
 *   marker: ReturnType<typeof readMarker>,
 *   consentRequired: boolean,
 *   foreignPaths: string[],
 * }}
 */
export const classifyWikiOwnership = (projectDirectory) => {
  const wikiRoot = getWikiRoot(projectDirectory);
  const bindPath = getBindPath(projectDirectory);
  const marker = readMarker(projectDirectory);
  const wikiDirExists = isDirectory(wikiRoot);
  const wikiHasMd = wikiDirExists && directoryHasMarkdown(wikiRoot);
  const bindExists = pathExists(bindPath);
  const bindIsLink = bindExists && isSymlinkOrJunction(bindPath);
  const bindIsRealDir = bindExists && isDirectory(bindPath) && !bindIsLink;
  const bindHasMd = bindIsRealDir && directoryHasMarkdown(bindPath);

  /** @type {string[]} */
  const foreignPaths = [];
  if (bindHasMd) foreignPaths.push(bindPath);

  if (bindIsRealDir && bindHasMd && wikiDirExists) {
    if (!marker) foreignPaths.unshift(wikiRoot);
    return {
      ownership: 'conflict',
      wikiRoot,
      // Content readiness — marker alone must not look "ready" for Update.
      wikiExists: wikiHasMd,
      marker,
      consentRequired: true,
      foreignPaths,
    };
  }

  if (marker && wikiDirExists) {
    return {
      ownership: 'opencode-managed',
      wikiRoot,
      wikiExists: wikiHasMd,
      marker,
      consentRequired: false,
      foreignPaths: [],
    };
  }

  if (wikiDirExists && (wikiHasMd || hasNonMarkerEntries(wikiRoot)) && !marker) {
    foreignPaths.unshift(wikiRoot);
    return {
      ownership: 'foreign',
      wikiRoot,
      wikiExists: wikiHasMd,
      marker: null,
      consentRequired: true,
      foreignPaths,
    };
  }

  if (bindHasMd) {
    return {
      ownership: 'foreign',
      wikiRoot,
      wikiExists: false,
      marker: null,
      consentRequired: true,
      foreignPaths,
    };
  }

  return {
    ownership: 'absent',
    wikiRoot,
    wikiExists: false,
    marker: null,
    consentRequired: false,
    foreignPaths: [],
  };
};
