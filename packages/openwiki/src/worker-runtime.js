import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

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

  // Builder-toolchain probing is opt-in via OPENCODE_BUILDER_TOOLS; no
  // machine-specific default may leak into shipped builds.
  const toolsRoot =
    typeof env.OPENCODE_BUILDER_TOOLS === 'string' && env.OPENCODE_BUILDER_TOOLS
      ? path.resolve(env.OPENCODE_BUILDER_TOOLS)
      : null;
  const packageRoot =
    typeof env.OPENWIKI_PACKAGE_ROOT === 'string' && env.OPENWIKI_PACKAGE_ROOT
      ? path.resolve(env.OPENWIKI_PACKAGE_ROOT)
      : null;
  const resourcesPath =
    typeof env.OPENWIKI_RESOURCES_PATH === 'string' && env.OPENWIKI_RESOURCES_PATH
      ? path.resolve(env.OPENWIKI_RESOURCES_PATH)
      : typeof process.resourcesPath === 'string'
        ? process.resourcesPath
        : null;

  const candidates = [
    packageRoot && path.join(packageRoot, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    packageRoot && path.join(packageRoot, process.platform === 'win32' ? 'node.exe' : 'node'),
    resourcesPath && path.join(resourcesPath, 'node', process.platform === 'win32' ? 'node.exe' : 'node'),
    toolsRoot && path.join(toolsRoot, 'nodejs', 'node.exe'),
    toolsRoot && path.join(toolsRoot, 'node', 'node.exe'),
    toolsRoot && path.join(toolsRoot, 'nodejs', 'bin', 'node'),
    toolsRoot && path.join(toolsRoot, 'node', 'bin', 'node'),
    toolsRoot && path.join(toolsRoot, 'nodejs', 'bin', 'node.exe'),
  ].filter(Boolean);
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
 * Resolve the adapter worker entry. Packaged Electron bundles runner.js into
 * app.asar chunks, so `__dirname/worker.mjs` does not exist — use
 * `resources/openwiki/worker.mjs` (staged by prepare-openwiki) instead.
 *
 * @param {{
 *   env?: NodeJS.ProcessEnv,
 *   resourcesPath?: string,
 *   moduleDir?: string,
 * }} [options]
 */
export const resolveOpenWikiWorkerPath = (options = {}) => {
  const env = options.env || process.env;
  if (typeof env.OPENWIKI_WORKER_PATH === 'string' && env.OPENWIKI_WORKER_PATH) {
    const forced = path.resolve(env.OPENWIKI_WORKER_PATH);
    if (fs.existsSync(forced)) return forced;
  }

  const moduleDir = options.moduleDir || HERE;
  const nextToModule = path.join(moduleDir, 'worker.mjs');
  if (fs.existsSync(nextToModule)) return nextToModule;

  if (typeof env.OPENWIKI_PACKAGE_ROOT === 'string' && env.OPENWIKI_PACKAGE_ROOT) {
    const fromPackage = path.join(path.resolve(env.OPENWIKI_PACKAGE_ROOT), 'worker.mjs');
    if (fs.existsSync(fromPackage)) return fromPackage;
  }

  const resourcesPath =
    options.resourcesPath ||
    (typeof process.resourcesPath === 'string' ? process.resourcesPath : undefined);
  if (resourcesPath) {
    const packaged = path.join(resourcesPath, 'openwiki', 'worker.mjs');
    if (fs.existsSync(packaged)) return packaged;
  }

  // Dev / monorepo: packages/openwiki/src/worker.mjs when this file is bundled elsewhere
  let dir = moduleDir;
  for (let i = 0; i < 8; i += 1) {
    const candidate = path.join(dir, 'packages', 'openwiki', 'src', 'worker.mjs');
    if (fs.existsSync(candidate)) return candidate;
    const sibling = path.join(dir, 'src', 'worker.mjs');
    if (path.basename(dir) === 'openwiki' && fs.existsSync(sibling)) return sibling;
    dir = path.dirname(dir);
  }

  throw Object.assign(
    new Error(
      'OpenWiki worker.mjs is missing. Re-run desktop prepare-openwiki (stages resources/openwiki/worker.mjs) or set OPENWIKI_WORKER_PATH.',
    ),
    { statusCode: 500, code: 'openwiki-worker-missing' },
  );
};

/**
 * Resolve how to launch the OpenWiki worker under a real Node binary.
 * Do not fall back to ELECTRON_RUN_AS_NODE — better-sqlite3 ABI mismatches hang installs.
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
  const preferred = fromTools || runtime.execPath || process.execPath;
  const execPath = looksLikeBun(preferred) ? fromTools : preferred;

  if (!execPath || looksLikeBun(execPath)) {
    throw Object.assign(
      new Error(
        'OpenWiki worker requires Node.js (better-sqlite3). Set OPENWIKI_NODE_BINARY, install Node on PATH, or ship resources/openwiki/node.',
      ),
      { statusCode: 500, code: 'openwiki-node-required' },
    );
  }

  // Never launch Electron as Node — ABI for native modules is unreliable.
  if (isElectron && !fromTools && execPath === (runtime.execPath || process.execPath)) {
    throw Object.assign(
      new Error(
        'OpenWiki worker requires a system Node.js binary (Electron-as-Node is disabled). Set OPENWIKI_NODE_BINARY or install Node on PATH.',
      ),
      { statusCode: 500, code: 'openwiki-node-required' },
    );
  }

  return {
    binary: execPath,
    args: [workerPath],
    envExtras: {},
    isElectron,
  };
};
