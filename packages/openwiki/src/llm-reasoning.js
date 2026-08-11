/**
 * DeepSeek-style thinking models require `reasoning_content` on assistant
 * messages that performed tool calls to be echoed back on every later request.
 * OpenWiki's LangChain OpenAI client strips unknown fields, so the job-scoped
 * gateway must remember and re-inject them.
 */

/**
 * @returns {{
 *   rememberFromMessage: (message: unknown) => void,
 *   rememberFromCompletion: (completion: unknown) => void,
 *   patchMessages: (messages: unknown) => unknown,
 * }}
 */
export const createReasoningContentStore = () => {
  /** @type {Map<string, string>} */
  const byToolCallId = new Map();

  /**
   * @param {unknown} message
   */
  const rememberFromMessage = (message) => {
    if (!message || typeof message !== 'object') return;
    const reasoning = typeof message.reasoning_content === 'string'
      ? message.reasoning_content
      : null;
    if (reasoning === null) return;
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length === 0) return;
    for (const call of message.tool_calls) {
      if (call && typeof call === 'object' && typeof call.id === 'string' && call.id) {
        byToolCallId.set(call.id, reasoning);
      }
    }
  };

  /**
   * @param {unknown} completion
   */
  const rememberFromCompletion = (completion) => {
    if (!completion || typeof completion !== 'object') return;
    const choice = Array.isArray(completion.choices) ? completion.choices[0] : null;
    rememberFromMessage(choice?.message);
  };

  /**
   * @param {unknown} messages
   */
  const patchMessages = (messages) => {
    if (!Array.isArray(messages)) return messages;
    return messages.map((raw) => {
      if (!raw || typeof raw !== 'object' || raw.role !== 'assistant') return raw;
      if (!Array.isArray(raw.tool_calls) || raw.tool_calls.length === 0) return raw;
      if (typeof raw.reasoning_content === 'string') {
        rememberFromMessage(raw);
        return raw;
      }
      let reasoning = null;
      for (const call of raw.tool_calls) {
        if (call && typeof call === 'object' && typeof call.id === 'string' && byToolCallId.has(call.id)) {
          reasoning = byToolCallId.get(call.id);
          break;
        }
      }
      // Providers that require the field reject a missing key; empty string is the
      // documented last resort when history was rebuilt without a captured value.
      return {
        ...raw,
        reasoning_content: reasoning ?? '',
      };
    });
  };

  return {
    rememberFromMessage,
    rememberFromCompletion,
    patchMessages,
  };
};
