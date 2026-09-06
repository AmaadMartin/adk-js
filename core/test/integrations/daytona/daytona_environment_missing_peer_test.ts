/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a user sees when `@daytona/sdk` is not installed.
 *
 * The module mock is file-global, so this needs its own file. It replaces
 * `loadOptionalPeer` rather than `@daytona/sdk`: Vitest answers a failing
 * module factory with an error of its own, which carries no
 * `ERR_MODULE_NOT_FOUND` code, so mocking the SDK cannot reproduce a package
 * that is genuinely absent. The real loader still runs, over a loader that
 * fails the way Node does.
 */

import {DaytonaEnvironment} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {
  loadOptionalPeer,
  type OptionalPeer,
} from '../../../src/utils/optional_peer.js';

vi.mock('../../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../../../src/utils/optional_peer.js')
    >();
  return {
    ...actual,
    loadOptionalPeer: <T>(peer: OptionalPeer, _load: () => Promise<T>) =>
      actual.loadOptionalPeer(peer, () => {
        const error = new Error(
          `Cannot find package '${peer.packageName}' imported from /app/index.js`,
        );
        return Promise.reject(
          Object.assign(error, {code: 'ERR_MODULE_NOT_FOUND'}),
        );
      }),
  };
});

describe('DaytonaEnvironment without @daytona/sdk installed', () => {
  it('constructs, because the SDK is only loaded on initialize', () => {
    expect(() => new DaytonaEnvironment()).not.toThrow();
  });

  it('names the package and the install command on initialize', async () => {
    // Guards the mock itself: a stubbed-out loader would pass the assertions
    // below without the real translation ever running.
    expect(vi.isMockFunction(loadOptionalPeer)).toBe(false);
    const env = new DaytonaEnvironment();

    const promise = env.initialize();

    await expect(promise).rejects.toThrow(/DaytonaEnvironment requires/);
    await expect(promise).rejects.toThrow(/npm install @daytona\/sdk/);
    expect(env.isInitialized).toBe(false);
  });
});
