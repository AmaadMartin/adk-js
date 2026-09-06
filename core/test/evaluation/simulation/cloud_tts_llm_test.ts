/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_cloud_tts_llm.py` at `main`,
 * commit `a119dd77`. Each `it(...)` title keeps the Python test name verbatim.
 *
 * The reference's `mock_tts_modules` fixture patches `sys.modules` so the lazy
 * import never reaches the real SDK. Here the `client` constructor option
 * serves that purpose, so no module mocking is needed.
 */

import {CloudTtsLlm, LlmRequest, LlmResponse} from '@google/adk';
import {Content} from '@google/genai';
import {describe, expect, it, vi} from 'vitest';

import {
  extractText,
  extractVoiceConfig,
} from '../../../src/evaluation/simulation/cloud_tts_llm.js';

const AUDIO_BYTES = new TextEncoder().encode('AUDIO_BYTES');

/** Builds an LlmRequest around ready-made contents. */
function contentsRequest(
  contents: Content[],
  config?: LlmRequest['config'],
): LlmRequest {
  return {contents, config, liveConnectConfig: {}, toolsDict: {}};
}

/** Builds an LlmRequest whose single Content carries the given text parts. */
function textRequest(...texts: string[]): LlmRequest {
  return contentsRequest([
    {role: 'user', parts: texts.map((t) => ({text: t}))},
  ]);
}

/** A fake Cloud TTS client resolving with the given audio payload. */
function fakeClient(audioContent: Uint8Array | string) {
  return {
    synthesizeSpeech: vi.fn().mockResolvedValue([{audioContent}, undefined]),
  };
}

/** Drains an async generator into an array. */
async function collect(
  gen: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of gen) {
    responses.push(response);
  }
  return responses;
}

/** Returns the base64 audio payload of a response, or fails the test. */
function audioOf(response: LlmResponse): string {
  const data = response.content?.parts?.[0]?.inlineData?.data;
  if (data === undefined) {
    expect.fail('expected an inlineData audio part on the response');
  }
  return data;
}

describe('CloudTtsLlm', () => {
  it('test_default_fields', () => {
    const llm = new CloudTtsLlm({model: 'cloud_tts'});

    expect(llm.audioEncoding).toBe('LINEAR16');
    expect(llm.speakingSpeed).toBe(1.0);
    expect(llm.pitch).toBe(0.0);
  });

  it('test_supported_models', () => {
    expect(CloudTtsLlm.supportedModels).toEqual(['cloud_tts']);
  });

  it('test_extract_text_joins_parts', () => {
    expect(extractText(textRequest('Hello', 'world'))).toBe('Hello world');
  });

  it('test_extract_text_ignores_non_text_parts', () => {
    const request = contentsRequest([
      {
        role: 'user',
        parts: [
          {text: 'say this'},
          {inlineData: {mimeType: 'audio/pcm', data: 'eA=='}},
        ],
      },
    ]);

    expect(extractText(request)).toBe('say this');
  });

  it('test_extract_text_raises_without_text', () => {
    const request = contentsRequest([{role: 'user', parts: []}]);

    expect(() => extractText(request)).toThrow(
      /CloudTtsLlm requires text in LlmRequest\.contents/,
    );
  });

  it('test_extract_voice_config_defaults', () => {
    expect(extractVoiceConfig(textRequest('hi'))).toEqual({
      voiceName: 'en-US-Studio-O',
      languageCode: 'en-US',
    });
  });

  it('test_extract_voice_config_reads_speech_config', () => {
    const request = contentsRequest(
      [{role: 'user', parts: [{text: 'bonjour'}]}],
      {
        speechConfig: {
          languageCode: 'fr-FR',
          voiceConfig: {prebuiltVoiceConfig: {voiceName: 'fr-FR-Neural2-A'}},
        },
      },
    );

    expect(extractVoiceConfig(request)).toEqual({
      voiceName: 'fr-FR-Neural2-A',
      languageCode: 'fr-FR',
    });
  });

  it('test_success_returns_audio', async () => {
    const client = fakeClient(AUDIO_BYTES);
    const llm = new CloudTtsLlm({model: 'cloud_tts', client});

    const responses = await collect(
      llm.generateContentAsync(textRequest('hello')),
    );

    expect(responses).toHaveLength(1);
    expect(Buffer.from(audioOf(responses[0]), 'base64')).toEqual(
      Buffer.from(AUDIO_BYTES),
    );
    expect(responses[0].content?.parts?.[0]?.inlineData?.mimeType).toBe(
      'audio/l16',
    );
    expect(client.synthesizeSpeech).toHaveBeenCalledOnce();
  });

  it('test_mp3_encoding_mime_type', async () => {
    const llm = new CloudTtsLlm({
      model: 'cloud_tts',
      audioEncoding: 'MP3',
      client: fakeClient(new TextEncoder().encode('MP3DATA')),
    });

    const responses = await collect(
      llm.generateContentAsync(textRequest('hi')),
    );

    expect(responses[0].content?.parts?.[0]?.inlineData?.mimeType).toBe(
      'audio/mpeg',
    );
  });

  it('test_api_error_yields_error_response', async () => {
    const apiError = Object.assign(new Error('boom'), {code: 13});
    const llm = new CloudTtsLlm({
      model: 'cloud_tts',
      client: {synthesizeSpeech: vi.fn().mockRejectedValue(apiError)},
    });

    const responses = await collect(
      llm.generateContentAsync(textRequest('hi')),
    );

    expect(responses).toHaveLength(1);
    expect(responses[0].errorCode).toBe('TTS_SYNTHESIS_FAILED');
    expect(responses[0].errorMessage).toContain('boom');
    expect(responses[0].content).toBeUndefined();
  });

  it('test_unsupported_encoding_raises', async () => {
    const client = fakeClient(AUDIO_BYTES);
    const llm = new CloudTtsLlm({
      model: 'cloud_tts',
      audioEncoding: 'BADENC',
      client,
    });

    await expect(
      collect(llm.generateContentAsync(textRequest('hi'))),
    ).rejects.toThrow(/Unsupported audioEncoding/);
    expect(client.synthesizeSpeech).not.toHaveBeenCalled();
  });
});
