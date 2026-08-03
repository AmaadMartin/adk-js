/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {describe, expect, it} from 'vitest';
import {
  SCRUBBED_ENV_PREFIXES,
  SCRUBBED_ENV_VARS,
} from '../../tests/unit_setup.js';

// `setupFiles` is configured per Vitest project, so each unit project needs its
// own test to prove its own wiring.
describe('unit:integrations test environment', () => {
  it('removes every listed variable', () => {
    for (const name of SCRUBBED_ENV_VARS) {
      expect(process.env[name]).toBeUndefined();
    }
  });

  it('removes every variable in a scrubbed family', () => {
    const remaining = Object.keys(process.env).filter((name) =>
      SCRUBBED_ENV_PREFIXES.some((prefix) => name.startsWith(prefix)),
    );

    expect(remaining).toEqual([]);
  });
});
