/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {DaytonaEnvironment} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

/**
 * Simulates `@daytona/sdk` not being installed. It lives in its own file
 * because the mock applies to the whole module graph, which the main suite
 * needs a working module for.
 */
vi.mock('@daytona/sdk', () => {
  throw new Error("Cannot find package '@daytona/sdk'");
});

describe('DaytonaEnvironment without the @daytona/sdk package', () => {
  it('fails to initialize with an actionable message', async () => {
    const env = new DaytonaEnvironment();

    const rejection = await env.initialize().catch((error: unknown) => error);

    expect(rejection).toMatchObject({
      message:
        'The @daytona/sdk package is required to use DaytonaEnvironment.' +
        ' Install it with `npm install @daytona/sdk`.',
      // The module resolution failure stays attached for diagnosis.
      cause: expect.any(Error),
    });
    expect(env.isInitialized).toBe(false);
  });
});
