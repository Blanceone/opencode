import fs from 'node:fs';
import path from 'node:path';

export const WIKI_DIR_NAME = '.wiki';
export const OPENWIKI_BIND_NAME = 'openwiki';
export const MARKER_FILE_NAME = '.opencode-openwiki.json';
export const INSTRUCTIONS_FILE_NAME = 'INSTRUCTIONS.md';
export const FORMAT_FILE_NAME = 'FORMAT.md';
export const MARKER_VERSION = 1;

/**
 * @param {string} projectDirectory
 */
export const getWikiRoot = (projectDirectory) => path.join(projectDirectory, WIKI_DIR_NAME);

/**
 * @param {string} projectDirectory
 */
export const getBindPath = (projectDirectory) => path.join(projectDirectory, OPENWIKI_BIND_NAME);

/**
 * @param {string} projectDirectory
 */
export const getMarkerPath = (projectDirectory) => path.join(getWikiRoot(projectDirectory), MARKER_FILE_NAME);

/**
 * @param {string} projectDirectory
 */
export const getInstructionsPath = (projectDirectory) => path.join(getWikiRoot(projectDirectory), INSTRUCTIONS_FILE_NAME);

/**
 * @param {string} projectDirectory
 */
export const getFormatPath = (projectDirectory) => path.join(getWikiRoot(projectDirectory), FORMAT_FILE_NAME);

/**
 * @param {string} targetPath
 */
export const pathExists = (targetPath) => {
  try {
    fs.accessSync(targetPath);
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {string} targetPath
 */
export const isDirectory = (targetPath) => {
  try {
    return fs.statSync(targetPath).isDirectory();
  } catch {
    return false;
  }
};

/**
 * True when the path is a symlink or Windows directory junction.
 * @param {string} targetPath
 */
export const isSymlinkOrJunction = (targetPath) => {
  try {
    return fs.lstatSync(targetPath).isSymbolicLink();
  } catch {
    return false;
  }
};

/**
 * @param {string} dirPath
 * @returns {boolean}
 */
export const directoryHasMarkdown = (dirPath) => {
  if (!isDirectory(dirPath)) return false;
  /** @type {string[]} */
  const stack = [dirPath];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        stack.push(full);
      } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
        return true;
      }
    }
  }
  return false;
};
