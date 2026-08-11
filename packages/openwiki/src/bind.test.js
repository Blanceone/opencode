import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWikiBind, removeWikiBind } from './bind.js';
import { getBindPath, getWikiRoot, isSymlinkOrJunction, pathExists } from './paths.js';

describe('wiki bind', () => {
  test('creates and removes job-scoped bind without deleting .wiki', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-bind-'));
    const wiki = getWikiRoot(dir);
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(path.join(wiki, 'index.md'), '# keep\n');

    const created = await createWikiBind(dir);
    expect(pathExists(created.bindPath)).toBe(true);
    expect(isSymlinkOrJunction(created.bindPath)).toBe(true);

    await removeWikiBind(dir);
    expect(pathExists(getBindPath(dir))).toBe(false);
    expect(fs.existsSync(path.join(wiki, 'index.md'))).toBe(true);
  });
});
