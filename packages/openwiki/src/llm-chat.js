import { randomUUID } from 'node:crypto';
import { createReasoningContentStore } from './llm-reasoning.js';

const REQUEST_TIMEOUT_MS = 10 * 60_000;

export { createReasoningContentStore };

/**
 * @param {unknown} content
 */
const textFromContent = (content) => {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && typeof part.text === 'string') return part.text;
      return '';
    })
    .join('');
};

/**
 * Convert OpenAI chat messages + tools into Anthropic Messages API body.
 * @param {{
 *   modelID: string,
 *   body: Record<string, unknown>,
 * }} input
 */
export const openaiBodyToAnthropic = ({ modelID, body }) => {
  const messagesIn = Array.isArray(body.messages) ? body.messages : [];
  /** @type {unknown[]} */
  const systemParts = [];
  /** @type {object[]} */
  const messages = [];

  for (const raw of messagesIn) {
    if (!raw || typeof raw !== 'object') continue;
    const role = raw.role;
    if (role === 'system' || role === 'developer') {
      const text = textFromContent(raw.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'assistant') {
      /** @type {object[]} */
      const content = [];
      const text = textFromContent(raw.content);
      if (text) content.push({ type: 'text', text });
      if (Array.isArray(raw.tool_calls)) {
        for (const call of raw.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const id = typeof call.id === 'string' ? call.id : randomUUID();
          const name = call.function?.name || call.name;
          if (typeof name !== 'string' || !name) continue;
          let input = {};
          const args = call.function?.arguments ?? call.arguments;
          if (typeof args === 'string' && args.trim()) {
            try {
              input = JSON.parse(args);
            } catch {
              input = { raw: args };
            }
          } else if (args && typeof args === 'object') {
            input = args;
          }
          content.push({ type: 'tool_use', id, name, input });
        }
      }
      if (content.length === 0) content.push({ type: 'text', text: '' });
      messages.push({ role: 'assistant', content });
      continue;
    }

    if (role === 'tool') {
      const toolCallId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '';
      const text = textFromContent(raw.content);
      // Anthropic expects user messages that wrap tool_result blocks.
      const last = messages[messages.length - 1];
      const toolResult = {
        type: 'tool_result',
        tool_use_id: toolCallId || 'tool',
        content: text,
      };
      if (last?.role === 'user' && Array.isArray(last.content)) {
        last.content.push(toolResult);
      } else {
        messages.push({ role: 'user', content: [toolResult] });
      }
      continue;
    }

    // user (and anything else)
    const text = textFromContent(raw.content);
    messages.push({ role: 'user', content: text || '' });
  }

  /** @type {object[]} */
  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
      const name = typeof fn.name === 'string' ? fn.name : '';
      if (!name) continue;
      tools.push({
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        input_schema: fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      });
    }
  }

  /** @type {Record<string, unknown>} */
  const out = {
    model: modelID,
    max_tokens: Number(body.max_tokens) > 0
      ? Number(body.max_tokens)
      : (Number(body.max_completion_tokens) > 0 ? Number(body.max_completion_tokens) : 8192),
    messages,
    stream: false,
  };
  if (systemParts.length) {
    out.system = systemParts.join('\n\n');
  }
  if (tools.length) {
    out.tools = tools;
  }
  if (body.tool_choice && body.tool_choice !== 'auto') {
    if (body.tool_choice === 'none') {
      out.tool_choice = { type: 'none' };
    } else if (body.tool_choice === 'required') {
      out.tool_choice = { type: 'any' };
    } else if (typeof body.tool_choice === 'object' && body.tool_choice?.function?.name) {
      out.tool_choice = { type: 'tool', name: body.tool_choice.function.name };
    }
  }
  return out;
};

/**
 * @param {object} anthropicPayload
 * @param {string} modelID
 */
export const anthropicResponseToOpenai = (anthropicPayload, modelID) => {
  const contentBlocks = Array.isArray(anthropicPayload?.content) ? anthropicPayload.content : [];
  const text = contentBlocks
    .filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text)
    .join('');
  const toolUses = contentBlocks.filter((part) => part?.type === 'tool_use');
  /** @type {object} */
  const message = {
    role: 'assistant',
    content: text || null,
  };
  if (toolUses.length) {
    message.tool_calls = toolUses.map((part) => ({
      id: typeof part.id === 'string' ? part.id : randomUUID(),
      type: 'function',
      function: {
        name: part.name,
        arguments: JSON.stringify(part.input ?? {}),
      },
    }));
  }
  let finishReason = 'stop';
  if (anthropicPayload?.stop_reason === 'tool_use') finishReason = 'tool_calls';
  else if (anthropicPayload?.stop_reason === 'max_tokens') finishReason = 'length';

  return {
    id: typeof anthropicPayload?.id === 'string' ? anthropicPayload.id : `chatcmpl_${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelID,
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
  };
};

/**
 * Emit a non-stream OpenAI completion as SSE chunks (for clients that requested stream).
 * @param {import('node:http').ServerResponse} res
 * @param {object} completion
 */
export const writeOpenaiCompletionAsSse = (res, completion) => {
  const choice = completion?.choices?.[0];
  const message = choice?.message || {};
  const id = completion.id || `chatcmpl_${randomUUID()}`;
  const model = completion.model || 'unknown';
  const created = completion.created || Math.floor(Date.now() / 1000);

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });

  const write = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`);
  };

  if (typeof message.content === 'string' && message.content) {
    write({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant', content: message.content }, finish_reason: null }],
    });
  } else {
    write({
      id,
      object: 'chat.completion.chunk',
      created,
      model,
      choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
    });
  }

  if (Array.isArray(message.tool_calls)) {
    for (let index = 0; index < message.tool_calls.length; index += 1) {
      const call = message.tool_calls[index];
      write({
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index,
              id: call.id,
              type: 'function',
              function: {
                name: call.function?.name,
                arguments: call.function?.arguments || '',
              },
            }],
          },
          finish_reason: null,
        }],
      });
    }
  }

  write({
    id,
    object: 'chat.completion.chunk',
    created,
    model,
    choices: [{ index: 0, delta: {}, finish_reason: choice?.finish_reason || 'stop' }],
  });
  res.write('data: [DONE]\n\n');
  res.end();
};

const GOOGLE_UNSUPPORTED_SCHEMA_KEYS = new Set([
  '$schema',
  'additionalProperties',
  'definitions',
  '$defs',
  '$ref',
  'strict',
]);

const toGoogleSchema = (schema) => {
  if (Array.isArray(schema)) return schema.map(toGoogleSchema);
  if (!schema || typeof schema !== 'object') return schema;
  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, value] of Object.entries(schema)) {
    if (GOOGLE_UNSUPPORTED_SCHEMA_KEYS.has(key)) continue;
    result[key] = toGoogleSchema(value);
  }
  return result;
};

/**
 * Convert OpenAI chat messages + tools into Gemini generateContent body.
 * @param {{ modelID: string, body: Record<string, unknown> }} input
 */
export const openaiBodyToGoogle = ({ modelID, body }) => {
  const messagesIn = Array.isArray(body.messages) ? body.messages : [];
  /** @type {string[]} */
  const systemParts = [];
  /** @type {object[]} */
  const contents = [];
  /** @type {Map<string, string>} */
  const toolCallNames = new Map();

  for (const raw of messagesIn) {
    if (!raw || typeof raw !== 'object') continue;
    const role = raw.role;
    if (role === 'system' || role === 'developer') {
      const text = textFromContent(raw.content);
      if (text) systemParts.push(text);
      continue;
    }

    if (role === 'assistant') {
      /** @type {object[]} */
      const parts = [];
      const text = textFromContent(raw.content);
      if (text) parts.push({ text });
      if (Array.isArray(raw.tool_calls)) {
        for (const call of raw.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const name = call.function?.name || call.name;
          if (typeof name !== 'string' || !name) continue;
          const callId = typeof call.id === 'string' ? call.id : '';
          if (callId) toolCallNames.set(callId, name);
          let args = {};
          const rawArgs = call.function?.arguments ?? call.arguments;
          if (typeof rawArgs === 'string' && rawArgs.trim()) {
            try {
              args = JSON.parse(rawArgs);
            } catch {
              args = { raw: rawArgs };
            }
          } else if (rawArgs && typeof rawArgs === 'object') {
            args = rawArgs;
          }
          parts.push({ functionCall: { name, args } });
        }
      }
      if (parts.length === 0) parts.push({ text: '' });
      contents.push({ role: 'model', parts });
      continue;
    }

    if (role === 'tool') {
      const callId = typeof raw.tool_call_id === 'string' ? raw.tool_call_id : '';
      const name = (typeof raw.name === 'string' && raw.name)
        || (callId ? toolCallNames.get(callId) : '')
        || 'tool';
      const text = textFromContent(raw.content);
      let responsePayload;
      try {
        responsePayload = text ? JSON.parse(text) : { result: text };
      } catch {
        responsePayload = { result: text };
      }
      const part = {
        functionResponse: {
          name,
          response: responsePayload && typeof responsePayload === 'object'
            ? responsePayload
            : { result: text },
        },
      };
      const last = contents[contents.length - 1];
      if (last?.role === 'user' && Array.isArray(last.parts)) {
        last.parts.push(part);
      } else {
        contents.push({ role: 'user', parts: [part] });
      }
      continue;
    }

    contents.push({ role: 'user', parts: [{ text: textFromContent(raw.content) || '' }] });
  }

  /** @type {object[]} */
  const functionDeclarations = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
      const name = typeof fn.name === 'string' ? fn.name : '';
      if (!name) continue;
      functionDeclarations.push({
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: toGoogleSchema(
          fn.parameters && typeof fn.parameters === 'object'
            ? fn.parameters
            : { type: 'object', properties: {} },
        ),
      });
    }
  }

  const maxOutputTokens = Number(body.max_tokens) > 0
    ? Number(body.max_tokens)
    : (Number(body.max_completion_tokens) > 0 ? Number(body.max_completion_tokens) : 8192);

  /** @type {Record<string, unknown>} */
  const out = {
    contents,
    generationConfig: {
      maxOutputTokens,
      ...(modelID.toLowerCase().startsWith('gemini-3')
        ? { thinkingConfig: { thinkingLevel: modelID.toLowerCase().includes('flash') ? 'minimal' : 'low' } }
        : { thinkingConfig: { thinkingBudget: 0 } }),
    },
  };
  if (systemParts.length) {
    out.systemInstruction = { parts: [{ text: systemParts.join('\n\n') }] };
  }
  if (functionDeclarations.length) {
    out.tools = [{ functionDeclarations }];
  }
  return out;
};

/**
 * @param {object} googlePayload
 * @param {string} modelID
 */
export const googleResponseToOpenai = (googlePayload, modelID) => {
  const parts = googlePayload?.candidates?.[0]?.content?.parts;
  const list = Array.isArray(parts) ? parts : [];
  const text = list
    .map((part) => (typeof part?.text === 'string' ? part.text : ''))
    .join('');
  const functionCalls = list.filter((part) => part?.functionCall && typeof part.functionCall === 'object');
  /** @type {object} */
  const message = {
    role: 'assistant',
    content: text || null,
  };
  if (functionCalls.length) {
    message.tool_calls = functionCalls.map((part) => ({
      id: `call_${randomUUID()}`,
      type: 'function',
      function: {
        name: part.functionCall.name,
        arguments: JSON.stringify(part.functionCall.args ?? {}),
      },
    }));
  }
  const finishReason = functionCalls.length
    ? 'tool_calls'
    : (googlePayload?.candidates?.[0]?.finishReason === 'MAX_TOKENS' ? 'length' : 'stop');
  return {
    id: `chatcmpl_${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelID,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
};

/**
 * Convert OpenAI chat body into OpenAI Responses API input.
 * @param {{ modelID: string, body: Record<string, unknown> }} input
 */
export const openaiBodyToResponses = ({ modelID, body }) => {
  const messagesIn = Array.isArray(body.messages) ? body.messages : [];
  /** @type {string[]} */
  const instructions = [];
  /** @type {object[]} */
  const input = [];

  for (const raw of messagesIn) {
    if (!raw || typeof raw !== 'object') continue;
    const role = raw.role;
    if (role === 'system' || role === 'developer') {
      const text = textFromContent(raw.content);
      if (text) instructions.push(text);
      continue;
    }
    if (role === 'assistant') {
      /** @type {object[]} */
      const content = [];
      const text = textFromContent(raw.content);
      if (text) content.push({ type: 'output_text', text });
      if (Array.isArray(raw.tool_calls)) {
        for (const call of raw.tool_calls) {
          if (!call || typeof call !== 'object') continue;
          const name = call.function?.name || call.name;
          if (typeof name !== 'string' || !name) continue;
          let args = {};
          const rawArgs = call.function?.arguments ?? call.arguments;
          if (typeof rawArgs === 'string' && rawArgs.trim()) {
            try {
              args = JSON.parse(rawArgs);
            } catch {
              args = { raw: rawArgs };
            }
          } else if (rawArgs && typeof rawArgs === 'object') {
            args = rawArgs;
          }
          input.push({
            type: 'function_call',
            call_id: typeof call.id === 'string' ? call.id : randomUUID(),
            name,
            arguments: JSON.stringify(args),
          });
        }
      }
      if (content.length) {
        input.push({ type: 'message', role: 'assistant', content });
      }
      continue;
    }
    if (role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: typeof raw.tool_call_id === 'string' ? raw.tool_call_id : 'tool',
        output: textFromContent(raw.content),
      });
      continue;
    }
    input.push({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: textFromContent(raw.content) || '' }],
    });
  }

  /** @type {object[]} */
  const tools = [];
  if (Array.isArray(body.tools)) {
    for (const tool of body.tools) {
      if (!tool || typeof tool !== 'object') continue;
      const fn = tool.function && typeof tool.function === 'object' ? tool.function : tool;
      const name = typeof fn.name === 'string' ? fn.name : '';
      if (!name) continue;
      tools.push({
        type: 'function',
        name,
        description: typeof fn.description === 'string' ? fn.description : '',
        parameters: fn.parameters && typeof fn.parameters === 'object'
          ? fn.parameters
          : { type: 'object', properties: {} },
      });
    }
  }

  /** @type {Record<string, unknown>} */
  const out = {
    model: modelID,
    input,
    store: false,
    stream: false,
  };
  if (instructions.length) out.instructions = instructions.join('\n\n');
  if (tools.length) out.tools = tools;
  return out;
};

/**
 * @param {object} responsesPayload
 * @param {string} modelID
 */
export const responsesPayloadToOpenai = (responsesPayload, modelID) => {
  const output = Array.isArray(responsesPayload?.output) ? responsesPayload.output : [];
  let text = typeof responsesPayload?.output_text === 'string' ? responsesPayload.output_text : '';
  /** @type {object[]} */
  const toolCalls = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'message' && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (part?.type === 'output_text' && typeof part.text === 'string') {
          text += part.text;
        }
      }
    }
    if (item.type === 'function_call') {
      toolCalls.push({
        id: typeof item.call_id === 'string' ? item.call_id : randomUUID(),
        type: 'function',
        function: {
          name: item.name,
          arguments: typeof item.arguments === 'string'
            ? item.arguments
            : JSON.stringify(item.arguments ?? {}),
        },
      });
    }
  }

  /** @type {object} */
  const message = {
    role: 'assistant',
    content: text || null,
  };
  if (toolCalls.length) message.tool_calls = toolCalls;
  const finishReason = toolCalls.length
    ? 'tool_calls'
    : (responsesPayload?.status === 'incomplete' ? 'length' : 'stop');

  return {
    id: typeof responsesPayload?.id === 'string' ? responsesPayload.id : `chatcmpl_${randomUUID()}`,
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelID,
    choices: [{ index: 0, message, finish_reason: finishReason }],
  };
};

const writeTranslatedCompletion = (res, completion, wantStream) => {
  if (wantStream) {
    writeOpenaiCompletionAsSse(res, completion);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(completion));
};

/**
 * Build the upstream OpenAI-compatible chat body. Forces non-streaming and
 * strips stream_options (invalid unless stream === true).
 *
 * @param {{
 *   body: Record<string, unknown>,
 *   modelID: string,
 *   messages: unknown,
 * }} input
 */
export const buildOpenaiCompatibleForwardBody = ({ body, modelID, messages }) => {
  const {
    stream: _ignoredStream,
    stream_options: _ignoredStreamOptions,
    ...bodyWithoutStream
  } = body && typeof body === 'object' ? body : {};
  return {
    ...bodyWithoutStream,
    model: modelID,
    messages,
    stream: false,
  };
};

/**
 * Forward an OpenAI-format chat completion through the resolved upstream.
 *
 * @param {{
 *   upstream: {
 *     kind: 'openai-compatible' | 'anthropic' | 'google' | 'openai-responses',
 *     modelID: string,
 *     baseURL: string,
 *     headers: Record<string, string>,
 *     anonymous?: boolean,
 *   },
 *   body: Record<string, unknown>,
 *   res: import('node:http').ServerResponse,
 *   signal?: AbortSignal,
 *   reasoningStore?: ReturnType<typeof createReasoningContentStore>,
 * }} input
 */
export const forwardChatCompletions = async ({ upstream, body, res, signal, reasoningStore = null }) => {
  const wantStream = body.stream === true;
  // Force the job model — never trust the child-supplied model id for billing/auth scope.
  const modelID = upstream.modelID;
  const requestSignal = signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const store = reasoningStore || createReasoningContentStore();

  if (upstream.kind === 'anthropic') {
    const anthropicBody = openaiBodyToAnthropic({ modelID, body });
    const response = await fetch(`${upstream.baseURL.replace(/\/+$/, '')}/messages`, {
      method: 'POST',
      headers: upstream.headers,
      body: JSON.stringify(anthropicBody),
      signal: requestSignal,
    });
    const text = await response.text();
    if (!response.ok) {
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(text || JSON.stringify({ error: { message: 'Anthropic upstream failed' } }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Anthropic returned invalid JSON' } }));
      return;
    }
    writeTranslatedCompletion(res, anthropicResponseToOpenai(payload, modelID), wantStream);
    return;
  }

  if (upstream.kind === 'google') {
    const googleBody = openaiBodyToGoogle({ modelID, body });
    const url = `${upstream.baseURL.replace(/\/+$/, '')}/models/${encodeURIComponent(modelID)}:generateContent`;
    const response = await fetch(url, {
      method: 'POST',
      headers: upstream.headers,
      body: JSON.stringify(googleBody),
      signal: requestSignal,
    });
    const text = await response.text();
    if (!response.ok) {
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(text || JSON.stringify({ error: { message: 'Google upstream failed' } }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Google returned invalid JSON' } }));
      return;
    }
    writeTranslatedCompletion(res, googleResponseToOpenai(payload, modelID), wantStream);
    return;
  }

  if (upstream.kind === 'openai-responses') {
    const responsesBody = openaiBodyToResponses({ modelID, body });
    // ChatGPT Codex rejects max_output_tokens; Copilot /responses may accept it — omit for oauth safety.
    const response = await fetch(upstream.baseURL.replace(/\/+$/, ''), {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        ...upstream.headers,
      },
      body: JSON.stringify(responsesBody),
      signal: requestSignal,
    });
    const text = await response.text();
    if (!response.ok) {
      res.writeHead(response.status, { 'Content-Type': 'application/json' });
      res.end(text || JSON.stringify({ error: { message: 'Responses upstream failed' } }));
      return;
    }
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Responses upstream returned invalid JSON' } }));
      return;
    }
    writeTranslatedCompletion(res, responsesPayloadToOpenai(payload, modelID), wantStream);
    return;
  }

  // openai-compatible: inject auth + forced model.
  // Always call upstream non-streaming so we can capture reasoning_content for
  // thinking + tool-call providers (DeepSeek / Zen), then synthesize SSE if asked.
  const trimmedBase = upstream.baseURL.replace(/\/+$/, '');
  const patchedMessages = store.patchMessages(body.messages);
  const forwardBody = buildOpenaiCompatibleForwardBody({
    body,
    modelID,
    messages: patchedMessages,
  });

  const response = await fetch(`${trimmedBase}/chat/completions`, {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      ...upstream.headers,
    },
    body: JSON.stringify(forwardBody),
    signal: requestSignal,
  });

  const payloadText = await response.text().catch(() => '');
  if (!response.ok) {
    res.writeHead(response.status, { 'Content-Type': 'application/json' });
    if (
      upstream.anonymous
      && (response.status === 401 || response.status === 403)
    ) {
      res.end(JSON.stringify({
        error: {
          message: 'OpenCode Zen rejected this free-model request without an API key. Connect OpenCode Zen or pick a logged-in API provider.',
          code: 'no-provider-login',
        },
      }));
      return;
    }
    res.end(payloadText || JSON.stringify({ error: { message: 'Upstream chat completion failed' } }));
    return;
  }

  let completion;
  try {
    completion = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    res.writeHead(502, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Upstream returned invalid JSON' } }));
    return;
  }
  store.rememberFromCompletion(completion);
  writeTranslatedCompletion(res, completion, wantStream);
};

/**
 * One-shot non-streaming chat completion for format parse/merge (no tools).
 * @param {{
 *   upstream: {
 *     kind: string,
 *     baseURL: string,
 *     headers: Record<string, string>,
 *     modelID: string,
 *     anonymous?: boolean,
 *   },
 *   messages: Array<{ role: string, content: string }>,
 *   signal?: AbortSignal,
 * }} input
 * @returns {Promise<{ text: string, completion: Record<string, unknown> }>}
 */
export const completeChatOnce = async ({ upstream, messages, signal }) => {
  /** @type {{ statusCode?: number, headers?: Record<string, string>, chunks: Buffer[] }} */
  const sink = { chunks: [] };
  const res = {
    writeHead(statusCode, headers) {
      sink.statusCode = statusCode;
      sink.headers = headers;
    },
    end(chunk) {
      if (chunk != null) {
        sink.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
    },
    write(chunk) {
      if (chunk != null) {
        sink.chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
      }
      return true;
    },
  };

  await forwardChatCompletions({
    upstream,
    body: {
      model: upstream.modelID,
      stream: false,
      messages,
    },
    res,
    signal: signal || AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  const payloadText = Buffer.concat(sink.chunks).toString('utf8');
  if (sink.statusCode && sink.statusCode >= 400) {
    let message = 'Upstream chat completion failed';
    let code;
    try {
      const parsed = JSON.parse(payloadText);
      message = parsed?.error?.message || parsed?.error || message;
      code = parsed?.error?.code;
    } catch {
      if (payloadText.trim()) message = payloadText.trim().slice(0, 500);
    }
    throw Object.assign(new Error(typeof message === 'string' ? message : 'Upstream chat completion failed'), {
      statusCode: sink.statusCode,
      code: typeof code === 'string' ? code : 'openwiki-llm-failed',
    });
  }

  let completion;
  try {
    completion = payloadText ? JSON.parse(payloadText) : {};
  } catch {
    throw Object.assign(new Error('Upstream returned invalid JSON'), {
      statusCode: 502,
      code: 'openwiki-llm-invalid-json',
    });
  }

  const choice = Array.isArray(completion?.choices) ? completion.choices[0] : null;
  const text = textFromContent(choice?.message?.content);
  if (!text.trim()) {
    throw Object.assign(new Error('Model returned an empty response'), {
      statusCode: 502,
      code: 'openwiki-llm-empty',
    });
  }
  return { text, completion };
};
