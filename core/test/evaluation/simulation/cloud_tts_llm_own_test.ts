/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for `CloudTtsLlm` behaviour the adk-python reference suite
 * (`tests/unittests/evaluation/simulation/test_cloud_tts_llm.py`) does not
 * cover: registry resolution, the request the client is handed, the REST
 * base64 payload, and the error paths that must not become an error response.
 */

import {CloudTtsLlm, LLMRegistry, LlmRequest, LlmResponse} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {
  createCloudTtsClient,
  extractText,
  extractVoiceConfig,
} from '../../../src/evaluation/simulation/cloud_tts_llm.js';

const AUDIO_BYTES = new TextEncoder().encode('AUDIO_BYTES');

/** Builds an LlmRequest whose single Content carries one text part. */
function textRequest(text: string, config?: LlmRequest['config']): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text}]}],
    config,
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** A fake Cloud TTS client resolving with the given audio payload. */
function fakeClient(audioContent: Uint8Array | string | null) {
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

/** Returns the `audioConfig` of the request a fake client was handed. */
function audioConfigOf(client: ReturnType<typeof fakeClient>) {
  return client.synthesizeSpeech.mock.calls[0][0].audioConfig;
}

describe('CloudTtsLlm registration', () => {
  it('resolves and builds through the cloud_tts registry key', () => {
    expect(LLMRegistry.resolve('cloud_tts')).toBe(CloudTtsLlm);
    expect(LLMRegistry.newLlm('cloud_tts')).toBeInstanceOf(CloudTtsLlm);
  });
});

describe('CloudTtsLlm audio options', () => {
  it('omits speakingRate and pitch when both are null', async () => {
    const client = fakeClient(AUDIO_BYTES);
    const llm = new CloudTtsLlm({speakingSpeed: null, pitch: null, client});

    await collect(llm.generateContentAsync(textRequest('hi')));

    expect(audioConfigOf(client)).toEqual({audioEncoding: 'LINEAR16'});
  });

  it('forwards a non-null speakingSpeed and pitch', async () => {
    const client = fakeClient(AUDIO_BYTES);
    const llm = new CloudTtsLlm({speakingSpeed: 1.25, pitch: -3.5, client});

    await collect(llm.generateContentAsync(textRequest('hi')));

    expect(audioConfigOf(client)).toEqual({
      audioEncoding: 'LINEAR16',
      speakingRate: 1.25,
      pitch: -3.5,
    });
  });

  it('decodes a base64 string payload as base64, not as UTF-8', async () => {
    const base64 = Buffer.from(AUDIO_BYTES).toString('base64');
    const llm = new CloudTtsLlm({client: fakeClient(base64)});

    const responses = await collect(
      llm.generateContentAsync(textRequest('hi')),
    );

    expect(responses[0].content?.parts?.[0]?.inlineData?.data).toBe(base64);
  });
});

describe('CloudTtsLlm error paths', () => {
  it('throws when a successful response carries no audio', async () => {
    const llm = new CloudTtsLlm({client: fakeClient(null)});

    await expect(
      collect(llm.generateContentAsync(textRequest('hi'))),
    ).rejects.toThrow('Cloud TTS returned no audio content.');
  });

  it('propagates an error that is not a Cloud TTS API error', async () => {
    const bug = new TypeError('not a function');
    const llm = new CloudTtsLlm({
      client: {synthesizeSpeech: vi.fn().mockRejectedValue(bug)},
    });

    await expect(
      collect(llm.generateContentAsync(textRequest('hi'))),
    ).rejects.toBe(bug);
  });

  it('rejects connect with a live-connection error', async () => {
    const llm = new CloudTtsLlm();

    await expect(llm.connect(textRequest('hi'))).rejects.toThrow(
      'Live connection is not supported for cloud_tts.',
    );
  });
});

describe('extractText', () => {
  it('skips a content that carries no parts at all', () => {
    const request: LlmRequest = {
      contents: [{role: 'user'}, {role: 'user', parts: [{text: 'only this'}]}],
      liveConnectConfig: {},
      toolsDict: {},
    };

    expect(extractText(request)).toBe('only this');
  });
});

describe('extractVoiceConfig', () => {
  it('returns the defaults for the plain-string speechConfig shorthand', () => {
    const request = textRequest('hi', {speechConfig: 'en-US-Studio-O'});

    expect(extractVoiceConfig(request)).toEqual({
      voiceName: 'en-US-Studio-O',
      languageCode: 'en-US',
    });
  });

  it('keeps the default voice when only languageCode is set', () => {
    const request = textRequest('hi', {speechConfig: {languageCode: 'de-DE'}});

    expect(extractVoiceConfig(request)).toEqual({
      voiceName: 'en-US-Studio-O',
      languageCode: 'de-DE',
    });
  });

  it('keeps the default languageCode when only the voice is set', () => {
    const request = textRequest('hi', {
      speechConfig: {
        voiceConfig: {prebuiltVoiceConfig: {voiceName: 'en-GB-Neural2-A'}},
      },
    });

    expect(extractVoiceConfig(request)).toEqual({
      voiceName: 'en-GB-Neural2-A',
      languageCode: 'en-US',
    });
  });
});

describe('CloudTtsLlm request assembly', () => {
  it('sends the selected voice and language to the client', async () => {
    const client = fakeClient(AUDIO_BYTES);
    const llm = new CloudTtsLlm({client});

    await collect(
      llm.generateContentAsync(
        textRequest('bonjour', {
          speechConfig: {
            languageCode: 'fr-FR',
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'fr-FR-Neural2-A'}},
          },
        }),
      ),
    );

    expect(client.synthesizeSpeech.mock.calls[0][0]).toEqual({
      input: {text: 'bonjour'},
      voice: {languageCode: 'fr-FR', name: 'fr-FR-Neural2-A'},
      audioConfig: {audioEncoding: 'LINEAR16', speakingRate: 1.0, pitch: 0.0},
    });
  });

  it('reuses the injected client across two calls', async () => {
    const client = fakeClient(AUDIO_BYTES);
    const llm = new CloudTtsLlm({client});

    await collect(llm.generateContentAsync(textRequest('one')));
    await collect(llm.generateContentAsync(textRequest('two')));

    expect(client.synthesizeSpeech).toHaveBeenCalledTimes(2);
    expect(client.synthesizeSpeech.mock.calls[1][0].input).toEqual({
      text: 'two',
    });
  });
});

describe('createCloudTtsClient', () => {
  const projectEnvKey = 'GOOGLE_CLOUD_PROJECT';
  const originalProject = process.env[projectEnvKey];

  afterEach(() => {
    if (originalProject === undefined) {
      delete process.env[projectEnvKey];
    } else {
      process.env[projectEnvKey] = originalProject;
    }
  });

  it('builds a client when GOOGLE_CLOUD_PROJECT is unset', async () => {
    delete process.env[projectEnvKey];

    const client = await createCloudTtsClient();

    expect(typeof client.synthesizeSpeech).toBe('function');
  });

  it('builds a client scoped to GOOGLE_CLOUD_PROJECT when it is set', async () => {
    process.env[projectEnvKey] = 'adk-tts-test-project';

    const client = await createCloudTtsClient();

    expect(typeof client.synthesizeSpeech).toBe('function');
  });
});
