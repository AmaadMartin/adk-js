/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {LlmResponse} from '@google/adk';
import {CloudTtsLlm} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

// The lazy client-construction path requires the optional Cloud TTS SDK to
// import successfully, so this file mocks it. (The genuine "package missing"
// path is covered separately in cloud_tts_llm_test.ts, which does not mock it.)
const {synthesizeSpeech, TextToSpeechClient} = vi.hoisted(() => {
  const synthesizeSpeech = vi.fn();
  const TextToSpeechClient = vi.fn(() => ({synthesizeSpeech}));
  return {synthesizeSpeech, TextToSpeechClient};
});

vi.mock('@google-cloud/text-to-speech', () => ({TextToSpeechClient}));

function textRequest(text: string) {
  return {
    contents: [{role: 'user', parts: [{text}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

async function collect(
  generator: AsyncGenerator<LlmResponse, void>,
): Promise<LlmResponse[]> {
  const responses: LlmResponse[] = [];
  for await (const response of generator) {
    responses.push(response);
  }
  return responses;
}

describe('CloudTtsLlm lazy client construction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    synthesizeSpeech.mockResolvedValue([{audioContent: Buffer.from('LAZY')}]);
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  afterEach(() => {
    delete process.env.GOOGLE_CLOUD_PROJECT;
  });

  it('lazily imports the SDK and synthesizes without a quota project', async () => {
    const llm = new CloudTtsLlm({model: 'cloud_tts'});

    const responses = await collect(
      llm.generateContentAsync(textRequest('hi')),
    );

    expect(TextToSpeechClient).toHaveBeenCalledTimes(1);
    expect(TextToSpeechClient).toHaveBeenCalledWith();
    expect(
      Buffer.from(
        responses[0].content?.parts?.[0].inlineData?.data ?? '',
        'base64',
      ),
    ).toEqual(Buffer.from('LAZY'));
  });

  it('passes the quota project from GOOGLE_CLOUD_PROJECT', async () => {
    process.env.GOOGLE_CLOUD_PROJECT = 'my-project';
    const llm = new CloudTtsLlm({model: 'cloud_tts'});

    await collect(llm.generateContentAsync(textRequest('hi')));

    expect(TextToSpeechClient).toHaveBeenCalledWith({projectId: 'my-project'});
  });
});
