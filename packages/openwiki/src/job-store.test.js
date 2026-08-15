import { describe, expect, test } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { acquireJobAdmission, createJob, updateJob } from './job-store.js';

const makeDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ow-admission-'));

const fail = (fn) => {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected acquireJobAdmission to throw');
};

describe('acquireJobAdmission', () => {
  test('rejects a concurrent admit before release', () => {
    const dir = makeDir();
    const release = acquireJobAdmission(dir);
    const error = fail(() => acquireJobAdmission(dir));
    expect(error.code).toBe('job-in-progress');
    expect(error.statusCode).toBe(409);
    release();
  });

  test('allows a new admit after release', () => {
    const dir = makeDir();
    const release = acquireJobAdmission(dir);
    release();
    const again = acquireJobAdmission(dir);
    expect(typeof again).toBe('function');
    again();
  });

  test('rejects admits while a job is active, allows after it completes', () => {
    const dir = makeDir();
    createJob({
      directory: dir,
      command: 'init',
      model: { providerID: 'opencode', modelID: 'test-model' },
      stage: 'running',
    });
    expect(fail(() => acquireJobAdmission(dir)).code).toBe('job-in-progress');
    updateJob(dir, { stage: 'completed' });
    const release = acquireJobAdmission(dir);
    expect(typeof release).toBe('function');
    release();
  });
});
