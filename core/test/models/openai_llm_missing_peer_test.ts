/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a caller sees when the optional `openai` package is not installed.
 *
 * Only the module resolution is simulated: the mock hands the real
 * `loadOptionalPeer` a thunk that rejects the way Node does for an
 * unresolvable specifier, and everything else — the descriptor
 * `createDefaultClient` supplies, the error `loadOptionalPeer` builds, the way
 * it surfaces through `generateContentAsync` — is the production path. A
 * `vi.mock` of `openai` itself cannot do this: vitest replaces whatever a mock
 * factory throws with its own "error when mocking a module" message, so the
 * real message never reaches the assertion.
 *
 * The mock replaces the module for the whole file, hence a file of its own.
 */

import {LlmRequest, OpenAILlm} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import type {OptionalPeer} from '../../src/utils/optional_peer.js';

const requestedPeers = vi.hoisted(() => [] as OptionalPeer[]);

vi.mock('../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/optional_peer.js')>();
  return {
    ...actual,
    loadOptionalPeer: (peer: OptionalPeer) => {
      requestedPeers.push(peer);
      const notInstalled: Error & {code?: string} = new Error(
        `Cannot find package '${peer.packageName}' imported from openai_llm.ts`,
      );
      notInstalled.code = 'ERR_MODULE_NOT_FOUND';
      return actual.loadOptionalPeer(peer, () => Promise.reject(notInstalled));
    },
  };
});

const request: LlmRequest = {
  model: 'gpt-4o',
  contents: [{role: 'user', parts: [{text: 'Hello'}]}],
  liveConnectConfig: {},
  toolsDict: {},
};

describe('OpenAILlm without the openai package', () => {
  it('names the openai package, the feature and the install command', async () => {
    const llm = new OpenAILlm({model: 'gpt-4o'});

    const failure = llm.generateContentAsync(request, false).next();

    await expect(failure).rejects.toThrow(
      /OpenAILlm \(GPT models via the OpenAI API\)/,
    );
    await expect(failure).rejects.toThrow(/"openai", which is not installed/);
    await expect(failure).rejects.toThrow(/npm install openai/);
    expect(requestedPeers).toEqual([
      {
        packageName: 'openai',
        feature: 'OpenAILlm (GPT models via the OpenAI API)',
      },
    ]);
  });
});
