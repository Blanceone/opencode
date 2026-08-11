import { readAuthFile } from './auth.js';
import { readConfig } from './config.js';
import {
  CODEX_RESPONSES_ENDPOINT,
  OPENCODE_LLM_USER_AGENT,
  ensureFreshOpenaiOauth,
  extractChatgptAccountIdFromToken,
  getCopilotEndpoint,
  resolveProviderLogin,
  getCatalogProvider,
  getModelCatalog,
} from './llm-deps.js';

export const OPENCODE_ZEN_BASE_URL = 'https://opencode.ai/zen/v1';
export const GOOGLE_GENERATE_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta';

/**
 * @param {string} providerID
 */
export const isOpenCodeZenProvider = (providerID) =>
  providerID === 'opencode' || providerID === 'opencode-go';

/**
 * Free-tier OpenCode/Zen models that OpenCode may call without a stored API key.
 * Outside OpenCode they still hit zen/v1; auth may be optional for these ids.
 * @param {string} modelID
 */
export const isLikelyFreeOpenCodeModel = (modelID) => {
  const id = String(modelID || '').toLowerCase();
  if (!id) return false;
  if (id.includes('free')) return true;
  // Common OpenCode free defaults
  return id === 'big-pickle' || id === 'gpt-5-nano';
};

/**
 * @param {object | null | undefined} entry
 */
export const extractApiKey = (entry) => {
  if (!entry || typeof entry !== 'object') return null;
  if (typeof entry.key === 'string' && entry.key.trim()) return entry.key.trim();
  if (typeof entry.access === 'string' && entry.access.trim()) return entry.access.trim();
  if (typeof entry.token === 'string' && entry.token.trim()) return entry.token.trim();
  if (typeof entry.refresh === 'string' && entry.refresh.trim()) return entry.refresh.trim();
  return null;
};

/**
 * @param {string} workingDirectory
 * @param {string} providerID
 */
const readProviderOptions = (workingDirectory, providerID) => {
  try {
    const config = readConfig(workingDirectory);
    const providerCfg = config?.provider?.[providerID];
    if (!providerCfg || typeof providerCfg !== 'object') {
      return { baseURL: null, apiKeyFromConfig: null };
    }
    const baseURL = typeof providerCfg?.options?.baseURL === 'string'
      ? providerCfg.options.baseURL.trim() || null
      : null;
    const apiKeyFromConfig = typeof providerCfg?.options?.apiKey === 'string'
      ? providerCfg.options.apiKey.trim() || null
      : null;
    return { baseURL, apiKeyFromConfig };
  } catch {
    return { baseURL: null, apiKeyFromConfig: null };
  }
};

const unsupported = (message, providerID) => Object.assign(new Error(message), {
  statusCode: 400,
  code: 'provider-unsupported-for-openwiki',
  providerID,
});

/**
 * Whether the OpenWiki LLM gateway can attempt this model (preflight / hasLogin).
 * @param {{ directory: string, model: { providerID: string, modelID: string } }} input
 */
export const canUseOpenWikiGatewayModel = ({ directory, model }) => {
  try {
    resolveLlmUpstream({ directory, model });
    return true;
  } catch {
    return false;
  }
};

/**
 * @param {{
 *   providerID: string,
 *   modelID: string,
 *   login: object | null,
 *   configBaseURL: string | null,
 *   apiKey: string | null,
 * }} input
 */
const resolveOpenaiOauthUpstream = ({ providerID, modelID, login, configBaseURL, apiKey }) => {
  if (configBaseURL && apiKey) {
    return {
      kind: 'openai-compatible',
      providerID,
      modelID,
      baseURL: configBaseURL.replace(/\/+$/, ''),
      headers: {
        authorization: `Bearer ${apiKey}`,
        'content-type': 'application/json',
      },
    };
  }
  const access = typeof login?.access === 'string' ? login.access.trim() : '';
  const refresh = typeof login?.refresh === 'string' ? login.refresh.trim() : '';
  if (!access && !refresh) {
    throw Object.assign(new Error('No OpenCode login found for provider "openai"'), {
      statusCode: 401,
      code: 'no-provider-login',
      providerID,
    });
  }
  const accountId = access ? extractChatgptAccountIdFromToken(access) : null;
  return {
    kind: 'openai-responses',
    providerID,
    modelID,
    baseURL: CODEX_RESPONSES_ENDPOINT,
    headers: {
      authorization: `Bearer ${access || 'pending-refresh'}`,
      'content-type': 'application/json',
      accept: 'application/json',
      originator: 'opencode',
      'user-agent': OPENCODE_LLM_USER_AGENT,
      ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
    },
    oauth: true,
  };
};

/**
 * @param {{
 *   providerID: string,
 *   modelID: string,
 *   login: object | null,
 *   apiKey: string | null,
 *   endpoint?: 'chat' | 'messages' | 'responses',
 * }} input
 */
const resolveCopilotUpstream = ({ providerID, modelID, login, apiKey, endpoint = 'chat' }) => {
  const token = apiKey
    || (typeof login?.refresh === 'string' ? login.refresh.trim() : '')
    || (typeof login?.access === 'string' ? login.access.trim() : '')
    || (typeof login?.key === 'string' ? login.key.trim() : '');
  if (!token) {
    throw Object.assign(new Error('No OpenCode login found for provider "github-copilot"'), {
      statusCode: 401,
      code: 'no-provider-login',
      providerID,
    });
  }
  const baseURL = login?.enterpriseUrl
    ? `https://copilot-api.${String(login.enterpriseUrl).replace(/^https?:\/\//, '').replace(/\/+$/, '')}`
    : 'https://api.githubcopilot.com';
  const authHeaders = {
    authorization: `Bearer ${token}`,
    'user-agent': OPENCODE_LLM_USER_AGENT,
    'x-github-api-version': '2026-06-01',
    'content-type': 'application/json',
  };
  const headers = {
    ...authHeaders,
    'openai-intent': 'conversation-edits',
    'x-initiator': 'agent',
  };

  if (endpoint === 'messages') {
    return {
      kind: 'anthropic',
      providerID,
      modelID,
      baseURL: `${baseURL.replace(/\/+$/, '')}/v1`,
      headers: {
        ...headers,
        'anthropic-version': '2023-06-01',
      },
    };
  }

  if (endpoint === 'responses') {
    return {
      kind: 'openai-responses',
      providerID,
      modelID,
      baseURL: `${baseURL.replace(/\/+$/, '')}/responses`,
      headers,
    };
  }

  return {
    kind: 'openai-compatible',
    providerID,
    modelID,
    baseURL: baseURL.replace(/\/+$/, ''),
    headers,
  };
};

/**
 * Resolve where the gateway should forward OpenAI-format chat/completions.
 *
 * @param {{
 *   directory: string,
 *   model: { providerID: string, modelID: string },
 *   catalog?: object | null,
 * }} input
 * @returns {{
 *   kind: 'openai-compatible' | 'anthropic' | 'google' | 'openai-responses',
 *   providerID: string,
 *   modelID: string,
 *   baseURL: string,
 *   headers: Record<string, string>,
 *   anonymous?: boolean,
 *   oauth?: boolean,
 * }}
 */
export const resolveLlmUpstream = ({ directory, model, catalog = null }) => {
  if (!model?.providerID || !model?.modelID) {
    throw Object.assign(new Error('Model is required'), {
      statusCode: 400,
      code: 'model-required',
    });
  }

  const providerID = model.providerID;
  const modelID = model.modelID;
  const auth = readAuthFile();
  const login = resolveProviderLogin({
    auth,
    workingDirectory: directory,
    providerID,
  });
  const { baseURL: configBaseURL, apiKeyFromConfig } = readProviderOptions(directory, providerID);
  const apiKey = apiKeyFromConfig || extractApiKey(login);

  if (providerID === 'openai' && login?.type === 'oauth') {
    return resolveOpenaiOauthUpstream({
      providerID,
      modelID,
      login,
      configBaseURL,
      apiKey,
    });
  }

  if (providerID === 'anthropic' && apiKey && !configBaseURL) {
    return {
      kind: 'anthropic',
      providerID,
      modelID,
      baseURL: 'https://api.anthropic.com/v1',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
    };
  }

  if (isOpenCodeZenProvider(providerID)) {
    const zenBase = (configBaseURL || OPENCODE_ZEN_BASE_URL).replace(/\/+$/, '');
    if (apiKey) {
      return {
        kind: 'openai-compatible',
        providerID,
        modelID,
        baseURL: zenBase,
        headers: {
          authorization: `Bearer ${apiKey}`,
          'content-type': 'application/json',
        },
      };
    }
    if (isLikelyFreeOpenCodeModel(modelID)) {
      return {
        kind: 'openai-compatible',
        providerID,
        modelID,
        baseURL: zenBase,
        headers: {
          'content-type': 'application/json',
          'user-agent': 'opencode/1.0 openwiki',
        },
        anonymous: true,
      };
    }
    throw Object.assign(
      new Error('Built-in OpenCode/Zen free models cannot run OpenWiki without an API key. Connect OpenCode Zen or pick another logged-in provider.'),
      { statusCode: 401, code: 'no-provider-login', providerID },
    );
  }

  if (providerID === 'github-copilot') {
    return resolveCopilotUpstream({ providerID, modelID, login, apiKey, endpoint: 'chat' });
  }

  if (!apiKey) {
    throw Object.assign(new Error(`No OpenCode login found for provider "${providerID}"`), {
      statusCode: 401,
      code: 'no-provider-login',
      providerID,
    });
  }

  if (providerID === 'google' || providerID === 'gemini') {
    return {
      kind: 'google',
      providerID,
      modelID,
      baseURL: (configBaseURL || GOOGLE_GENERATE_BASE_URL).replace(/\/+$/, ''),
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'x-goog-api-key': apiKey,
      },
    };
  }

  let baseURL = configBaseURL;
  if (!baseURL) {
    const catalogEntry = getCatalogProvider(catalog, providerID);
    if (typeof catalogEntry?.api === 'string' && catalogEntry.api.trim()) {
      baseURL = catalogEntry.api.trim();
    } else if (providerID === 'openai') {
      baseURL = 'https://api.openai.com/v1';
    } else if (providerID === 'openrouter') {
      baseURL = 'https://openrouter.ai/api/v1';
    }
  }

  if (!baseURL) {
    throw unsupported(
      `Provider "${providerID}" has no known API base URL for the OpenWiki gateway.`,
      providerID,
    );
  }

  return {
    kind: 'openai-compatible',
    providerID,
    modelID,
    baseURL: baseURL.replace(/\/+$/, ''),
    headers: {
      authorization: `Bearer ${apiKey}`,
      'content-type': 'application/json',
    },
  };
};

/**
 * Async wrapper: OAuth refresh, Copilot endpoint probe, then catalog baseURL fallback.
 * @param {{ directory: string, model: { providerID: string, modelID: string } }} input
 */
export const resolveLlmUpstreamAsync = async (input) => {
  const { directory, model } = input;
  if (!model?.providerID || !model?.modelID) {
    throw Object.assign(new Error('Model is required'), {
      statusCode: 400,
      code: 'model-required',
    });
  }

  const providerID = model.providerID;
  const modelID = model.modelID;
  const auth = readAuthFile();
  const login = resolveProviderLogin({
    auth,
    workingDirectory: directory,
    providerID,
  });
  const { baseURL: configBaseURL, apiKeyFromConfig } = readProviderOptions(directory, providerID);
  const apiKey = apiKeyFromConfig || extractApiKey(login);

  if (providerID === 'openai' && login?.type === 'oauth' && !configBaseURL) {
    const fresh = await ensureFreshOpenaiOauth(login);
    const accountId = extractChatgptAccountIdFromToken(fresh.access);
    return {
      kind: 'openai-responses',
      providerID,
      modelID,
      baseURL: CODEX_RESPONSES_ENDPOINT,
      headers: {
        authorization: `Bearer ${fresh.access}`,
        'content-type': 'application/json',
        accept: 'application/json',
        originator: 'opencode',
        'user-agent': OPENCODE_LLM_USER_AGENT,
        ...(accountId ? { 'ChatGPT-Account-Id': accountId } : {}),
      },
      oauth: true,
    };
  }

  if (providerID === 'github-copilot') {
    const provisional = resolveCopilotUpstream({
      providerID,
      modelID,
      login,
      apiKey,
      endpoint: 'chat',
    });
    try {
      const endpoint = await getCopilotEndpoint({
        baseURL: provisional.baseURL,
        headers: {
          Authorization: provisional.headers.authorization,
          'User-Agent': OPENCODE_LLM_USER_AGENT,
          'X-GitHub-Api-Version': '2026-06-01',
        },
        modelID,
      });
      return resolveCopilotUpstream({
        providerID,
        modelID,
        login,
        apiKey,
        endpoint,
      });
    } catch {
      // Fall back to chat/completions when /models is unavailable.
      return provisional;
    }
  }

  try {
    return resolveLlmUpstream({ ...input, catalog: null });
  } catch (error) {
    const needsCatalog = error?.code === 'provider-unsupported-for-openwiki'
      || (error instanceof Error && /no known API base URL/i.test(error.message));
    if (!needsCatalog) throw error;
  }

  let catalog = null;
  try {
    catalog = await getModelCatalog();
  } catch {
    catalog = null;
  }
  return resolveLlmUpstream({ ...input, catalog });
};
