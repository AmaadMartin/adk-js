/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {E2BEnvironment} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

/**
 * Simulates `e2b` not being installed. It lives in its own file because the
 * mock has to be in place for the whole module graph, which the main suite
 * needs the real module for.
 */
vi.mock('e2b', () => {
  throw new Error("Cannot find package 'e2b'");
});

describe('E2BEnvironment without the e2b package', () => {
  it('fails to initialize with an actionable message', async () => {
    const env = new E2BEnvironment();

    const rejection = await env.initialize().catch((e: unknown) => e);

    expect(rejection).toMatchObject({
      message:
        'The `e2b` package is required to use E2BEnvironment. Install it with' +
        ' `npm install e2b`.',
      // The module resolution failure stays attached for diagnosis.
      cause: expect.any(Error),
    });
    expect(env.isInitialized).toBe(false);
  });
});
