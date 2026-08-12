import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWikiBind, removeWikiBind } from './bind.js';
import { recoverStaleBind } from './index.js';
import { createJob, getJob, setChild, updateJob } from './job-store.js';
import { getBindPath, isSymlinkOrJunction, pathExists } from './paths.js';

describe('recoverStaleBind', () => {
  /** @type {string[]} */
  const dirs = [];

  afterEach(async () => {
    for (const dir of dirs.splice(0)) {
      setChild(dir, null);
      updateJob(dir, { stage: 'cancelled' });
      await removeWikiBind(dir).catch(() => undefined);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('marks ghost running job failed when childPid is dead', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-reclaim-'));
    dirs.push(dir);
    createJob({
      directory: dir,
      command: 'init',
      model: { providerID: 'opencode', modelID: 'big-pickle' },
      stage: 'running',
    });
    updateJob(dir, { childPid: 999_999_991 });
    await recoverStaleBind(dir);
    const job = getJob(dir);
    expect(job?.stage).toBe('failed');
    expect(job?.error?.code).toBe('openwiki-job-stale');
  });

  test('removes leftover bind when no active job', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ow-reclaim-bind-'));
    dirs.push(dir);
    await createWikiBind(dir);
    expect(pathExists(getBindPath(dir))).toBe(true);
    expect(isSymlinkOrJunction(getBindPath(dir))).toBe(true);
    await recoverStaleBind(dir);
    expect(pathExists(getBindPath(dir))).toBe(false);
  });
});
