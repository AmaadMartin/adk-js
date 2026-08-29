/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `vi.mock` is hoisted and file-scoped, so this case cannot share a file with
// the real-filesystem cases in log_to_tmp_folder_test.ts.

import {mkdirSync, mkdtempSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logToTmpFolder} from '../../src/utils/log_to_tmp_folder.js';
import {setFileLogTarget} from '../../src/utils/logger.js';

// Only `unlinkSync` is replaced, so that replacing the stale pointer fails the
// way a second `adk` process racing this one makes it fail.
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    unlinkSync: vi.fn(() => {
      throw Object.assign(new Error('permission denied'), {code: 'EACCES'});
    }),
  };
});

// The real one opens a file the case does not need.
vi.mock('../../src/utils/logger.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../../src/utils/logger.js')>();
  return {...actual, setFileLogTarget: vi.fn()};
});

/** The environment variables `os.tmpdir()` reads, across platforms. */
const TMP_ENV_VARS = ['TMPDIR', 'TMP', 'TEMP'];

describe('logToTmpFolder when the latest pointer cannot be replaced', () => {
  const savedEnv = new Map<string, string | undefined>();
  let tmpRoot = '';

  beforeEach(async () => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'adk_log_test_'));
    for (const name of TMP_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      process.env[name] = tmpRoot;
    }
    const logDir = path.join(tmpRoot, 'agents_log');
    mkdirSync(logDir);
    await fs.symlink(
      path.join(logDir, 'agent.20260817_080000.log'),
      path.join(logDir, 'agent.latest.log'),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    for (const [name, value] of savedEnv) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
    savedEnv.clear();
    await fs.rm(tmpRoot, {recursive: true, force: true});
  });

  it('leaves the logs on the console, which is what the caller reports', () => {
    expect(() => logToTmpFolder()).toThrow(/permission denied/);

    expect(setFileLogTarget).not.toHaveBeenCalled();
  });
});
