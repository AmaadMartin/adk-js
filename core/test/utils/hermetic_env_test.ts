/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  AMBIENT_CLOUD_ENV_VARS,
  scrubAmbientCloudEnv,
} from '../../../tests/hermetic_env.js';

describe('scrubAmbientCloudEnv', () => {
  it('removes every ambient cloud variable and keeps the rest', () => {
    const env: Record<string, string | undefined> = {PATH: '/usr/bin'};
    for (const name of AMBIENT_CLOUD_ENV_VARS) {
      env[name] = `ambient-${name}`;
    }

    scrubAmbientCloudEnv(env);

    expect(env).toEqual({PATH: '/usr/bin'});
  });
});

/**
 * Pins the `setupFiles` wiring in `vitest.config.ts`. Importing
 * `hermetic_env.js` above has no side effects, so this only passes when the
 * setup file really ran in this worker.
 *
 * Vacuous on a CI runner by construction -- GitHub Actions exports none of
 * these -- and the assertion that fires on a developer machine.
 */
describe('unit test worker environment', () => {
  it('has no ambient cloud variables', () => {
    for (const name of AMBIENT_CLOUD_ENV_VARS) {
      expect(process.env[name]).toBeUndefined();
    }
  });
});
