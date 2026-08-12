import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureWikiReference } from './references.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'openwiki-ref-'));

describe('ensureWikiReference', () => {
  test('creates opencode.json when absent', async () => {
    const dir = tmp();
    const result = await ensureWikiReference(dir);
    expect(result.wrote).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
    expect(doc.references.wiki.path).toBe('./.wiki');
  });

  test('merges into existing opencode.json', async () => {
    const dir = tmp();
    fs.writeFileSync(path.join(dir, 'opencode.json'), JSON.stringify({ model: 'opencode/big-pickle' }, null, 2));
    const result = await ensureWikiReference(dir);
    expect(result.wrote).toBe(true);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
    expect(doc.model).toBe('opencode/big-pickle');
    expect(doc.references.wiki.path).toBe('./.wiki');
  });

  test('does not overwrite conflicting wiki reference', async () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, 'opencode.json'),
      JSON.stringify({ references: { wiki: { path: './docs' } } }, null, 2),
    );
    const result = await ensureWikiReference(dir);
    expect(result.wrote).toBe(false);
    expect(result.reason).toBe('wiki-reference-conflict');
    const doc = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
    expect(doc.references.wiki.path).toBe('./docs');
  });

  test('does not rewrite opencode.jsonc comments; writes sibling opencode.json', async () => {
    const dir = tmp();
    const jsonc = '{\n  // keep me\n  "model": "opencode/big-pickle"\n}\n';
    fs.writeFileSync(path.join(dir, 'opencode.jsonc'), jsonc);
    const result = await ensureWikiReference(dir);
    expect(result.wrote).toBe(true);
    expect(result.reason).toBe('jsonc-sibling');
    expect(fs.readFileSync(path.join(dir, 'opencode.jsonc'), 'utf8')).toBe(jsonc);
    const sibling = JSON.parse(fs.readFileSync(path.join(dir, 'opencode.json'), 'utf8'));
    expect(sibling.references.wiki.path).toBe('./.wiki');
  });
});
