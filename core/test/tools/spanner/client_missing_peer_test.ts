/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a developer sees when `@google-cloud/spanner-api` is not installed.
 *
 * Mocking `@google-cloud/spanner-api` itself cannot produce this: Vitest replaces
 * a failing module factory with its own error, which carries no
 * `ERR_MODULE_NOT_FOUND` code. So the real `loadOptionalPeer` runs here, over
 * a loader that fails the way Node fails. This file installs a module mock, so
 * it stays separate from the other Spanner tests.
 */

import {googleAuthLibrary} from 'google-gax';
import {describe, expect, it, vi} from 'vitest';
import {
  createTokenAuthClient,
  withSpannerAdminClients,
} from '../../../src/tools/spanner/client.js';

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

describe('the Spanner client module without its peer dependencies', () => {
  it('names @google-cloud/spanner-api and the install command', async () => {
    const promise = withSpannerAdminClients(
      // Never read: the peer fails to load before the clients are built.
      new googleAuthLibrary.OAuth2Client(),
      async () => undefined,
    );

    await expect(promise).rejects.toThrow(/SpannerAdminToolset requires/);
    await expect(promise).rejects.toThrow(
      /npm install @google-cloud\/spanner-api/,
    );
  });

  it('names google-gax and the install command', async () => {
    const promise = createTokenAuthClient({accessToken: 'test-token'});

    await expect(promise).rejects.toThrow(/SpannerAdminToolset requires/);
    await expect(promise).rejects.toThrow(/npm install google-gax/);
  });
});
