/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  DISABLE_LOAD_DOTENV_ENV_VAR,
  isEnvEnabled,
  loadDotenvFromCwd,
} from '../../src/utils/env_utils.js';

vi.mock('dotenv', () => ({default: {config: vi.fn()}}));

const FLAG = 'ADK_TEST_FLAG';

describe('isEnvEnabled', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['1', 'true', 'TRUE', 'True', ' 1 '])('reads %s as on', (value) => {
    vi.stubEnv(FLAG, value);

    expect(isEnvEnabled(FLAG)).toBe(true);
  });

  it.each(['0', 'false', '', 'yes', 'on'])('reads %s as off', (value) => {
    vi.stubEnv(FLAG, value);

    expect(isEnvEnabled(FLAG)).toBe(false);
  });

  it('reads an unset variable as off', () => {
    expect(isEnvEnabled('ADK_TEST_FLAG_NEVER_SET')).toBe(false);
  });
});

describe('loadDotenvFromCwd', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('reads the .env file when the gate is unset', () => {
    loadDotenvFromCwd();

    expect(dotenv.config).toHaveBeenCalledWith({quiet: true});
  });

  it.each(['1', 'true', 'TRUE'])(
    'reads no file when %s disables it',
    (value) => {
      vi.stubEnv(DISABLE_LOAD_DOTENV_ENV_VAR, value);

      loadDotenvFromCwd();

      expect(dotenv.config).not.toHaveBeenCalled();
    },
  );

  it('reads the .env file when the gate is set to something else', () => {
    vi.stubEnv(DISABLE_LOAD_DOTENV_ENV_VAR, 'no');

    loadDotenvFromCwd();

    expect(dotenv.config).toHaveBeenCalledWith({quiet: true});
  });
});
