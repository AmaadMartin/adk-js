/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `vi.mock` is hoisted and file-scoped, so the platform-refuses-a-symlink case
// cannot share a file with the real-filesystem cases in
// log_to_tmp_folder_test.ts.

import {randomUUID} from 'node:crypto';
import {mkdirSync, rmSync} from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {createLatestLogLink} from '../../src/utils/log_to_tmp_folder.js';

// Only `symlinkSync` is replaced; `mkdirSync`, `rmSync` and the `lstatSync`
// the code under test calls stay real.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    symlinkSync: vi.fn(() => {
      throw Object.assign(new Error('operation not permitted'), {
        code: 'EPERM',
      });
    }),
  };
});

describe('createLatestLogLink when the platform refuses a symlink', () => {
  let logDir = '';

  beforeEach(() => {
    logDir = path.join(os.tmpdir(), `adk_test_${randomUUID()}`);
    mkdirSync(logDir, {recursive: true});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(logDir, {recursive: true, force: true});
  });

  it('returns no pointer path instead of throwing', () => {
    const logFilePath = path.join(logDir, 'agent.20260817_081102.log');

    expect(createLatestLogLink(logDir, logFilePath)).toBeUndefined();
  });

  it('emits no warning, matching the silent OSError path in adk-python', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});

    createLatestLogLink(logDir, path.join(logDir, 'agent.20260817_081102.log'));

    expect(emitWarning).not.toHaveBeenCalled();
  });
});
