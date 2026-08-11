import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const DEFAULT_BUILDER_TOOLS = process.env.OPENCODE_BUILDER_TOOLS || 'D:\\work\\ai\\builder_tools';

const looksLikeBun = (execPath) => {
  const base = path.basename(execPath || '').toLowerCase();
  return base === 'bun' || base === 'bun.exe';
};

/**
 * Prefer Node under builder_tools / PATH; never return Bun for the worker
 * (openwiki depends on native better-sqlite3).
 * @param {NodeJS.ProcessEnv} [env]
 */
export const resolveOpenWikiNodeBinary = (env = process.env) => {
  if (typeof env.OPENWIKI_NODE_BINARY === 'string' && env.OPENWIKI_NODE_BINARY) {
    const forced = path.resolve(env.OPENWIKI_NODE_BINARY);
    if (fs.existsSync(forced)) return forced;
  }

  const toolsRoot = env.OPENCODE_BUILDER_TOOLS || DEFAULT_BUILDER_TOOLS;
  const candidates = [
    path.join(toolsRoot, 'nodejs', 'node.exe'),
    path.join(toolsRoot, 'node', 'node.exe'),
    path.join(toolsRoot, 'nodejs', 'bin', 'node'),
    path.join(toolsRoot, 'node', 'bin', 'node'),
    path.join(toolsRoot, 'nodejs', 'bin', 'node.exe'),
  ];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }

  try {
    const which = process.platform === 'win32' ? 'where.exe' : 'which';
    const out = execFileSync(which, ['node'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
      env,
    })
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find((line) => line && fs.existsSync(line) && !looksLikeBun(line));
    if (out) return out;
  } catch {
    // fall through
  }

  return null;
};

/**
 * Resolve how to launch the OpenWiki worker under Node or Electron.
 * Packaged Electron must set ELECTRON_RUN_AS_NODE so process.execPath behaves
 * as Node instead of opening another desktop window.
 *
 * @param {string} workerPath Absolute path to worker.mjs
 * @param {{
 *   execPath?: string,
 *   versions?: { electron?: string },
 *   env?: NodeJS.ProcessEnv,
 * }} [runtime]
 */
export const resolveOpenWikiWorkerLaunch = (workerPath, runtime = {}) => {
  const env = runtime.env || process.env;
  const versions = runtime.versions || process.versions;
  const isElectron = Boolean(versions?.electron);
  const fromTools = resolveOpenWikiNodeBinary(env);
  const preferred = runtime.execPath || fromTools || process.execPath;
  const execPath = looksLikeBun(preferred) ? fromTools || preferred : preferred;

  if (looksLikeBun(execPath)) {
    throw Object.assign(
      new Error(
        'OpenWiki worker requires Node.js (better-sqlite3). Set OPENWIKI_NODE_BINARY or install Node on PATH / under OPENCODE_BUILDER_TOOLS.',
      ),
      { statusCode: 500, code: 'openwiki-node-required' },
    );
  }

  /** @type {Record<string, string>} */
  const envExtras = {};
  if (isElectron && !fromTools) {
    // Without this, spawning process.execPath may open another Electron window.
    envExtras.ELECTRON_RUN_AS_NODE = '1';
  }

  return {
    binary: execPath,
    args: [workerPath],
    envExtras,
    isElectron,
  };
};
