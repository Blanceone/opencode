import path from 'node:path';
import AdmZip from 'adm-zip';
import {
  FORMAT_DRAFT_FILE_NAME,
  FORMAT_FILE_NAME,
  INSTRUCTIONS_FILE_NAME,
  MARKER_FILE_NAME,
  REFERENCE_SOURCES_DIR_NAME,
  getWikiRoot,
  isDirectory,
} from './paths.js';
import fsPromises from 'node:fs/promises';

const CONTENT_TYPES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>
`;

const RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>
`;

const DOC_RELS = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>
`;

const CONTROL_FILE_NAMES = new Set([
  MARKER_FILE_NAME,
  INSTRUCTIONS_FILE_NAME,
  FORMAT_FILE_NAME,
  FORMAT_DRAFT_FILE_NAME,
  'log.md',
  '_plan.md',
  '.last-update.json',
  '.langsmith.json',
]);

/**
 * @param {string} value
 */
const escapeXml = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/**
 * Minimal Markdown → WordprocessingML paragraph list.
 * Supports headings, fenced code, lists, and plain paragraphs.
 * @param {string} markdown
 */
export const markdownToDocxParagraphs = (markdown) => {
  const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
  /** @type {string[]} */
  const paragraphs = [];
  let inCode = false;
  /** @type {string[]} */
  const codeLines = [];

  const flushCode = () => {
    if (!inCode) return;
    const text = codeLines.join('\n') || ' ';
    paragraphs.push(
      `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`,
    );
    codeLines.length = 0;
    inCode = false;
  };

  for (const line of lines) {
    if (line.trim().startsWith('```')) {
      if (inCode) flushCode();
      else inCode = true;
      continue;
    }
    if (inCode) {
      codeLines.push(line);
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 3);
      const size = level === 1 ? 32 : level === 2 ? 28 : 24;
      paragraphs.push(
        `<w:p><w:pPr><w:spacing w:before="200" w:after="120"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr><w:t xml:space="preserve">${escapeXml(heading[2])}</w:t></w:r></w:p>`,
      );
      continue;
    }

    const list = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line);
    if (list) {
      paragraphs.push(
        `<w:p><w:pPr><w:ind w:left="360"/></w:pPr><w:r><w:t xml:space="preserve">${escapeXml(`• ${list[3]}`)}</w:t></w:r></w:p>`,
      );
      continue;
    }

    if (!line.trim()) {
      paragraphs.push('<w:p><w:r><w:t></w:t></w:r></w:p>');
      continue;
    }

    paragraphs.push(
      `<w:p><w:r><w:t xml:space="preserve">${escapeXml(line)}</w:t></w:r></w:p>`,
    );
  }
  flushCode();
  if (paragraphs.length === 0) {
    paragraphs.push('<w:p><w:r><w:t></w:t></w:r></w:p>');
  }
  return paragraphs.join('');
};

/**
 * @param {string} markdown
 * @returns {Buffer}
 */
export const markdownToDocxBuffer = (markdown) => {
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    ${markdownToDocxParagraphs(markdown)}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>
`;
  const zip = new AdmZip();
  zip.addFile('[Content_Types].xml', Buffer.from(CONTENT_TYPES, 'utf8'));
  zip.addFile('_rels/.rels', Buffer.from(RELS, 'utf8'));
  zip.addFile('word/document.xml', Buffer.from(documentXml, 'utf8'));
  zip.addFile('word/_rels/document.xml.rels', Buffer.from(DOC_RELS, 'utf8'));
  return zip.toBuffer();
};

/**
 * @param {string} wikiRoot
 * @returns {Promise<Array<{ relativePath: string, absolutePath: string }>>}
 */
export const listExportableWikiMarkdown = async (wikiRoot) => {
  if (!isDirectory(wikiRoot)) return [];
  /** @type {Array<{ relativePath: string, absolutePath: string }>} */
  const files = [];
  /** @type {string[]} */
  const stack = [wikiRoot];
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;
    let entries;
    try {
      entries = await fsPromises.readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.name === '.' || entry.name === '..') continue;
      const absolutePath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        if (
          entry.name === 'node_modules'
          || entry.name === '.git'
          || entry.name === REFERENCE_SOURCES_DIR_NAME
        ) continue;
        stack.push(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (CONTROL_FILE_NAMES.has(entry.name)) continue;
      if (!entry.name.toLowerCase().endsWith('.md')) continue;
      const relativePath = path.relative(wikiRoot, absolutePath).split(path.sep).join('/');
      files.push({ relativePath, absolutePath });
    }
  }
  files.sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  return files;
};

/**
 * @param {string} projectDirectory
 * @returns {Promise<{
 *   wikiRoot: string,
 *   files: Array<{ relativePath: string, fileName: string, contentBase64: string, size: number }>,
 * }>}
 */
export const buildWikiDocxExport = async (projectDirectory) => {
  const wikiRoot = getWikiRoot(projectDirectory);
  const pages = await listExportableWikiMarkdown(wikiRoot);
  if (pages.length === 0) {
    throw Object.assign(new Error('No wiki pages are available to export'), {
      statusCode: 404,
      code: 'wiki-export-empty',
    });
  }
  /** @type {Array<{ relativePath: string, fileName: string, contentBase64: string, size: number }>} */
  const files = [];
  for (const page of pages) {
    const markdown = await fsPromises.readFile(page.absolutePath, 'utf8');
    const buffer = markdownToDocxBuffer(markdown);
    const relativePath = page.relativePath.replace(/\.md$/i, '.docx');
    files.push({
      relativePath,
      fileName: path.basename(relativePath),
      contentBase64: buffer.toString('base64'),
      size: buffer.length,
    });
  }
  return { wikiRoot, files };
};
