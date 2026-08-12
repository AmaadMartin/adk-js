/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Proves `tests/unit_setup.ts` and `unstubEnvs` are wired into the `unit:dev`
 * Vitest project. Both are per-project options, so `unit:dev` needs its own
 * proof. The logic tests for `scrubEnv` live in `core/test/env_scrub_test.ts`
 * and are not repeated here.
 */

import {describe, expect, it, vi} from 'vitest';
import {SCRUBBED_ENV_PREFIX, SCRUBBED_ENV_VARS} from '../../tests/env_scrub.js';

/** Probe name for the `unstubEnvs` pair below. */
const STUB_PROBE_VAR = 'ADK_TEST_ENV_HERMETICITY_PROBE';

describe('unit:dev worker environment', () => {
  it('reads no scrubbed variable', () => {
    const present = SCRUBBED_ENV_VARS.filter(
      (name) => process.env[name] !== undefined,
    );

    expect(present).toEqual([]);
  });

  it('reads no variable with a scrubbed prefix', () => {
    const present = Object.keys(process.env).filter((name) =>
      name.startsWith(SCRUBBED_ENV_PREFIX),
    );

    expect(present).toEqual([]);
  });

  it('keeps the rest of the environment', () => {
    expect(Object.keys(process.env).length).toBeGreaterThan(0);
  });
});

describe('unstubEnvs', () => {
  it('reads a value stubbed inside the test', () => {
    vi.stubEnv(STUB_PROBE_VAR, 'stubbed');

    expect(process.env[STUB_PROBE_VAR]).toBe('stubbed');
  });

  // Order-dependent on purpose: the stub above is never unstubbed by hand, so
  // this test passes only because the runner unstubs before it.
  it('drops the stub before the next test', () => {
    expect(process.env[STUB_PROBE_VAR]).toBeUndefined();
  });
});
