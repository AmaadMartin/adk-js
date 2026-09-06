/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pins how `AudioTranscriber` asks for its optional peer dependency.
 *
 * The imports here are source paths rather than `@google/adk` because the test
 * replaces an internal module, which only exists as its own module in the
 * source graph. `loadOptionalPeer` itself is covered by
 * `core/test/utils/optional_peer_test.ts`.
 */

import {describe, expect, it, vi} from 'vitest';
import {AudioTranscriber} from '../../src/agents/audio_transcriber.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';
import {createSession} from '../../src/sessions/session.js';
import {loadOptionalPeer} from '../../src/utils/optional_peer.js';

vi.mock('../../src/utils/optional_peer.js', () => ({
  loadOptionalPeer: vi.fn(),
}));

describe('AudioTranscriber optional peer', () => {
  it('names the package and the feature, and does not swallow the error', async () => {
    const notInstalled = new Error(
      'AudioTranscriber requires the optional peer dependency ' +
        '"@google-cloud/speech", which is not installed.',
    );
    vi.mocked(loadOptionalPeer).mockRejectedValue(notInstalled);
    const invocationContext = new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager([]),
      transcriptionCache: [
        {
          role: 'user',
          data: {
            mimeType: 'audio/pcm',
            data: Buffer.from('aa').toString('base64'),
          },
        },
      ],
    });

    await expect(
      new AudioTranscriber().transcribeFile(invocationContext),
    ).rejects.toBe(notInstalled);
    expect(vi.mocked(loadOptionalPeer)).toHaveBeenCalledWith(
      {packageName: '@google-cloud/speech', feature: 'AudioTranscriber'},
      expect.any(Function),
    );
  });
});
