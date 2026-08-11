import { describe, expect, test } from 'bun:test';
import path from 'node:path';
import { resolveOpenWikiNodeBinary, resolveOpenWikiWorkerLaunch } from './worker-runtime.js';

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
});
