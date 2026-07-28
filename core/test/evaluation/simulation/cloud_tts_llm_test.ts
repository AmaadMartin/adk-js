/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {CloudTtsLlm, LlmResponse} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

// extractText / extractVoiceConfig port adk-python private staticmethods and
// are intentionally not part of the public API; import them directly.
import {
  extractText,
  extractVoiceConfig,
} from '../../../src/evaluation/simulation/cloud_tts_llm.js';

/** Builds an LlmRequest whose single Content carries the given text parts. */
function textRequest(...texts: string[]) {
  return {
    contents: [{role: 'user', parts: texts.map((t) => ({text: t}))}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** A fake Cloud TTS client whose `synthesizeSpeech` is a mock. */
interface FakeTtsClient {
  synthesizeSpeech: ReturnType<typeof vi.fn>;
}

/** Injects a fake TTS client, bypassing the lazy dynamic import. */
function withClient(llm: CloudTtsLlm, client: FakeTtsClient): CloudTtsLlm {
  (llm as unknown as {ttsClient: FakeTtsClient}).ttsClient = client;
  return llm;
}

/** Collects every response yielded by an LlmResponse async generator. */
async function collect(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of generator) {
    responses.push(response);
  }
  return responses;
}

describe('CloudTtsLlm', () => {
  describe('fields and metadata', () => {
    it('carries the documented default fields', () => {
      const llm = new CloudTtsLlm({model: 'cloud_tts'});
      expect(llm.audioEncoding).toBe('LINEAR16');
      expect(llm.speakingSpeed).toBe(1.0);
      expect(llm.pitch).toBe(0.0);
    });

    it('advertises the cloud_tts registry key', () => {
      expect(CloudTtsLlm.supportedModels).toEqual(['cloud_tts']);
    });

    it('accepts explicit TTS parameters', () => {
      const llm = new CloudTtsLlm({
        model: 'cloud_tts',
        audioEncoding: 'MP3',
        speakingSpeed: 2.0,
        pitch: 3.5,
      });
      expect(llm.audioEncoding).toBe('MP3');
      expect(llm.speakingSpeed).toBe(2.0);
      expect(llm.pitch).toBe(3.5);
    });
  });

  describe('extractText', () => {
    it('joins text parts with spaces', () => {
      expect(extractText(textRequest('Hello', 'world'))).toBe('Hello world');
    });

    it('ignores non-text parts', () => {
      const request = {
        contents: [
          {
            role: 'user',
            parts: [
              {text: 'say this'},
              {inlineData: {mimeType: 'audio/pcm', data: 'eA=='}},
            ],
          },
        ],
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(extractText(request)).toBe('say this');
    });

    it('throws when there is no text', () => {
      const request = {
        contents: [{role: 'user', parts: []}],
        liveConnectConfig: {},
        toolsDict: {},
      };
      expect(() => extractText(request)).toThrow(
        'requires text in LlmRequest.contents',
      );
    });
  });

  describe('extractVoiceConfig', () => {
    it('returns the documented defaults without speech config', () => {
      const {voiceName, languageCode} = extractVoiceConfig(textRequest('hi'));
      expect(voiceName).toBe('en-US-Studio-O');
      expect(languageCode).toBe('en-US');
    });

    it('reads voice name and language code from speech config', () => {
      const request = {
        contents: [{role: 'user', parts: [{text: 'bonjour'}]}],
        config: {
          speechConfig: {
            languageCode: 'fr-FR',
            voiceConfig: {prebuiltVoiceConfig: {voiceName: 'fr-FR-Neural2-A'}},
          },
        },
        liveConnectConfig: {},
        toolsDict: {},
      };
      const {voiceName, languageCode} = extractVoiceConfig(request);
      expect(voiceName).toBe('fr-FR-Neural2-A');
      expect(languageCode).toBe('fr-FR');
    });

    it('falls back to defaults for an empty speech config', () => {
      const request = {
        contents: [{role: 'user', parts: [{text: 'hi'}]}],
        config: {speechConfig: {}},
        liveConnectConfig: {},
        toolsDict: {},
      };
      const {voiceName, languageCode} = extractVoiceConfig(request);
      expect(voiceName).toBe('en-US-Studio-O');
      expect(languageCode).toBe('en-US');
    });

    it('falls back to the default voice when no prebuilt voice is set', () => {
      const request = {
        contents: [{role: 'user', parts: [{text: 'hi'}]}],
        config: {speechConfig: {languageCode: 'de-DE', voiceConfig: {}}},
        liveConnectConfig: {},
        toolsDict: {},
      };
      const {voiceName, languageCode} = extractVoiceConfig(request);
      expect(voiceName).toBe('en-US-Studio-O');
      expect(languageCode).toBe('de-DE');
    });
  });

  describe('generateContentAsync', () => {
    it('yields a single response carrying the synthesized audio', async () => {
      const llm = new CloudTtsLlm({model: 'cloud_tts'});
      const client: FakeTtsClient = {
        synthesizeSpeech: vi
          .fn()
          .mockResolvedValue([{audioContent: Buffer.from('AUDIO_BYTES')}]),
      };
      withClient(llm, client);

      const responses = await collect(
        llm.generateContentAsync(textRequest('hello')),
      );

      expect(responses).toHaveLength(1);
      const part = responses[0].content?.parts?.[0];
      expect(Buffer.from(part?.inlineData?.data ?? '', 'base64')).toEqual(
        Buffer.from('AUDIO_BYTES'),
      );
      // LINEAR16 (default) maps to audio/l16.
      expect(part?.inlineData?.mimeType).toBe('audio/l16');
      expect(client.synthesizeSpeech).toHaveBeenCalledTimes(1);
    });

    it('maps the MP3 encoding to audio/mpeg', async () => {
      const llm = new CloudTtsLlm({model: 'cloud_tts', audioEncoding: 'MP3'});
      withClient(llm, {
        synthesizeSpeech: vi
          .fn()
          .mockResolvedValue([{audioContent: Buffer.from('MP3DATA')}]),
      });

      const responses = await collect(
        llm.generateContentAsync(textRequest('hi')),
      );

      expect(responses[0].content?.parts?.[0].inlineData?.mimeType).toBe(
        'audio/mpeg',
      );
    });

    it('yields an error response when the API call fails', async () => {
      const llm = new CloudTtsLlm({model: 'cloud_tts'});
      withClient(llm, {
        synthesizeSpeech: vi.fn().mockRejectedValue(new Error('boom')),
      });

      const responses = await collect(
        llm.generateContentAsync(textRequest('hi')),
      );

      expect(responses).toHaveLength(1);
      expect(responses[0].errorCode).toBe('TTS_SYNTHESIS_FAILED');
      expect(responses[0].errorMessage).toContain('boom');
      expect(responses[0].content).toBeUndefined();
    });

    it('throws for an unsupported encoding before any API call', async () => {
      const llm = new CloudTtsLlm({
        model: 'cloud_tts',
        audioEncoding: 'BADENC',
      });
      const client: FakeTtsClient = {synthesizeSpeech: vi.fn()};
      withClient(llm, client);

      await expect(
        collect(llm.generateContentAsync(textRequest('hi'))),
      ).rejects.toThrow('Unsupported audio_encoding');
      expect(client.synthesizeSpeech).not.toHaveBeenCalled();
    });

    it('throws a helpful error when the optional package is missing', async () => {
      // No client is injected, so the lazy dynamic import runs. The optional
      // `@google-cloud/text-to-speech` package is not installed in dev/CI, so
      // the import genuinely fails -- exercising the missing-dependency path.
      const llm = new CloudTtsLlm({model: 'cloud_tts'});
      await expect(
        collect(llm.generateContentAsync(textRequest('hi'))),
      ).rejects.toThrow('@google-cloud/text-to-speech');
    });
  });

  describe('connect', () => {
    it('rejects because live connections are unsupported', async () => {
      const llm = new CloudTtsLlm({model: 'cloud_tts'});
      await expect(llm.connect(textRequest('hi'))).rejects.toThrow(
        'does not support live connections',
      );
    });
  });
});
