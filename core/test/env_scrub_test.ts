/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Covers `tests/env_scrub.ts` and proves `tests/unit_setup.ts` is wired into
 * the `unit:core` Vitest project.
 *
 * `setupFiles` and `unstubEnvs` are per-project options, so each unit project
 * needs its own wiring proof; `dev/test/env_scrub_test.ts` is the one for
 * `unit:dev`. The logic tests live here only.
 *
 * Import `tests/env_scrub.ts`, never `tests/unit_setup.ts`: the setup file
 * scrubs on import, which would leave the wiring tests below green even with
 * the project misconfigured.
 */

import {FeatureName} from '@google/adk';
import {afterAll, beforeAll, describe, expect, it, vi} from 'vitest';
import {
  EnvVars,
  SCRUBBED_ENV_PREFIX,
  SCRUBBED_ENV_VARS,
  scrubEnv,
} from '../../tests/env_scrub.js';

/** A variable this file sets itself, taken from the scrubbed list. */
const FILE_OWNED_VAR = 'APIGEE_PROXY_URL';

/** Probe name for the `unstubEnvs` pair below. */
const STUB_PROBE_VAR = 'ADK_TEST_ENV_HERMETICITY_PROBE';

describe('scrubEnv', () => {
  it('deletes every listed variable', () => {
    const env: EnvVars = {};
    for (const name of SCRUBBED_ENV_VARS) {
      env[name] = 'leaked';
    }

    scrubEnv(env);

    expect(Object.keys(env)).toEqual([]);
  });

  it('deletes a variable built from a prefix', () => {
    const env: EnvVars = {
      [`ADK_ENABLE_${FeatureName.PROGRESSIVE_SSE_STREAMING}`]: 'true',
      ADK_CAPTURE_MESSAGE_CONTENT_IN_SPANS: 'false',
    };

    scrubEnv(env);

    expect(Object.keys(env)).toEqual([]);
  });

  it('keeps a variable ADK does not read', () => {
    const env: EnvVars = {
      PATH: '/usr/bin',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json',
      MY_ADK_THING: 'kept',
    };

    scrubEnv(env);

    expect(env).toEqual({
      PATH: '/usr/bin',
      GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json',
      MY_ADK_THING: 'kept',
    });
  });

  it('accepts an empty environment', () => {
    const env: EnvVars = {};

    expect(() => scrubEnv(env)).not.toThrow();
    expect(env).toEqual({});
  });
});

describe('unit:core worker environment', () => {
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
  // this test passes only because the runner unstubs before it. Setting
  // `unstubEnvs` at the root of vitest.config.ts instead of per project leaves
  // this test failing, because projects inherit nothing from the root.
  it('drops the stub before the next test', () => {
    expect(process.env[STUB_PROBE_VAR]).toBeUndefined();
  });
});

// Declared last so the assignment cannot reach the worker-environment tests
// above.
describe('a variable the test file owns', () => {
  beforeAll(() => {
    process.env[FILE_OWNED_VAR] = 'set-by-this-file';
  });

  afterAll(() => {
    delete process.env[FILE_OWNED_VAR];
  });

  // The scrub runs at module scope, not in a `beforeEach`, so a value the file
  // assigns for itself survives.
  it('survives into the test body', () => {
    expect(process.env[FILE_OWNED_VAR]).toBe('set-by-this-file');
  });
});
