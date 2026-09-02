/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {afterEach, describe, expect, it} from 'vitest';
import {isEnvEnabled} from '../../src/utils/env_utils.js';

const FLAG = 'ADK_TEST_ENV_UTILS_FLAG';

describe('isEnvEnabled', () => {
  afterEach(() => {
    delete process.env[FLAG];
  });

  it.each(['true', 'TRUE', 'True', '1'])('reads %s as enabled', (value) => {
    process.env[FLAG] = value;

    expect(isEnvEnabled(FLAG)).toBe(true);
  });

  it.each(['false', 'FALSE', '0', '', 'yes', 'on'])(
    'reads %s as disabled',
    (value) => {
      process.env[FLAG] = value;

      expect(isEnvEnabled(FLAG)).toBe(false);
    },
  );

  it('is disabled when the variable is unset', () => {
    expect(isEnvEnabled(FLAG)).toBe(false);
  });

  it('falls back to the default when the variable is unset', () => {
    expect(isEnvEnabled(FLAG, '1')).toBe(true);
  });

  it('prefers the variable over the default', () => {
    process.env[FLAG] = '0';

    expect(isEnvEnabled(FLAG, '1')).toBe(false);
  });
});
