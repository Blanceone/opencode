import { spawn } from 'node:child_process';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createWikiBind, removeWikiBind } from './bind.js';
import { buildFormatUserMessage, ensureFormatSeeded, readFormatBundle } from './format.js';
import { OPENWIKI_DOCUMENT_LANGUAGE } from './language.js';
import {
  createJob,
  getChild,
  getJob,
  isJobActive,
  setChild,
  updateJob,
} from './job-store.js';
import { startOpenWikiLlmGateway, stopOpenWikiLlmGateway } from './llm-gateway.js';
import { buildOpenWikiGatewayChildEnv } from './model-bridge.js';
import { resolveOpenCodeCurrentModel } from './resolve-current-model.js';
import { classifyWikiOwnership } from './ownership.js';
import {
  ensureOpenWikiDependencyModules,
  resolveOpenWikiAgentEntry,
  resolveOpenWikiPackageRoot,
} from './resolve-package.js';
import { writeMarker } from './marker.js';
import { getWikiRoot } from './paths.js';
import { ensureWikiReference } from './references.js';
import { resolveOpenWikiWorkerLaunch } from './worker-runtime.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WORKER_PATH = path.join(__dirname, 'worker.mjs');

/** Strip provider secrets from the inherited parent env before spawning OpenWiki. */
const CHILD_ENV_SCRUB_KEYS = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY',
  'OPENAI_BASE_URL',
  'OPENAI_COMPATIBLE_API_KEY',
  'OPENAI_COMPATIBLE_BASE_URL',
  'OPENROUTER_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_API_KEY',
  'COPILOT_API_KEY',
  'OPENWIKI_PROVIDER',
  'OPENWIKI_MODEL_ID',
];

const buildChildProcessEnv = (bridgedEnv, packageModules) => {
  const env = { ...process.env };
  for (const key of CHILD_ENV_SCRUB_KEYS) {
    delete env[key];
  }
  Object.assign(env, bridgedEnv, {
    OPENWIKI_TELEMETRY_DISABLED: '1',
    DO_NOT_TRACK: '1',
  });
  if (fs.existsSync(packageModules)) {
    env.NODE_PATH = [packageModules, process.env.NODE_PATH].filter(Boolean).join(path.delimiter);
  }
  return env;
};

/**
 * @param {string} projectDirectory
 * @param {{
 *   consent?: boolean,
 *   consentAction?: 'adopt' | 'backup-rebuild',
 * }} [options]
 */
export const applyConsentIfNeeded = async (projectDirectory, options = {}) => {
  const classification = classifyWikiOwnership(projectDirectory);
  if (!classification.consentRequired) {
    return classification;
  }
  if (options.consent !== true || (options.consentAction !== 'adopt' && options.consentAction !== 'backup-rebuild')) {
    throw Object.assign(new Error('Existing wiki content requires explicit consent'), {
      statusCode: 409,
      code: 'wiki-consent-required',
      ownership: classification.ownership,
      foreignPaths: classification.foreignPaths,
    });
  }

  if (options.consentAction === 'backup-rebuild') {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    for (const foreignPath of classification.foreignPaths) {
      const base = path.basename(foreignPath);
      const backup = path.join(path.dirname(foreignPath), `${base}.bak-${stamp}`);
      await fsPromises.rename(foreignPath, backup);
      await writeMarker(projectDirectory, {
        consentedAt: new Date().toISOString(),
        consentAction: 'backup-rebuild',
        backupPath: backup,
        formatPresetId: 'openwiki-default',
      });
    }
    await fsPromises.mkdir(getWikiRoot(projectDirectory), { recursive: true });
    await writeMarker(projectDirectory, {
      consentedAt: new Date().toISOString(),
      consentAction: 'backup-rebuild',
    });
  } else {
    // adopt
    await fsPromises.mkdir(getWikiRoot(projectDirectory), { recursive: true });
    // If foreign content was only under openwiki/, move it into .wiki/
    for (const foreignPath of classification.foreignPaths) {
      if (path.basename(foreignPath) === 'openwiki') {
        const wikiRoot = getWikiRoot(projectDirectory);
        const entries = await fsPromises.readdir(foreignPath).catch(() => []);
        for (const name of entries) {
          const from = path.join(foreignPath, name);
          const to = path.join(wikiRoot, name);
          try {
            await fsPromises.rename(from, to);
          } catch {
            // skip collisions; adopt keeps whatever is already in .wiki
          }
        }
        await fsPromises.rm(foreignPath, { recursive: true, force: true }).catch(() => {});
      }
    }
    await writeMarker(projectDirectory, {
      consentedAt: new Date().toISOString(),
      consentAction: 'adopt',
    });
  }

  return classifyWikiOwnership(projectDirectory);
};

/**
 * @param {{
 *   directory: string,
 *   command: 'init' | 'update',
 *   model: unknown,
 *   consent?: boolean,
 *   consentAction?: 'adopt' | 'backup-rebuild',
 *   openWikiModelOverride?: string | null,
 * }} input
 */
export const startOpenWikiJob = async (input) => {
  const directory = path.resolve(input.directory);
  if (isJobActive(directory)) {
    throw Object.assign(new Error('An OpenWiki job is already running for this project'), {
      statusCode: 409,
      code: 'job-in-progress',
    });
  }

  await applyConsentIfNeeded(directory, {
    consent: input.consent,
    consentAction: input.consentAction,
  });

  // Follow OpenCode's current model (UI selection / model.json / config).
  const model = resolveOpenCodeCurrentModel({
    directory,
    model: input.model,
    openWikiModelOverride: input.openWikiModelOverride,
  });
  if (!model) {
    throw Object.assign(new Error('No OpenCode model selected'), {
      statusCode: 400,
      code: 'model-required',
    });
  }

  const classification = classifyWikiOwnership(directory);
  if (input.command === 'init' && classification.ownership === 'opencode-managed' && classification.wikiExists) {
    // Allow regenerate with explicit init; UI must confirm. No hard block here if consented/managed.
  }

  if (input.command === 'update' && classification.ownership === 'absent') {
    throw Object.assign(new Error('No wiki exists yet. Generate first.'), {
      statusCode: 400,
      code: 'wiki-root-invalid',
    });
  }

  await ensureFormatSeeded(directory);
  const formatBundle = await readFormatBundle(directory);
  const userMessage = buildFormatUserMessage(formatBundle);

  createJob({
    directory,
    command: input.command,
    model,
    stage: 'preparing',
  });

  // Fire and forget; HTTP returns the job immediately.
  void runJob({
    directory,
    command: input.command,
    model,
    // Document language is product-locked; ignore any client/settings override.
    language: OPENWIKI_DOCUMENT_LANGUAGE,
    userMessage,
  });

  return getJob(directory);
};

/**
 * @param {{
 *   directory: string,
 *   command: 'init' | 'update',
 *   model: { providerID: string, modelID: string },
 *   language: string | null,
 *   userMessage: string,
 * }} params
 */
const runJob = async ({ directory, command, model, language, userMessage }) => {
  let bindCreated = false;
  let gatewayStarted = false;
  try {
    updateJob(directory, { stage: 'mapping-model' });
    const gateway = await startOpenWikiLlmGateway({ directory, model });
    gatewayStarted = true;
    const bridged = buildOpenWikiGatewayChildEnv({
      gatewayBaseUrl: gateway.baseUrl,
      jobToken: gateway.token,
      model,
    });
    updateJob(directory, {
      mappedProvider: bridged.mappedProvider,
      stage: 'preparing',
    });

    await createWikiBind(directory);
    bindCreated = true;

    const packageRoot = resolveOpenWikiPackageRoot();
    const { nodeModules: packageModules } = ensureOpenWikiDependencyModules(packageRoot);
    const agentEntry = resolveOpenWikiAgentEntry(packageRoot);

    const launch = resolveOpenWikiWorkerLaunch(WORKER_PATH);
    const childEnv = {
      ...buildChildProcessEnv(bridged.env, packageModules),
      ...launch.envExtras,
    };

    const payload = {
      command,
      cwd: directory,
      language,
      modelId: model.modelID,
      userMessage,
      agentEntry,
    };

    updateJob(directory, { stage: 'running' });

    const child = spawn(launch.binary, launch.args, {
      cwd: directory,
      env: childEnv,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    setChild(directory, child);
    updateJob(directory, { childPid: child.pid });

    child.stdin.write(JSON.stringify(payload));
    child.stdin.end();

    let stdoutBuffer = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdoutBuffer += chunk;
      let newline = stdoutBuffer.indexOf('\n');
      while (newline >= 0) {
        const line = stdoutBuffer.slice(0, newline).trim();
        stdoutBuffer = stdoutBuffer.slice(newline + 1);
        newline = stdoutBuffer.indexOf('\n');
        if (!line) continue;
        try {
          const event = JSON.parse(line);
          handleWorkerEvent(directory, event);
        } catch {
          // ignore malformed lines
        }
      }
    });

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });

    const exitCode = await new Promise((resolve) => {
      child.on('close', (code) => resolve(code ?? 1));
    });
    setChild(directory, null);

    const job = getJob(directory);
    if (job?.cancelRequested) {
      updateJob(directory, { stage: 'cancelled' });
      return;
    }
    if (exitCode !== 0 && job?.stage !== 'completed' && job?.stage !== 'failed') {
      updateJob(directory, {
        stage: 'failed',
        error: {
          code: 'openwiki-run-failed',
          message: stderrTail.trim() || `OpenWiki worker exited with code ${exitCode}`,
        },
      });
    } else if (job?.stage === 'running' || job?.stage === 'writing') {
      updateJob(directory, { stage: 'completed' });
    }
    const finished = getJob(directory);
    if (finished?.stage === 'completed') {
      await ensureWikiReference(directory).catch(() => undefined);
      await writeMarker(directory, { updatedAt: new Date().toISOString() }).catch(() => undefined);
    }
  } catch (error) {
    updateJob(directory, {
      stage: 'failed',
      error: {
        code: typeof error?.code === 'string' ? error.code : 'openwiki-run-failed',
        message: error instanceof Error ? error.message : String(error),
        ...(typeof error?.providerID === 'string' ? { providerID: error.providerID } : {}),
      },
    });
  } finally {
    if (bindCreated) {
      await removeWikiBind(directory);
    }
    if (gatewayStarted) {
      await stopOpenWikiLlmGateway(directory);
    }
    setChild(directory, null);
  }
};

/**
 * @param {string} directory
 * @param {any} event
 */
const handleWorkerEvent = (directory, event) => {
  if (!event || typeof event !== 'object') return;
  if (event.type === 'stage' && typeof event.stage === 'string') {
    updateJob(directory, { stage: event.stage });
    return;
  }
  if (event.type === 'event' && event.event?.type === 'text' && typeof event.event.text === 'string') {
    updateJob(directory, { detail: event.event.text, stage: 'running' });
    return;
  }
  if (event.type === 'event' && event.event?.type === 'tool_start' && event.event.name) {
    updateJob(directory, { detail: `tool: ${event.event.name}`, stage: 'running' });
    return;
  }
  if (event.type === 'completed') {
    updateJob(directory, { stage: 'completed' });
    void ensureWikiReference(directory).catch(() => undefined);
    return;
  }
  if (event.type === 'failed') {
    updateJob(directory, {
      stage: 'failed',
      error: {
        code: event.error?.code || 'openwiki-run-failed',
        message: event.error?.message || 'OpenWiki run failed',
      },
    });
  }
};

/**
 * @param {string} directory
 */
export const cancelOpenWikiJob = async (directory) => {
  const resolved = path.resolve(directory);
  const job = getJob(resolved);
  if (!job || !isJobActive(resolved)) {
    return getJob(resolved);
  }
  updateJob(resolved, { cancelRequested: true, stage: 'cancelled' });
  const child = getChild(resolved);
  if (child && !child.killed) {
    child.kill();
  }
  await stopOpenWikiLlmGateway(resolved);
  await removeWikiBind(resolved);
  setChild(resolved, null);
  return getJob(resolved);
};
