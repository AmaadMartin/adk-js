/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// `vi.mock` is hoisted and file-scoped, so this case cannot share a file with
// the real-filesystem cases in log_to_tmp_folder_test.ts.

import {randomUUID} from 'node:crypto';
import {mkdirSync, rmSync} from 'node:fs';
import {symlink} from 'node:fs/promises';
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

describe('logToTmpFolder when the latest pointer cannot be replaced', () => {
  let subFolder = '';
  let logDir = '';

  beforeEach(async () => {
    subFolder = `adk_test_${randomUUID()}`;
    logDir = path.join(os.tmpdir(), subFolder);
    mkdirSync(logDir, {recursive: true});
    await symlink(
      path.join(logDir, 'agent.20260817_080000.log'),
      path.join(logDir, 'agent.latest.log'),
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(logDir, {recursive: true, force: true});
  });

  it('leaves the logs on the console, which is what the caller reports', () => {
    expect(() =>
      logToTmpFolder({subFolder, logFileTimestamp: '20260817_081102'}),
    ).toThrow(/permission denied/);

    expect(setFileLogTarget).not.toHaveBeenCalled();
  });
});
