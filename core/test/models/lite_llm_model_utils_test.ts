/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FinishReason} from '@google/genai';
import {describe, expect, it} from 'vitest';

import {
  finishReasonToErrorMessage,
  getProviderFromModel,
  isAnthropicModel,
  isAnthropicProvider,
  isAnthropicRoute,
  isFileUriSupported,
  isGemma4Model,
  isHttpUrl,
  isLiteLlmGeminiModel,
  isLiteLlmVertexModel,
  looksLikeOpenAiFileId,
  mapFinishReason,
  redactFileUriForLog,
  requiresFileId,
  stripProxyPrefix,
} from '../../src/models/lite_llm_model_utils.js';

describe('stripProxyPrefix', () => {
  it('strips the prefix when a provider is nested behind it', () => {
    expect(stripProxyPrefix('litellm_proxy/azure/gpt-4')).toBe('azure/gpt-4');
  });

  it('matches the prefix case-insensitively', () => {
    expect(stripProxyPrefix('LiteLLM_Proxy/anthropic/claude')).toBe(
      'anthropic/claude',
    );
  });

  it('keeps a bare deployment name unchanged', () => {
    expect(stripProxyPrefix('litellm_proxy/my-deployment')).toBe(
      'litellm_proxy/my-deployment',
    );
  });

  it('keeps a model without the prefix unchanged', () => {
    expect(stripProxyPrefix('openai/gpt-4o')).toBe('openai/gpt-4o');
  });

  it('keeps an empty model unchanged', () => {
    expect(stripProxyPrefix('')).toBe('');
  });
});

describe('getProviderFromModel', () => {
  it('returns an empty string for an empty model', () => {
    expect(getProviderFromModel('')).toBe('');
  });

  it('reads the segment before the first slash', () => {
    expect(getProviderFromModel('OpenAI/gpt-4o')).toBe('openai');
  });

  it('reads the provider nested behind the proxy prefix', () => {
    expect(getProviderFromModel('litellm_proxy/azure/gpt-4')).toBe('azure');
  });

  it('treats a bare proxy deployment as the proxy provider', () => {
    expect(getProviderFromModel('litellm_proxy/my-deployment')).toBe(
      'litellm_proxy',
    );
  });

  it('recognises azure from the model name', () => {
    expect(getProviderFromModel('my-azure-deployment')).toBe('azure');
  });

  it('recognises openai from a gpt- or o1 prefix', () => {
    expect(getProviderFromModel('gpt-4o')).toBe('openai');
    expect(getProviderFromModel('o1-preview')).toBe('openai');
  });

  it('returns an empty string when nothing matches', () => {
    expect(getProviderFromModel('llama3')).toBe('');
  });
});

describe('litellm model classification', () => {
  it('recognises gemini models on both routes', () => {
    expect(isLiteLlmGeminiModel('gemini/gemini-2.5-pro')).toBe(true);
    expect(isLiteLlmGeminiModel('vertex_ai/gemini-2.5-flash')).toBe(true);
    expect(isLiteLlmGeminiModel('vertex_ai/claude-4')).toBe(false);
  });

  it('recognises a gemini model behind the proxy prefix', () => {
    expect(
      isLiteLlmGeminiModel('litellm_proxy/vertex_ai/gemini-2.5-flash'),
    ).toBe(true);
    expect(
      isLiteLlmGeminiModel('litellm_proxy/vertex_ai/gemini-2.0-flash'),
    ).toBe(true);
    expect(isLiteLlmGeminiModel('litellm_proxy/gemini/gemini-2.5-pro')).toBe(
      true,
    );
    expect(isLiteLlmGeminiModel('litellm_proxy/openai/gpt-4o')).toBe(false);
  });

  it('recognises vertex models on both routes', () => {
    expect(isLiteLlmVertexModel('vertex_ai/gemini-2.5-flash')).toBe(true);
    expect(isLiteLlmVertexModel('vertex_ai/claude-4')).toBe(true);
    expect(isLiteLlmVertexModel('litellm_proxy/vertex_ai/claude-4')).toBe(true);
    expect(isLiteLlmVertexModel('openai/gpt-4o')).toBe(false);
  });

  it.each([
    ['vertex_ai/gemini-2.5-flash', true],
    ['vertex_ai/claude-sonnet-4', true],
    ['litellm_proxy/vertex_ai/claude-sonnet-4', true],
    ['openai/gpt-4o', false],
    ['gemini/gemini-2.5-pro', false],
    ['', false],
  ])('reports %s as a vertex model: %s', (model, expected) => {
    expect(isLiteLlmVertexModel(model)).toBe(expected);
  });

  it.each([
    ['ollama/gemma4:e2b', true],
    ['google/gemma-4-26B-A4B', true],
    ['ollama/Gemma4:31b', true],
    ['ollama/gemma3:4b', false],
    ['ollama/llama3:8b', false],
    ['openai/gpt-4o', false],
    ['anthropic/claude-3-opus', false],
    ['', false],
  ])('reports %s as a gemma 4 model: %s', (model, expected) => {
    expect(isGemma4Model(model)).toBe(expected);
  });
});

describe('mapFinishReason', () => {
  it.each([
    ['length', FinishReason.MAX_TOKENS],
    ['stop', FinishReason.STOP],
    ['tool_calls', FinishReason.STOP],
    ['function_call', FinishReason.STOP],
    ['content_filter', FinishReason.SAFETY],
    ['STOP', FinishReason.STOP],
    ['something_else', FinishReason.OTHER],
  ])('maps %s', (value, expected) => {
    expect(mapFinishReason(value)).toBe(expected);
  });

  it.each([[null], [undefined], ['']])('returns undefined for %s', (value) => {
    expect(mapFinishReason(value)).toBeUndefined();
  });
});

describe('finishReasonToErrorMessage', () => {
  it('names the token limit explicitly', () => {
    expect(finishReasonToErrorMessage(FinishReason.MAX_TOKENS)).toBe(
      'Maximum tokens reached',
    );
  });

  it('names any other reason', () => {
    expect(finishReasonToErrorMessage(FinishReason.SAFETY)).toBe(
      'Finished with SAFETY',
    );
  });
});

describe('file uri classification', () => {
  it('recognises openai file ids', () => {
    expect(looksLikeOpenAiFileId('file-abc')).toBe(true);
    expect(looksLikeOpenAiFileId('assistant-abc')).toBe(true);
    expect(looksLikeOpenAiFileId('gs://bucket/a.pdf')).toBe(false);
  });

  it('recognises http urls', () => {
    expect(isHttpUrl('https://example.com/a.png')).toBe(true);
    expect(isHttpUrl('http://example.com/a.png')).toBe(true);
    expect(isHttpUrl('gs://bucket/a.png')).toBe(false);
    expect(isHttpUrl('not a uri')).toBe(false);
  });

  it('reports which providers need an uploaded file id', () => {
    expect(requiresFileId('openai')).toBe(true);
    expect(requiresFileId('azure')).toBe(true);
    expect(requiresFileId('anthropic')).toBe(false);
  });
});

describe('isFileUriSupported', () => {
  it('requires a file id on openai and azure', () => {
    expect(isFileUriSupported('openai', 'openai/gpt-4o', 'file-abc')).toBe(
      true,
    );
    expect(
      isFileUriSupported('azure', 'azure/gpt-4o', 'gs://bucket/a.pdf'),
    ).toBe(false);
  });

  it('rejects every file uri on anthropic', () => {
    expect(
      isFileUriSupported('anthropic', 'anthropic/claude', 'gs://bucket/a.pdf'),
    ).toBe(false);
  });

  it('allows vertex file uris only for gemini models', () => {
    expect(
      isFileUriSupported(
        'vertex_ai',
        'vertex_ai/gemini-2.5-flash',
        'gs://bucket/a.pdf',
      ),
    ).toBe(true);
    expect(
      isFileUriSupported(
        'vertex_ai',
        'vertex_ai/claude-4',
        'gs://bucket/a.pdf',
      ),
    ).toBe(false);
  });

  it('allows any uri on other providers', () => {
    expect(isFileUriSupported('groq', 'groq/llama3', 'gs://bucket/a.pdf')).toBe(
      true,
    );
  });
});

describe('redactFileUriForLog', () => {
  it('prefers the display name', () => {
    expect(redactFileUriForLog('gs://bucket/secret.pdf', 'report.pdf')).toBe(
      'report.pdf',
    );
  });

  it('redacts openai file ids', () => {
    expect(redactFileUriForLog('assistant-abc123')).toBe(
      'assistant-<redacted>',
    );
    expect(redactFileUriForLog('file-abc123')).toBe('file-<redacted>');
  });

  it('delegates any other uri to the shared redaction', () => {
    expect(
      redactFileUriForLog(
        'https://storage.example.com/bucket/report.pdf?X-Signature=secret',
      ),
    ).toBe('https://<redacted>/report.pdf');
  });
});

describe('isAnthropicProvider', () => {
  it.each([
    ['anthropic', true],
    ['bedrock', true],
    ['vertex_ai', true],
    ['ANTHROPIC', true],
    ['openai', false],
    ['', false],
  ])('reports %s as %s', (provider: string, expected: boolean) => {
    expect(isAnthropicProvider(provider)).toBe(expected);
  });
});

describe('isAnthropicModel', () => {
  it.each([
    ['anthropic/claude-4-sonnet', true],
    ['anthropic/claude-3-5-sonnet-20241022', true],
    ['Anthropic/Claude-4-Opus', true],
    ['bedrock/anthropic.claude-3-5-sonnet', true],
    ['bedrock/us.anthropic.claude-3-5-sonnet-20241022-v2:0', true],
    ['bedrock/claude-3-5-sonnet', true],
    ['vertex_ai/claude-3-5-sonnet@20241022', true],
    ['litellm_proxy/anthropic/claude-4-sonnet', true],
    ['openai/gpt-4o', false],
    ['gemini/gemini-2.5-pro', false],
    ['vertex_ai/gemini-2.5-flash', false],
    ['bedrock/amazon.titan-text-express-v1', false],
  ])('reports %s as %s', (model: string, expected: boolean) => {
    expect(isAnthropicModel(model)).toBe(expected);
  });
});

describe('isAnthropicRoute', () => {
  it.each([
    ['anthropic', 'anthropic/claude-3-5-sonnet', true],
    ['anthropic', '', true],
    ['bedrock', 'bedrock/anthropic.claude-3-5-sonnet', true],
    ['bedrock', 'bedrock/meta.llama3-70b-instruct-v1:0', false],
    ['vertex_ai', 'vertex_ai/claude-3-5-sonnet@20241022', true],
    ['vertex_ai', 'vertex_ai/gemini-2.5-flash', false],
    ['openai', 'openai/gpt-4o', false],
    ['', '', false],
  ])(
    'reports provider %s with model %s as %s',
    (provider: string, model: string, expected: boolean) => {
      expect(isAnthropicRoute(provider, model)).toBe(expected);
    },
  );
});
