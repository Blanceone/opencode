export { classifyWikiOwnership } from './ownership.js';
export { readFormatBundle, writeFormatBundle, ensureFormatSeeded, buildFormatUserMessage } from './format.js';
export { FORMAT_PRESET_IDS, DEFAULT_FORMAT_PRESET_ID, getPresetBodies, isFormatPresetId } from './presets.js';
export { OPENWIKI_DOCUMENT_LANGUAGE, OPENWIKI_DOCUMENT_LANGUAGE_PROMPT } from './language.js';
export {
  parseModelRef,
  buildOpenWikiModelEnv,
  assertOpenWikiModelGatewayReady,
  buildOpenWikiGatewayChildEnv,
  canUseOpenWikiGatewayModel,
} from './model-bridge.js';
export { resolveOpenCodeCurrentModel } from './resolve-current-model.js';
export { getJob, isJobActive } from './job-store.js';
export { startOpenWikiJob, cancelOpenWikiJob, applyConsentIfNeeded } from './runner.js';
export { getWikiRoot, getBindPath } from './paths.js';
export { removeWikiBind } from './bind.js';
export { resolveOpenWikiPackageRoot } from './resolve-package.js';
export { readMarker } from './marker.js';
export { ensureWikiReference } from './references.js';
export { startOpenWikiLlmGateway, stopOpenWikiLlmGateway } from './llm-gateway.js';

import { classifyWikiOwnership } from './ownership.js';
import { getChild, getJob, isJobActive, setChild, updateJob } from './job-store.js';
import { readMarker } from './marker.js';
import { removeWikiBind } from './bind.js';
import { getBindPath, isSymlinkOrJunction, pathExists } from './paths.js';
import { canUseOpenWikiGatewayModel } from './model-bridge.js';
import { resolveOpenCodeCurrentModel } from './resolve-current-model.js';
import { stopOpenWikiLlmGateway } from './llm-gateway.js';

const STALE_PREPARE_MS = 2 * 60 * 1000;

/** @param {number | undefined} pid */
const isPidAlive = (pid) => {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Best-effort: clear leftover binds and ghost in-memory jobs after crash/restart.
 * @param {string} directory
 */
export const recoverStaleBind = async (directory) => {
  const job = getJob(directory);
  const child = getChild(directory);
  const childAlive = !!(child && !child.killed && child.exitCode == null);

  if (job && isJobActive(directory)) {
    const pidAlive = childAlive || isPidAlive(job.childPid);
    const preparingTooLong =
      !job.childPid && !childAlive && Date.now() - (job.updatedAt || job.startedAt) > STALE_PREPARE_MS;
    if ((!pidAlive && job.childPid) || preparingTooLong) {
      updateJob(directory, {
        stage: 'failed',
        error: {
          code: 'openwiki-job-stale',
          message: 'OpenWiki job was interrupted; worker is no longer running',
        },
      });
      setChild(directory, null);
      await stopOpenWikiLlmGateway(directory).catch(() => undefined);
      await removeWikiBind(directory);
      return;
    }
    return;
  }

  const bindPath = getBindPath(directory);
  if (pathExists(bindPath) && isSymlinkOrJunction(bindPath) && !childAlive) {
    await removeWikiBind(directory);
  }
};

/**
 * @param {{
 *   directory: string,
 *   model?: unknown,
 *   openWikiModelOverride?: string | null,
 *   openWikiEnabled?: boolean,
 * }} input
 */
export const getOpenWikiStatus = async (input) => {
  const directory = input.directory;
  await recoverStaleBind(directory);
  const ownership = classifyWikiOwnership(directory);
  const job = getJob(directory);
  const marker = readMarker(directory);
  // Follow OpenCode current selection when the caller omits model.
  const model = resolveOpenCodeCurrentModel({
    directory,
    model: input.model,
    openWikiModelOverride: input.openWikiModelOverride,
  });

  // "hasLogin" means the OpenWiki LLM gateway can attempt this model
  // (API-key providers, Zen with key, or free-tier opencode models).
  const hasLogin = model
    ? canUseOpenWikiGatewayModel({ directory, model })
    : false;

  // Drop undefined optional fields so Effect Schema encode/decode of Status succeeds.
  return JSON.parse(
    JSON.stringify({
      enabled: input.openWikiEnabled !== false,
      projectDirectory: directory,
      wikiRoot: ownership.wikiRoot,
      wikiExists: ownership.wikiExists,
      ownership: ownership.ownership,
      consentRequired: ownership.consentRequired,
      foreignPaths: ownership.foreignPaths,
      marker,
      job,
      model,
      hasLogin,
    }),
  );
};
