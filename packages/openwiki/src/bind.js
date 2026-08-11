import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import {
  getBindPath,
  getWikiRoot,
  isSymlinkOrJunction,
  pathExists,
} from './paths.js';

/**
 * Create a job-scoped bind so stock OpenWiki writes to `.wiki/`.
 * On Windows uses a directory junction; elsewhere a symlink.
 *
 * @param {string} projectDirectory
 */
export const createWikiBind = async (projectDirectory) => {
  const wikiRoot = getWikiRoot(projectDirectory);
  const bindPath = getBindPath(projectDirectory);
  await fsPromises.mkdir(wikiRoot, { recursive: true });

  if (pathExists(bindPath)) {
    if (isSymlinkOrJunction(bindPath)) {
      await fsPromises.rm(bindPath, { force: true, recursive: true });
    } else {
      throw Object.assign(
        new Error(`Refusing to replace existing path "${bindPath}". Resolve the conflict first.`),
        { statusCode: 409, code: 'wiki-bind-conflict' },
      );
    }
  }

  if (process.platform === 'win32') {
    // mklink /J does not require admin; symlink may.
    execFileSync('cmd.exe', ['/c', 'mklink', '/J', bindPath, wikiRoot], {
      windowsHide: true,
      stdio: 'ignore',
    });
  } else {
    await fsPromises.symlink(wikiRoot, bindPath, 'dir');
  }

  return { bindPath, wikiRoot };
};

/**
 * @param {string} projectDirectory
 */
export const removeWikiBind = async (projectDirectory) => {
  const bindPath = getBindPath(projectDirectory);
  if (!pathExists(bindPath)) return;
  if (!isSymlinkOrJunction(bindPath)) {
    // Never delete a real directory that might contain user content.
    return;
  }
  try {
    // On Windows, rm of a junction removes the link, not the target.
    await fsPromises.rm(bindPath, { force: true, recursive: true });
  } catch {
    try {
      fs.unlinkSync(bindPath);
    } catch {
      // Best-effort cleanup; next status check can retry.
    }
  }
};
