import {
  canUseOpenWikiGatewayModel,
  isOpenCodeZenProvider,
  resolveLlmUpstream,
  resolveLlmUpstreamAsync,
} from './llm-upstream.js';

/**
 * @typedef {{ providerID: string, modelID: string }} OpenCodeModelRef
 */

/**
 * @param {unknown} value
 * @returns {OpenCodeModelRef | null}
 */
export const parseModelRef = (value) => {
  if (!value) return null;
  if (typeof value === 'object' && value !== null) {
    const providerID = typeof value.providerID === 'string'
      ? value.providerID.trim()
      : (typeof value.providerId === 'string' ? value.providerId.trim() : '');
    const modelID = typeof value.modelID === 'string'
      ? value.modelID.trim()
      : (typeof value.modelId === 'string' ? value.modelId.trim() : '');
    if (!providerID || !modelID) return null;
    return { providerID, modelID };
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const slash = trimmed.indexOf('/');
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    providerID: trimmed.slice(0, slash),
    modelID: trimmed.slice(slash + 1),
  };
};

export { canUseOpenWikiGatewayModel, isOpenCodeZenProvider };

/**
 * Validate that the OpenWiki LLM gateway can call this OpenCode model.
 * Does not build child env (no secrets returned).
 *
 * @param {{
 *   directory: string,
 *   model: OpenCodeModelRef,
 * }} input
 */
export const assertOpenWikiModelGatewayReady = async ({ directory, model }) => {
  if (!model?.providerID || !model?.modelID) {
    throw Object.assign(new Error('Model is required'), {
      statusCode: 400,
      code: 'model-required',
    });
  }
  const upstream = await resolveLlmUpstreamAsync({ directory, model });
  return {
    mappedProvider: 'openai-compatible',
    model,
    upstreamKind: upstream.kind,
    anonymous: Boolean(upstream.anonymous),
  };
};

/**
 * Child-process env for OpenWiki: always openai-compatible against the job gateway.
 * Never includes real provider API keys.
 *
 * @param {{
 *   gatewayBaseUrl: string,
 *   jobToken: string,
 *   model: OpenCodeModelRef,
 * }} input
 */
export const buildOpenWikiGatewayChildEnv = ({ gatewayBaseUrl, jobToken, model }) => {
  if (!gatewayBaseUrl || !jobToken || !model?.modelID) {
    throw Object.assign(new Error('Gateway child env requires base URL, token, and model'), {
      statusCode: 500,
      code: 'openwiki-gateway-misconfigured',
    });
  }
  return {
    env: {
      OPENWIKI_TELEMETRY_DISABLED: '1',
      DO_NOT_TRACK: '1',
      OPENWIKI_PROVIDER: 'openai-compatible',
      OPENAI_COMPATIBLE_BASE_URL: gatewayBaseUrl.replace(/\/+$/, ''),
      OPENAI_COMPATIBLE_API_KEY: jobToken,
      OPENWIKI_MODEL_ID: model.modelID,
    },
    mappedProvider: 'openai-compatible',
    model,
  };
};

/**
 * Preflight helper: ensure the model is gateway-callable.
 * Kept as `buildOpenWikiModelEnv` for route compatibility; returns no secrets.
 *
 * @param {{
 *   directory: string,
 *   model: OpenCodeModelRef,
 * }} input
 */
export const buildOpenWikiModelEnv = ({ directory, model }) => {
  if (!model?.providerID || !model?.modelID) {
    throw Object.assign(new Error('Model is required'), {
      statusCode: 400,
      code: 'model-required',
    });
  }
  // Sync path for routes that are not yet async-only; catalog may be null.
  const upstream = resolveLlmUpstream({ directory, model, catalog: null });
  return {
    env: {
      OPENWIKI_TELEMETRY_DISABLED: '1',
      DO_NOT_TRACK: '1',
      OPENWIKI_MODEL_ID: model.modelID,
      // Placeholder markers only — real child env comes from buildOpenWikiGatewayChildEnv.
      OPENWIKI_PROVIDER: 'openai-compatible',
    },
    mappedProvider: 'openai-compatible',
    model,
    upstreamKind: upstream.kind,
    anonymous: Boolean(upstream.anonymous),
  };
};
