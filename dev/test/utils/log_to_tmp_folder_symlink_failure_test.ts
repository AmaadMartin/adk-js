/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `vi.mock` is hoisted and file-scoped, so the platform-refuses-a-symlink case
// cannot share a file with the real-filesystem cases in
// log_to_tmp_folder_test.ts.

import {mkdtempSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logToTmpFolder} from '../../src/utils/log_to_tmp_folder.js';
import {resetFileLogTarget} from '../../src/utils/logger.js';

// Only `symlinkSync` is replaced; the `mkdirSync`, `openSync` and `lstatSync`
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

/** The environment variables `os.tmpdir()` reads, across platforms. */
const TMP_ENV_VARS = ['TMPDIR', 'TMP', 'TEMP'];

describe('logToTmpFolder when the platform refuses a symlink', () => {
  const savedEnv = new Map<string, string | undefined>();
  let tmpRoot = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'adk_log_test_'));
    for (const name of TMP_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      process.env[name] = tmpRoot;
    }
  });

  afterEach(async () => {
    await resetFileLogTarget();
    vi.restoreAllMocks();
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    savedEnv.clear();
    await fs.rm(tmpRoot, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 20,
    });
  });

  it('returns no pointer path instead of throwing', () => {
    expect(logToTmpFolder().latestLogPath).toBeUndefined();
  });

  it('emits no warning, matching the silent OSError path in adk-python', () => {
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});

    logToTmpFolder();

    expect(emitWarning).not.toHaveBeenCalled();
  });
});
