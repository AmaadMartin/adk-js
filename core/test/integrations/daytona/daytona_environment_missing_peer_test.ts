/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The error `initialize()` raises when `@daytona/sdk` is not installed.
 *
 * This lives in its own file because the module mock below makes every
 * optional peer unresolvable for the whole file, which the other Daytona tests
 * need it not to be. The real `loadOptionalPeer` still runs, so the assertions
 * cover the peer descriptor the call site passes as well as the message.
 */

import {DaytonaEnvironment} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import type {OptionalPeer} from '../../../src/utils/optional_peer.js';

type OptionalPeerModule = typeof import('../../../src/utils/optional_peer.js');

vi.mock('../../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual = await importOriginal<OptionalPeerModule>();
  return {
    ...actual,
    loadOptionalPeer: (peer: OptionalPeer) =>
      actual.loadOptionalPeer(peer, () => {
        const err = new Error(
          `Cannot find package '${peer.packageName}' imported from /app/index.js`,
        ) as Error & {code?: string};
        err.code = 'ERR_MODULE_NOT_FOUND';
        throw err;
      }),
  };
});

describe('DaytonaEnvironment without @daytona/sdk installed', () => {
  it('names the feature and the install command', async () => {
    const env = new DaytonaEnvironment();

    await expect(env.initialize()).rejects.toThrow(
      /DaytonaEnvironment requires/,
    );
    await expect(env.initialize()).rejects.toThrow(/npm install @daytona\/sdk/);
    expect(env.isInitialized).toBe(false);
  });
});
