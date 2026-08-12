import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  resolveOpenWikiNodeBinary,
  resolveOpenWikiWorkerLaunch,
  resolveOpenWikiWorkerPath,
} from './worker-runtime.js';

describe('worker-runtime', () => {
  test('resolves a real Node binary on this machine', () => {
    const node = resolveOpenWikiNodeBinary();
    expect(node).toBeTruthy();
    expect(path.basename(node).toLowerCase()).toMatch(/^node(\.exe)?$/);
  });

  test('refuses to launch worker under Bun when Node is unavailable', () => {
    expect(() =>
      resolveOpenWikiWorkerLaunch('/tmp/worker.mjs', {
        execPath: 'C:\\fake\\bun.exe',
        env: {
          PATH: '',
          Path: '',
          OPENWIKI_NODE_BINARY: '',
          OPENCODE_BUILDER_TOOLS: 'C:\\missing-builder-tools',
        },
        versions: {},
      }),
    ).toThrow(/requires Node\.js/);
  });

  test('uses OPENWIKI_NODE_BINARY when set', () => {
    const node = resolveOpenWikiNodeBinary();
    const launch = resolveOpenWikiWorkerLaunch('/tmp/worker.mjs', {
      execPath: 'C:\\fake\\bun.exe',
      env: {
        PATH: '',
        Path: '',
        OPENCODE_BUILDER_TOOLS: 'C:\\missing-builder-tools',
        OPENWIKI_NODE_BINARY: node,
      },
      versions: {},
    });
    expect(launch.binary).toBe(node);
  });

  test('refuses Electron-as-Node fallback', () => {
    expect(() =>
      resolveOpenWikiWorkerLaunch('/tmp/worker.mjs', {
        execPath: 'C:\\fake\\OpenCodeDev.exe',
        env: {
          PATH: '',
          Path: '',
          OPENWIKI_NODE_BINARY: '',
          OPENCODE_BUILDER_TOOLS: 'C:\\missing-builder-tools',
        },
        versions: { electron: '42.0.0' },
      }),
    ).toThrow(/Electron-as-Node is disabled|requires Node\.js/);
  });

  test('resolves worker next to the module in source checkouts', () => {
    const worker = resolveOpenWikiWorkerPath();
    expect(fs.existsSync(worker)).toBe(true);
    expect(path.basename(worker)).toBe('worker.mjs');
  });

  test('uses OPENWIKI_WORKER_PATH when set', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwiki-worker-'));
    const forced = path.join(dir, 'custom-worker.mjs');
    fs.writeFileSync(forced, '// test\n');
    try {
      const resolved = resolveOpenWikiWorkerPath({
        env: { OPENWIKI_WORKER_PATH: forced },
        moduleDir: path.join(dir, 'missing'),
        resourcesPath: path.join(dir, 'resources-missing'),
      });
      expect(resolved).toBe(path.resolve(forced));
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('falls back to resources/openwiki/worker.mjs for packaged layouts', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwiki-resources-'));
    const packaged = path.join(dir, 'openwiki', 'worker.mjs');
    fs.mkdirSync(path.dirname(packaged), { recursive: true });
    fs.writeFileSync(packaged, '// packaged\n');
    try {
      const resolved = resolveOpenWikiWorkerPath({
        env: { OPENWIKI_WORKER_PATH: '' },
        moduleDir: path.join(dir, 'asar', 'chunks'),
        resourcesPath: dir,
      });
      expect(resolved).toBe(packaged);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('uses OPENWIKI_PACKAGE_ROOT/worker.mjs when module dir is asar-bundled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwiki-package-root-'));
    const worker = path.join(dir, 'worker.mjs');
    fs.writeFileSync(worker, '// package root\n');
    try {
      const resolved = resolveOpenWikiWorkerPath({
        env: {
          OPENWIKI_WORKER_PATH: '',
          OPENWIKI_PACKAGE_ROOT: dir,
        },
        moduleDir: path.join(dir, 'asar', 'chunks'),
        resourcesPath: path.join(dir, 'resources-missing'),
      });
      expect(resolved).toBe(worker);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
