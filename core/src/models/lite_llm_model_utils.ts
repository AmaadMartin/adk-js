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

/** Matches both spellings of a Gemma 4 model name. */
const GEMMA4_MODEL_PATTERN = /gemma-?4/;

/**
 * Providers that can route to Anthropic. `bedrock` and `vertex_ai` are
 * multi-model platforms, so {@link isAnthropicRoute} checks the model name for
 * them as well.
 */
const ANTHROPIC_PROVIDERS = new Set(['anthropic', 'bedrock', 'vertex_ai']);

/** Multi-model platforms whose model name decides the Anthropic route. */
const MULTI_MODEL_ANTHROPIC_PROVIDERS = new Set(['bedrock', 'vertex_ai']);

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

/** Returns true when the model reaches Vertex AI through LiteLLM. */
export function isLiteLlmVertexModel(model: string): boolean {
  return stripProxyPrefix(model).startsWith('vertex_ai/');
}

/** Returns true when the model reaches Gemini through LiteLLM. */
export function isLiteLlmGeminiModel(model: string): boolean {
  const stripped = stripProxyPrefix(model);
  return (
    stripped.startsWith('gemini/gemini-') ||
    stripped.startsWith('vertex_ai/gemini-')
  );
}

/**
 * Returns true when the model is a Gemma 4, under either spelling.
 *
 * Ollama uses `gemma4`, while Hugging Face, vLLM and llama.cpp use the
 * hyphenated `gemma-4`. Gemma 3 and earlier do not support tool use at all, so
 * the match is scoped to 4.
 */
export function isGemma4Model(model: string): boolean {
  return GEMMA4_MODEL_PATTERN.test(model.toLowerCase());
}

/**
 * Returns true when the model is an Anthropic Claude model reached through
 * LiteLLM.
 *
 * The `anthropic/` prefix always qualifies. A `bedrock/` model qualifies when
 * the remainder names `anthropic` or `claude`, and a `vertex_ai/` model when
 * the remainder names `claude`; both platforms also host other families.
 */
export function isAnthropicModel(model: string): boolean {
  const lower = stripProxyPrefix(model.toLowerCase());
  if (lower.startsWith('anthropic/')) {
    return true;
  }
  if (lower.startsWith('bedrock/')) {
    const modelPart = lower.slice('bedrock/'.length);
    return modelPart.includes('anthropic') || modelPart.includes('claude');
  }
  if (lower.startsWith('vertex_ai/')) {
    return lower.slice('vertex_ai/'.length).includes('claude');
  }
  return false;
}

/** Returns true when the provider can route to an Anthropic model endpoint. */
export function isAnthropicProvider(provider: string): boolean {
  return ANTHROPIC_PROVIDERS.has(provider.toLowerCase());
}

/**
 * Returns true only when a request actually reaches an Anthropic Claude model.
 *
 * Bedrock and Vertex AI also host Llama and Gemini, so for those platforms the
 * model name must name a Claude model too. Formatting thinking blocks for a
 * non-Claude model makes the provider reject the request with a 400.
 */
export function isAnthropicRoute(provider: string, model: string): boolean {
  if (!isAnthropicProvider(provider)) {
    return false;
  }
  if (MULTI_MODEL_ANTHROPIC_PROVIDERS.has(provider.toLowerCase())) {
    return isAnthropicModel(model);
  }
  return true;
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
