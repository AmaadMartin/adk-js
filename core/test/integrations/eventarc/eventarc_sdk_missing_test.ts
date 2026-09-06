/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What the tool reports when the optional peer dependency is not installed.
 *
 * adk-python covers this as `test_publish_message_missing_library` in
 * `tests/unittests/integrations/eventarc/test_message_tool.py`.
 *
 * The package cannot be made to look uninstalled by throwing from a
 * `vi.mock` factory: Vitest wraps that error and drops the `code` the loader
 * keys on. The real loader is called instead, with a thunk that rejects the
 * way Node does, so the message under test is the one shipped in
 * `optional_peer.ts`.
 */

import {EventarcPublishStatus, publishMessage} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

const {ModuleNotFoundError} = vi.hoisted(() => {
  /** Node's error for a package that cannot be resolved. */
  class ModuleNotFoundError extends Error {
    readonly code = 'ERR_MODULE_NOT_FOUND';
  }
  return {ModuleNotFoundError};
});

vi.mock('../../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/utils/optional_peer.js')
    >();
  return {
    ...actual,
    loadOptionalPeer: (
      peer: import('../../../src/utils/optional_peer.js').OptionalPeer,
    ) =>
      actual.loadOptionalPeer(peer, () =>
        Promise.reject(
          new ModuleNotFoundError(`Cannot find package '${peer.packageName}'`),
        ),
      ),
  };
});

describe('publishMessage without the publishing SDK', () => {
  it('test_publish_message_missing_library', async () => {
    const res = await publishMessage({
      bus: 'bus',
      type: 'type',
      source: 'source',
    });

    if (res.status !== EventarcPublishStatus.ERROR) {
      expect.fail('expected the missing package to fail the publish');
    }
    expect(res.error_details).toContain('is not installed');
  });

  it('names the package and the install command', async () => {
    const res = await publishMessage({
      bus: 'bus',
      type: 'type',
      source: 'source',
    });

    if (res.status !== EventarcPublishStatus.ERROR) {
      expect.fail('expected the missing package to fail the publish');
    }
    expect(res.error_details).toContain('EventarcToolset requires');
    expect(res.error_details).toContain(
      'npm install @google-cloud/eventarc-publishing',
    );
  });
});
