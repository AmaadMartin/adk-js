/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FinishReason} from '@google/genai';

import {redactUriForLog} from '../utils/redact_uri.js';

/** The routing prefix a LiteLLM Proxy deployment adds to a model string. */
const PROXY_PROVIDER = 'litellm_proxy';

/** Providers that accept an uploaded file id instead of inline file data. */
const FILE_ID_REQUIRED_PROVIDERS = new Set(['openai', 'azure']);

/**
 * Maps a chat-completions `finish_reason` onto a genai `FinishReason`.
 *
 * `tool_calls` and `function_call` map to `STOP` because there is no
 * `TOOL_CALL` member: a tool call is a normal completion that stopped to
 * invoke a tool, which is also how Gemini reports it.
 */
const FINISH_REASON_MAPPING: Record<string, FinishReason> = {
  length: FinishReason.MAX_TOKENS,
  stop: FinishReason.STOP,
  tool_calls: FinishReason.STOP,
  function_call: FinishReason.STOP,
  content_filter: FinishReason.SAFETY,
};

/**
 * Removes a leading `litellm_proxy/` routing prefix from a model string.
 *
 * `litellm_proxy` selects the transport, not the model family, so the segment
 * after it names the provider that actually serves the request. A bare
 * `litellm_proxy/<deployment>` has no nested provider and is returned
 * unchanged.
 */
export function stripProxyPrefix(model: string): string {
  if (!model) {
    return model;
  }
  const prefix = `${PROXY_PROVIDER}/`;
  if (!model.toLowerCase().startsWith(prefix)) {
    return model;
  }
  const remaining = model.slice(prefix.length);
  return remaining.includes('/') ? remaining : model;
}

/**
 * Extracts the provider name from a LiteLLM model string, for example
 * `openai` from `openai/gpt-4o`.
 *
 * Returns an empty string when the provider cannot be determined.
 */
export function getProviderFromModel(model: string): string {
  if (!model) {
    return '';
  }
  const stripped = stripProxyPrefix(model);
  const slash = stripped.indexOf('/');
  if (slash !== -1) {
    return stripped.slice(0, slash).toLowerCase();
  }
  const lower = stripped.toLowerCase();
  if (lower.includes('azure')) {
    return 'azure';
  }
  if (lower.startsWith('gpt-') || lower.startsWith('o1')) {
    return 'openai';
  }
  return '';
}

/** Returns true when the model reaches Gemini through LiteLLM. */
export function isLiteLlmGeminiModel(model: string): boolean {
  return (
    model.startsWith('gemini/gemini-') || model.startsWith('vertex_ai/gemini-')
  );
}

/** Maps a chat-completions `finish_reason` onto a genai `FinishReason`. */
export function mapFinishReason(
  finishReason: string | null | undefined,
): FinishReason | undefined {
  if (!finishReason) {
    return undefined;
  }
  return (
    FINISH_REASON_MAPPING[finishReason.toLowerCase()] ?? FinishReason.OTHER
  );
}

/** Returns the error message that goes with a non-stop finish reason. */
export function finishReasonToErrorMessage(finishReason: FinishReason): string {
  if (finishReason === FinishReason.MAX_TOKENS) {
    return 'Maximum tokens reached';
  }
  return `Finished with ${finishReason}`;
}

/** Returns true when the URI looks like an OpenAI or Azure file id. */
export function looksLikeOpenAiFileId(uri: string): boolean {
  return uri.startsWith('file-') || uri.startsWith('assistant-');
}

/** Returns true when the URI is an HTTP or HTTPS URL. */
export function isHttpUrl(uri: string): boolean {
  try {
    const {protocol} = new URL(uri);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

/** Returns true when the URI can be sent to the provider as a file block. */
export function isFileUriSupported(
  provider: string,
  model: string,
  uri: string,
): boolean {
  if (FILE_ID_REQUIRED_PROVIDERS.has(provider)) {
    return looksLikeOpenAiFileId(uri);
  }
  if (provider === 'anthropic') {
    return false;
  }
  if (provider === 'vertex_ai' && !isLiteLlmGeminiModel(model)) {
    return false;
  }
  return true;
}

/** Returns true when the provider needs an uploaded file id, not inline data. */
export function requiresFileId(provider: string): boolean {
  return FILE_ID_REQUIRED_PROVIDERS.has(provider);
}

/**
 * Returns an identifier for a file URI that is safe to log.
 *
 * A display name is already safe, and is the most useful thing to log. An
 * OpenAI file id is reduced to its prefix. Anything else goes through
 * {@link redactUriForLog}, which keeps only the scheme and the file name.
 */
export function redactFileUriForLog(uri: string, displayName?: string): string {
  if (displayName) {
    return displayName;
  }
  if (looksLikeOpenAiFileId(uri)) {
    return `${uri.split('-', 1)[0]}-<redacted>`;
  }
  return redactUriForLog(uri);
}
