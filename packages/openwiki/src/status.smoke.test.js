import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getOpenWikiStatus } from './index.js';
import { applyConsentIfNeeded, cancelOpenWikiJob } from './runner.js';
import { getWikiRoot } from './paths.js';

describe('openwiki status/consent smoke', () => {
  test('status reports free-model login readiness without auth.json', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-status-'));
    const status = await getOpenWikiStatus({
      directory: dir,
      model: 'opencode/big-pickle',
    });
    expect(status.enabled).toBe(true);
    expect(status.model?.providerID).toBe('opencode');
    expect(status.model?.modelID).toBe('big-pickle');
    expect(status.hasLogin).toBe(true);
    expect(status.ownership).toBe('absent');
  });

  test('consent adopt clears consentRequired for foreign wiki', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-consent-'));
    const wiki = getWikiRoot(dir);
    fs.mkdirSync(wiki, { recursive: true });
    fs.writeFileSync(path.join(wiki, 'index.md'), '# foreign\n');

    const before = await getOpenWikiStatus({ directory: dir, model: 'opencode/big-pickle' });
    expect(before.consentRequired).toBe(true);

    await applyConsentIfNeeded(dir, { consent: true, consentAction: 'adopt' });
    const after = await getOpenWikiStatus({ directory: dir, model: 'opencode/big-pickle' });
    expect(after.consentRequired).toBe(false);
    expect(after.ownership).toBe('opencode-managed');
  });

  test('cancel with no job is a no-op', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-cancel-'));
    const job = await cancelOpenWikiJob(dir);
    expect(job).toBeNull();
  });
});
