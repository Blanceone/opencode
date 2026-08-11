/**
 * OpenWiki child-process worker. Reads one JSON job from stdin, runs the agent,
 * emits NDJSON progress lines on stdout. Never logs secrets from env.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const readStdin = async () => {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
};

const emit = (event) => {
  process.stdout.write(`${JSON.stringify(event)}\n`);
};

const main = async () => {
  const raw = await readStdin();
  const job = JSON.parse(raw);
  const {
    command,
    cwd,
    language,
    modelId,
    userMessage,
    agentEntry,
  } = job;

  if (!agentEntry || !fs.existsSync(agentEntry)) {
    throw new Error(`agentEntry missing: ${agentEntry}`);
  }

  emit({ type: 'stage', stage: 'running' });

  const mod = await import(pathToFileURL(path.resolve(agentEntry)).href);
  if (typeof mod.runOpenWikiAgent !== 'function') {
    throw new Error('runOpenWikiAgent export missing from openwiki agent entry');
  }

  const result = await mod.runOpenWikiAgent(
    command,
    cwd,
    {
      outputMode: 'repository',
      modelId: modelId || null,
      language: language || null,
      userMessage: userMessage || null,
      onEvent: (event) => {
        if (!event || typeof event !== 'object') return;
        if (event.type === 'text' && typeof event.text === 'string') {
          // Keep progress small; UI only needs a short detail line.
          const text = event.text.length > 400 ? `${event.text.slice(0, 400)}…` : event.text;
          emit({ type: 'event', event: { type: 'text', text } });
        } else if (event.type === 'tool_start' || event.type === 'tool_end') {
          emit({
            type: 'event',
            event: {
              type: event.type,
              name: typeof event.name === 'string' ? event.name : undefined,
            },
          });
        }
      },
    },
  );

  emit({ type: 'stage', stage: 'writing' });
  emit({ type: 'completed', result: result ? { ok: true } : { ok: true } });
};

main().catch((error) => {
  emit({
    type: 'failed',
    error: {
      code: typeof error?.code === 'string' ? error.code : 'openwiki-run-failed',
      message: error instanceof Error ? error.message : String(error),
    },
  });
  process.exitCode = 1;
});
