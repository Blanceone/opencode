import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addReferenceSources,
  extractReferenceSourceText,
  listReferenceSources,
  removeReferenceSource,
  REFERENCE_SOURCE_MAX_FILES,
} from './reference-sources.js';
import { markdownToDocxBuffer, markdownToDocxParagraphs } from './md-docx.js';
import { parseDraftMarkers } from './format-parse.js';
import AdmZip from 'adm-zip';

describe('OpenWiki reference sources', () => {
  test('extracts markdown and warns on bad docx', () => {
    expect(extractReferenceSourceText(Buffer.from('# Hello\nworld', 'utf8'), '.md').text).toContain('Hello');
    const bad = extractReferenceSourceText(Buffer.from('not-a-zip'), '.docx');
    expect(bad.text).toBe('');
    expect(bad.warning).toBeTruthy();
  });

  test('imports, lists, and removes reference files', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openwiki-ref-'));
    try {
      const first = await addReferenceSources(tempRoot, {
        files: [
          { name: 'a.md', contentBase64: Buffer.from('# A', 'utf8').toString('base64') },
          { name: 'b.md', contentBase64: Buffer.from('# B', 'utf8').toString('base64') },
        ],
      });
      expect(first.count).toBe(2);
      expect(first.maxFiles).toBe(REFERENCE_SOURCE_MAX_FILES);

      const listed = await listReferenceSources(tempRoot);
      expect(listed.files.map((file) => file.name).sort()).toEqual(['a.md', 'b.md']);

      const afterRemove = await removeReferenceSource(tempRoot, 'a.md');
      expect(afterRemove.count).toBe(1);
      expect(afterRemove.files[0]?.name).toBe('b.md');
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test('rejects unsupported types', async () => {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'openwiki-ref-'));
    try {
      await expect(
        addReferenceSources(tempRoot, {
          files: [{ name: 'x.png', contentBase64: Buffer.from('x').toString('base64') }],
        }),
      ).rejects.toMatchObject({ code: 'reference-type-unsupported' });
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  });
});

describe('OpenWiki markdown to docx', () => {
  test('renders headings and lists', () => {
    const xml = markdownToDocxParagraphs('# Title\n\n- item one\n');
    expect(xml).toContain('Title');
    expect(xml).toContain('• item one');
  });

  test('builds a valid docx zip', () => {
    const buffer = markdownToDocxBuffer('# Hello\n\nBody text\n');
    const zip = new AdmZip(buffer);
    const entry = zip.getEntry('word/document.xml');
    expect(entry).toBeTruthy();
    const xml = entry.getData().toString('utf8');
    expect(xml).toContain('Hello');
    expect(xml).toContain('Body text');
  });
});

describe('OpenWiki format parse helpers', () => {
  test('parses OPENCODE marker blocks', () => {
    const text = [
      'noise',
      '<<<OPENCODE_INSTRUCTIONS>>>',
      'Brief line',
      '<<<OPENCODE_FORMAT>>>',
      '# Format',
      '- Mermaid',
      '<<<OPENCODE_END>>>',
      'tail',
    ].join('\n');
    expect(parseDraftMarkers(text)).toEqual({
      instructions: 'Brief line',
      format: '# Format\n- Mermaid',
    });
  });

  test('accepts legacy OpenChamber markers', () => {
    const text = [
      '<<<OPENCHAMBER_INSTRUCTIONS>>>',
      'A',
      '<<<OPENCHAMBER_FORMAT>>>',
      'B',
      '<<<OPENCHAMBER_END>>>',
    ].join('\n');
    expect(parseDraftMarkers(text)).toEqual({ instructions: 'A', format: 'B' });
  });

  test('returns null when markers are incomplete', () => {
    expect(parseDraftMarkers('no markers')).toBeNull();
  });
});
