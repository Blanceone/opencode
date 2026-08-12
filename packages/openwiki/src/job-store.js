import { randomUUID } from 'node:crypto';
import path from 'node:path';

/** @typedef {'queued' | 'preparing' | 'mapping-model' | 'running' | 'writing' | 'completed' | 'failed' | 'cancelled'} OpenWikiJobStage */

/** @param {string} directory */
const jobKey = (directory) => path.resolve(directory);

/**
 * @typedef {{
 *   id: string,
 *   directory: string,
 *   mode: 'code',
 *   command: 'init' | 'update',
 *   stage: OpenWikiJobStage,
 *   model: { providerID: string, modelID: string },
 *   mappedProvider?: string,
 *   startedAt: number,
 *   updatedAt: number,
 *   detail?: string,
 *   error?: { code: string, message: string },
 *   cancelRequested?: boolean,
 *   childPid?: number,
 * }} OpenWikiJob
 */

/** @type {Map<string, OpenWikiJob>} */
const jobsByDirectory = new Map();

/** @type {Map<string, import('node:child_process').ChildProcess>} */
const childrenByDirectory = new Map();

/**
 * @param {string} directory
 */
export const getJob = (directory) => jobsByDirectory.get(jobKey(directory)) || null;

/**
 * @param {string} directory
 */
export const getChild = (directory) => childrenByDirectory.get(jobKey(directory)) || null;

/**
 * @param {Omit<OpenWikiJob, 'id' | 'startedAt' | 'updatedAt' | 'stage'> & { stage?: OpenWikiJobStage }} input
 */
export const createJob = (input) => {
  const now = Date.now();
  const directory = jobKey(input.directory);
  /** @type {OpenWikiJob} */
  const job = {
    id: randomUUID(),
    directory,
    mode: 'code',
    command: input.command,
    stage: input.stage || 'queued',
    model: input.model,
    mappedProvider: input.mappedProvider,
    startedAt: now,
    updatedAt: now,
    detail: input.detail,
    error: input.error,
    cancelRequested: false,
  };
  jobsByDirectory.set(directory, job);
  return job;
};

/**
 * @param {string} directory
 * @param {Partial<OpenWikiJob>} patch
 */
const DETAIL_MAX = 240;

/** @param {string | undefined} detail */
const truncateDetail = (detail) => {
  if (typeof detail !== 'string') return detail;
  const compact = detail.replace(/\s+/g, ' ').trim();
  if (compact.length <= DETAIL_MAX) return compact;
  return `${compact.slice(0, DETAIL_MAX)}…`;
};

export const updateJob = (directory, patch) => {
  const key = jobKey(directory);
  const current = jobsByDirectory.get(key);
  if (!current) return null;
  const next = {
    ...current,
    ...patch,
    ...(Object.prototype.hasOwnProperty.call(patch, 'detail')
      ? { detail: truncateDetail(patch.detail) }
      : {}),
    updatedAt: Date.now(),
  };
  jobsByDirectory.set(key, next);
  return next;
};

/**
 * @param {string} directory
 * @param {import('node:child_process').ChildProcess | null} child
 */
export const setChild = (directory, child) => {
  const key = jobKey(directory);
  if (!child) {
    childrenByDirectory.delete(key);
    return;
  }
  childrenByDirectory.set(key, child);
};

/**
 * @param {string} directory
 */
export const isJobActive = (directory) => {
  const job = jobsByDirectory.get(jobKey(directory));
  if (!job) return false;
  return !['completed', 'failed', 'cancelled'].includes(job.stage);
};
