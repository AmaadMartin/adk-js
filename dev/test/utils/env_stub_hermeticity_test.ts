/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it, vi} from 'vitest';

const PROBE_ENV_VAR = 'ADK_TEST_ENV_HERMETICITY_PROBE';
const PROBE_GLOBAL = '__adkHermeticityProbe';

/**
 * Pins `unstubEnvs` / `unstubGlobals` for the `unit:dev` vitest project.
 *
 * Vitest projects inherit nothing from the root-level config, so the flags have
 * to be set inside every project's own `test` block. These two tests are
 * deliberately order-dependent: the first installs the stubs, the second proves
 * the runner removed them before it started. Setting the flags at the root of
 * `vitest.config.ts` instead of per project leaves the second test failing.
 */
describe('env and global stub hermeticity', () => {
  it('applies stubs installed by this test', () => {
    vi.stubEnv(PROBE_ENV_VAR, 'stubbed');
    vi.stubGlobal(PROBE_GLOBAL, 'stubbed');

    expect(process.env[PROBE_ENV_VAR]).toBe('stubbed');
    expect(PROBE_GLOBAL in globalThis).toBe(true);
  });

  it('does not inherit stubs from the previous test', () => {
    expect(process.env[PROBE_ENV_VAR]).toBeUndefined();
    expect(PROBE_GLOBAL in globalThis).toBe(false);
  });
});
