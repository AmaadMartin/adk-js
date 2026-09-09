/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// These cases run against the real filesystem: the symlink and truncation
// behaviour under test here is unobservable with `node:fs` mocked. The
// platform-refuses-a-symlink case, which needs the mock, lives in
// log_to_tmp_folder_symlink_failure_test.ts.

import {randomUUID} from 'node:crypto';
import {readFileSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {logToTmpFolder} from '../../src/utils/log_to_tmp_folder.js';
import {AdkLogger, resetFileLogTarget} from '../../src/utils/logger.js';

describe('logToTmpFolder', () => {
  const createdDirs: string[] = [];
  let subFolder = '';

  /**
   * A unique sub folder per case, so that a run touches neither a developer's
   * real /tmp/agents_log nor another case's files.
   */
  function trackedSubFolder(): string {
    subFolder = `adk_test_${randomUUID()}`;
    createdDirs.push(path.join(os.tmpdir(), subFolder));
    return subFolder;
  }

  function logDir(): string {
    return path.join(os.tmpdir(), subFolder);
  }

  afterEach(async () => {
    // Release the log file before deleting it: Windows refuses to unlink a
    // file that still has an open write handle.
    await resetFileLogTarget();
    vi.restoreAllMocks();
    for (const dir of createdDirs.splice(0)) {
      await fs.rm(dir, {
        recursive: true,
        force: true,
        maxRetries: 10,
        retryDelay: 20,
      });
    }
  });

  it('creates the log file under the system temp folder', async () => {
    const {logFilePath} = logToTmpFolder({
      subFolder: trackedSubFolder(),
      logFileTimestamp: '20260817_081102',
    });

    expect(path.dirname(logFilePath)).toBe(logDir());
    expect(path.basename(logFilePath)).toBe('agent.20260817_081102.log');
    expect((await fs.stat(logFilePath)).isFile()).toBe(true);
  });

  it('names the file as adk-python does when given no timestamp', () => {
    const {logFilePath} = logToTmpFolder({subFolder: trackedSubFolder()});

    expect(path.basename(logFilePath)).toMatch(/^agent\.\d{8}_\d{6}\.log$/);
  });

  it('writes the adk-python line shape and no ANSI escapes', async () => {
    const {logFilePath} = logToTmpFolder({subFolder: trackedSubFolder()});

    // `colorize` would leak escape sequences into the file if the format were
    // swapped at the transport instead of at the logger.
    new AdkLogger({label: 'Test', colorize: {all: true}}).info('hello');

    await vi.waitFor(async () => {
      const contents = await fs.readFile(logFilePath, 'utf8');
      expect(contents).toMatch(
        /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} - INFO - Test - hello$/m,
      );
      expect(contents).not.toContain('\u001b[');
    });
  });

  it('redirects a logger that was constructed before the call', async () => {
    const logger = new AdkLogger({label: 'Early'});

    const {logFilePath} = logToTmpFolder({subFolder: trackedSubFolder()});
    logger.info('after redirect');

    await vi.waitFor(async () => {
      expect(await fs.readFile(logFilePath, 'utf8')).toContain(
        ' - INFO - Early - after redirect',
      );
    });
  });

  it.skipIf(process.platform === 'win32')(
    'points agent.latest.log at this run',
    async () => {
      const {logFilePath, latestLogPath} = logToTmpFolder({
        subFolder: trackedSubFolder(),
      });

      const linkPath = path.join(logDir(), 'agent.latest.log');
      expect(latestLogPath).toBe(linkPath);
      expect(await fs.readlink(linkPath)).toBe(logFilePath);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'replaces a stale agent.latest.log with the newest run',
    async () => {
      const folder = trackedSubFolder();
      const first = logToTmpFolder({
        subFolder: folder,
        logFileTimestamp: '20260817_081102',
      });
      const second = logToTmpFolder({
        subFolder: folder,
        logFileTimestamp: '20260817_081205',
      });

      const linkPath = path.join(logDir(), 'agent.latest.log');
      expect(await fs.readlink(linkPath)).toBe(second.logFilePath);
      expect((await fs.stat(first.logFilePath)).isFile()).toBe(true);
    },
  );

  it('flushes the log file, so a caller may exit right after resetting', async () => {
    const {logFilePath} = logToTmpFolder({subFolder: trackedSubFolder()});
    new AdkLogger({label: 'Exiting'}).info('last words');

    await resetFileLogTarget();

    // A synchronous read, because an awaited one would hand the pending write
    // the extra ticks that `process.exit` denies it.
    expect(readFileSync(logFilePath, 'utf8')).toContain(
      ' - INFO - Exiting - last words',
    );
    // A second reset has nothing left to release.
    await expect(resetFileLogTarget()).resolves.toBeUndefined();
  });

  it('warns and keeps running when a file occupies agent.latest.log', async () => {
    const folder = trackedSubFolder();
    await fs.mkdir(logDir(), {recursive: true});
    const linkPath = path.join(logDir(), 'agent.latest.log');
    await fs.writeFile(linkPath, 'occupied');
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});

    const {logFilePath, latestLogPath} = logToTmpFolder({
      subFolder: folder,
      logFileTimestamp: '20260817_081102',
    });

    expect(latestLogPath).toBeUndefined();
    expect(emitWarning).toHaveBeenCalledWith(
      `Cannot create symlink for latest log file: file exists at ${linkPath}`,
    );
    expect(await fs.readFile(linkPath, 'utf8')).toBe('occupied');
    expect((await fs.stat(logFilePath)).isFile()).toBe(true);
  });
});
