/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DaytonaEnvironment} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

/**
 * Runs against the real `@daytona/sdk`, with no mock, so it also proves the
 * optional dynamic import resolves. The SDK rejects missing credentials in its
 * own constructor, so no request reaches Daytona.
 */
describe('DaytonaEnvironment with the real SDK', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('propagates the SDK authentication error when no credentials are set', async () => {
    vi.stubEnv('DAYTONA_API_KEY', '');
    vi.stubEnv('DAYTONA_JWT_TOKEN', '');
    const env = new DaytonaEnvironment();

    await expect(env.initialize()).rejects.toThrow(
      'Authentication credentials not found',
    );

    expect(env.isInitialized).toBe(false);
  });
});
