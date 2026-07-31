/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Gemini, LlmRequest} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const EXPRESS_MODE_API_KEY = 'test-express-mode-key';

const VERTEX_ENV_VARS = [
  'GOOGLE_GENAI_USE_VERTEXAI',
  'GOOGLE_CLOUD_PROJECT',
  'GOOGLE_CLOUD_LOCATION',
  'GOOGLE_API_KEY',
  'GOOGLE_GENAI_API_KEY',
  'GEMINI_API_KEY',
];

function buildRequest(): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text: 'hi'}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/**
 * Exercises Vertex AI Express Mode against the real `@google/genai` client with
 * only the network stubbed, so the assertions cover what ADK actually puts on
 * the wire rather than the options it hands to a mocked constructor.
 */
describe('Gemini Vertex AI Express Mode', () => {
  const clearEnv = () => {
    for (const envVar of VERTEX_ENV_VARS) {
      delete process.env[envVar];
    }
  };

  beforeEach(clearEnv);
  afterEach(() => {
    clearEnv();
    vi.restoreAllMocks();
  });

  function stubFetch() {
    return vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({candidates: []}), {status: 200}),
      );
  }

  /**
   * Drives one model call and returns the headers of the resulting request,
   * asserting on the way that the URL carries no project path segment.
   */
  async function sendOneRequest(llm: Gemini): Promise<Headers> {
    const fetchSpy = stubFetch();
    await llm.generateContentAsync(buildRequest()).next();

    const lastCall = fetchSpy.mock.lastCall;
    if (!lastCall) {
      expect.fail('the model never issued an HTTP request');
    }
    const [url, init] = lastCall;
    expect(String(url)).not.toContain('/projects/');
    if (!init) {
      expect.fail('the model issued a request without any options');
    }
    return new Headers(init.headers);
  }

  it('sends an explicitly configured express key as x-goog-api-key', async () => {
    const llm = new Gemini({
      model: 'gemini-2.5-flash',
      vertexai: true,
      apiKey: EXPRESS_MODE_API_KEY,
    });

    const headers = await sendOneRequest(llm);

    expect(headers.get('x-goog-api-key')).toBe(EXPRESS_MODE_API_KEY);
  });

  it('sends GOOGLE_API_KEY even when an ambient project and location are set', async () => {
    process.env['GOOGLE_GENAI_USE_VERTEXAI'] = '1';
    process.env['GOOGLE_CLOUD_PROJECT'] = 'test-project';
    process.env['GOOGLE_CLOUD_LOCATION'] = 'us-central1';
    process.env['GOOGLE_API_KEY'] = EXPRESS_MODE_API_KEY;

    const llm = new Gemini({model: 'gemini-2.5-flash'});

    const headers = await sendOneRequest(llm);

    expect(headers.get('x-goog-api-key')).toBe(EXPRESS_MODE_API_KEY);
  });
});
