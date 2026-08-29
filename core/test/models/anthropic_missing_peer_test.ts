/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Claude, LlmRequest, LlmResponse} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

/**
 * `vi.mock` cannot simulate an unresolvable package: vitest replaces whatever
 * a factory throws with its own "error when mocking a module" report, so a
 * real `ERR_MODULE_NOT_FOUND` never reaches the importer. The loader is
 * stubbed instead. `core/test/utils/optional_peer_test.ts` pins the message
 * the real loader builds from the descriptor asserted here.
 */
const {loadOptionalPeer} = vi.hoisted(() => ({loadOptionalPeer: vi.fn()}));

vi.mock('../../src/utils/optional_peer.js', () => ({loadOptionalPeer}));

function makeRequest(): LlmRequest {
  return {
    model: 'claude-3-5-sonnet-v2@20241022',
    contents: [{role: 'user', parts: [{text: 'Hi'}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

async function generate(llm: Claude): Promise<LlmResponse[]> {
  const collected: LlmResponse[] = [];
  for await (const response of llm.generateContentAsync(makeRequest(), false)) {
    collected.push(response);
  }
  return collected;
}

describe('Claude without its optional peer installed', () => {
  beforeEach(() => {
    vi.stubEnv('GOOGLE_CLOUD_PROJECT', 'test-project');
    vi.stubEnv('GOOGLE_CLOUD_LOCATION', 'test-location');
    loadOptionalPeer.mockReset();
  });

  it('constructs, because the package loads on first use', () => {
    loadOptionalPeer.mockRejectedValue(new Error('not installed'));

    expect(() => new Claude()).not.toThrow();
    expect(loadOptionalPeer).not.toHaveBeenCalled();
  });

  it('asks the loader for the Vertex SDK on behalf of Claude', async () => {
    loadOptionalPeer.mockRejectedValue(new Error('not installed'));

    await generate(new Claude()).catch(() => undefined);

    expect(loadOptionalPeer).toHaveBeenCalledOnce();
    expect(loadOptionalPeer.mock.calls[0][0]).toEqual({
      packageName: '@anthropic-ai/vertex-sdk',
      feature: 'Claude',
    });
  });

  it('propagates the loader error unchanged', async () => {
    const notInstalled = new Error(
      'Claude requires the optional peer dependency ' +
        '"@anthropic-ai/vertex-sdk", which is not installed. Install it ' +
        'with:\n\n  npm install @anthropic-ai/vertex-sdk\n',
    );
    loadOptionalPeer.mockRejectedValue(notInstalled);

    const failure = await generate(new Claude()).catch(
      (error: unknown) => error,
    );

    expect(failure).toBe(notInstalled);
  });
});
