/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from adk-python
 * `tests/unittests/evaluation/simulation/test_cloud_tts_llm.py` at `main`,
 * commit `a119dd77`.
 *
 * This is the 12th reference test. It lives in its own file because it
 * installs a module mock, which vitest applies to the whole file.
 *
 * The mock replaces `optional_peer.js`, not the SDK: vitest replaces a
 * throwing module factory with an error of its own, which carries no
 * `ERR_MODULE_NOT_FOUND` code, so the real classification would never fire.
 */

import {CloudTtsLlm, LlmRequest} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

vi.mock('../../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/utils/optional_peer.js')
    >();
  const loadOptionalPeer: typeof actual.loadOptionalPeer = (peer) =>
    actual.loadOptionalPeer(peer, () => {
      const error = new Error(`Cannot find package '${peer.packageName}'`);
      Object.assign(error, {code: 'ERR_MODULE_NOT_FOUND'});
      return Promise.reject(error);
    });
  return {...actual, loadOptionalPeer};
});

/** Builds an LlmRequest whose single Content carries one text part. */
function textRequest(text: string): LlmRequest {
  return {
    contents: [{role: 'user', parts: [{text}]}],
    liveConnectConfig: {},
    toolsDict: {},
  };
}

/** Drains an async generator, discarding what it yields. */
async function drain(gen: AsyncGenerator<unknown, void>): Promise<void> {
  for await (const _ of gen) {
    // The generator is expected to reject before yielding anything.
  }
}

describe('CloudTtsLlm without @google-cloud/text-to-speech', () => {
  it('test_missing_texttospeech_raises_helpful_error', async () => {
    const llm = new CloudTtsLlm({model: 'cloud_tts'});

    const promise = drain(llm.generateContentAsync(textRequest('hi')));

    await expect(promise).rejects.toThrow(/CloudTtsLlm .* requires/);
    await expect(promise).rejects.toThrow(
      /npm install @google-cloud\/text-to-speech/,
    );
  });
});
