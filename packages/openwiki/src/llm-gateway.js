import { randomBytes } from 'node:crypto';
import http from 'node:http';
import { createReasoningContentStore, forwardChatCompletions } from './llm-chat.js';
import { resolveLlmUpstreamAsync } from './llm-upstream.js';

/** @type {Map<string, { close: () => Promise<void> }>} */
const gatewaysByDirectory = new Map();

const readJsonBody = (req) => new Promise((resolve, reject) => {
  const chunks = [];
  let size = 0;
  const limit = 32 * 1024 * 1024;
  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > limit) {
      reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    try {
      const raw = Buffer.concat(chunks).toString('utf8');
      resolve(raw ? JSON.parse(raw) : {});
    } catch {
      reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
    }
  });
  req.on('error', reject);
});

const unauthorized = (res) => {
  res.writeHead(401, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ error: { message: 'Unauthorized' } }));
};

/**
 * Start a loopback OpenAI-compatible gateway for one OpenWiki job.
 * Secrets stay in this process; the child only receives the job token + URL.
 *
 * @param {{
 *   directory: string,
 *   model: { providerID: string, modelID: string },
 * }} input
 */
export const startOpenWikiLlmGateway = async ({ directory, model }) => {
  const key = directory;
  await stopOpenWikiLlmGateway(key);

  const upstream = await resolveLlmUpstreamAsync({ directory, model });
  const token = randomBytes(24).toString('hex');
  // Job-scoped: LangChain strips reasoning_content; reinject for thinking+tools providers.
  const reasoningStore = createReasoningContentStore();

  const server = http.createServer(async (req, res) => {
    try {
      const remote = req.socket?.remoteAddress || '';
      if (remote !== '127.0.0.1' && remote !== '::1' && remote !== '::ffff:127.0.0.1') {
        res.writeHead(403, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'Forbidden' } }));
        return;
      }

      const auth = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const bearer = auth.startsWith('Bearer ') ? auth.slice('Bearer '.length).trim() : '';
      if (!bearer || bearer !== token) {
        unauthorized(res);
        return;
      }

      const url = new URL(req.url || '/', 'http://127.0.0.1');
      const path = url.pathname.replace(/\/+$/, '') || '/';

      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          object: 'list',
          data: [{ id: upstream.modelID, object: 'model', owned_by: upstream.providerID }],
        }));
        return;
      }

      if (req.method === 'POST' && (path === '/v1/chat/completions' || path === '/chat/completions')) {
        const body = await readJsonBody(req);
        // Refresh upstream credentials per request (token refresh / auth file changes).
        const liveUpstream = await resolveLlmUpstreamAsync({ directory, model });
        await forwardChatCompletions({
          upstream: liveUpstream,
          body: body && typeof body === 'object' ? body : {},
          res,
          reasoningStore,
        });
        return;
      }

      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Not found' } }));
    } catch (error) {
      if (!res.headersSent) {
        const status = Number(error?.statusCode) > 0 ? Number(error.statusCode) : 500;
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: typeof error?.code === 'string' ? error.code : undefined,
          },
        }));
      } else {
        res.end();
      }
    }
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error('OpenWiki LLM gateway failed to bind a loopback port');
  }

  const close = () => new Promise((resolve) => {
    server.close(() => resolve());
    // Ensure hung sockets do not keep the process alive.
    try {
      server.closeAllConnections?.();
    } catch {
      // ignore
    }
  });

  const handle = {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    token,
    mappedProvider: 'openai-compatible',
    upstreamKind: upstream.kind,
    close,
  };
  gatewaysByDirectory.set(key, handle);
  return handle;
};

/**
 * @param {string} directory
 */
export const stopOpenWikiLlmGateway = async (directory) => {
  const handle = gatewaysByDirectory.get(directory);
  if (!handle) return;
  gatewaysByDirectory.delete(directory);
  await handle.close().catch(() => {});
};
