/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterAll, beforeAll, describe, expect, it} from 'vitest';
import {
  SCRUBBED_ENV_PREFIXES,
  SCRUBBED_ENV_VARS,
} from '../../tests/unit_setup.js';

describe('unit:core test environment', () => {
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

  it('does not empty the environment', () => {
    expect(Object.keys(process.env).length).toBeGreaterThan(0);
  });

  /**
   * Pins the module-scope design: the scrub runs once, before the test file is
   * imported. Converting it to a top-level `beforeEach` would delete this value
   * between the `beforeAll` and the assertion -- and would break
   * `core/test/models/apigee_llm_test.ts`, which sets three of the scrubbed
   * variables in its own `beforeAll`.
   */
  describe('a value set by the test file', () => {
    beforeAll(() => {
      process.env.GOOGLE_CLOUD_PROJECT = 'explicit-project';
    });

    afterAll(() => {
      delete process.env.GOOGLE_CLOUD_PROJECT;
    });

    it('survives the scrub', () => {
      expect(process.env.GOOGLE_CLOUD_PROJECT).toBe('explicit-project');
    });
  });
});
