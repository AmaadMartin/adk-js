/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// These cases run against the real filesystem: the symlink and truncation
// behaviour under test here is unobservable with `node:fs` mocked. The
// platform-refuses-a-symlink case, which needs the mock, lives in
// log_to_tmp_folder_symlink_failure_test.ts.

import {mkdtempSync, readFileSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {logToTmpFolder} from '../../src/utils/log_to_tmp_folder.js';
import {
  AdkLogger,
  resetFileLogTarget,
  setFileLogTarget,
} from '../../src/utils/logger.js';

/** The environment variables `os.tmpdir()` reads, across platforms. */
const TMP_ENV_VARS = ['TMPDIR', 'TMP', 'TEMP'];

describe('logToTmpFolder', () => {
  const savedEnv = new Map<string, string | undefined>();
  let tmpRoot = '';
  let logDir = '';

  // A temp root of its own per case, so that a run touches neither a
  // developer's real /tmp/agents_log nor another case's files. `os.tmpdir()`
  // re-reads these variables on every call.
  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'adk_log_test_'));
    for (const name of TMP_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      process.env[name] = tmpRoot;
    }
    logDir = path.join(tmpRoot, 'agents_log');
  });

  afterEach(async () => {
    // Release the log file before deleting it: Windows refuses to unlink a
    // file that still has an open write handle.
    await resetFileLogTarget();
    vi.useRealTimers();
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

  /**
   * Pins the clock, so that a case knows the log file name before the call.
   * Only `Date` is faked: winston writes on a real timer.
   */
  function freezeClockAt(hours: number, minutes: number, seconds: number) {
    vi.useFakeTimers({toFake: ['Date']});
    vi.setSystemTime(new Date(2026, 7, 17, hours, minutes, seconds));
  }

  it('creates the log file under the system temp folder', async () => {
    freezeClockAt(8, 11, 2);

    const {logFilePath} = logToTmpFolder();

    expect(path.dirname(logFilePath)).toBe(logDir);
    expect(path.basename(logFilePath)).toBe('agent.20260817_081102.log');
    expect((await fs.stat(logFilePath)).isFile()).toBe(true);
  });

  it('names the file after the local time, as adk-python does', () => {
    const {logFilePath} = logToTmpFolder();

    expect(path.basename(logFilePath)).toMatch(/^agent\.\d{8}_\d{6}\.log$/);
  });

  // Windows does not carry POSIX permission bits, so the mode cases below are
  // POSIX-only. A log holds model prompts and responses at a predictable path
  // in a world-traversable temp folder, so the bits are the whole protection.
  it.skipIf(process.platform === 'win32')(
    'keeps the folder and the file readable by their owner only',
    async () => {
      const {logFilePath} = logToTmpFolder();

      expect((await fs.stat(logDir)).mode & 0o777).toBe(0o700);
      expect((await fs.stat(logFilePath)).mode & 0o777).toBe(0o600);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'creates an owner-only file when the transport opens the path itself',
    async () => {
      // `logToTmpFolder` creates the file before the transport opens it, so
      // this drives the transport alone: it must not fall back to 0644.
      await fs.mkdir(logDir, {recursive: true, mode: 0o700});
      const logFilePath = path.join(logDir, 'transport_only.log');

      setFileLogTarget(logFilePath);

      await vi.waitFor(async () => {
        expect((await fs.stat(logFilePath)).mode & 0o777).toBe(0o600);
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses to write through a symlink left at the log file path',
    async () => {
      freezeClockAt(8, 11, 2);
      await fs.mkdir(logDir, {recursive: true});
      const victim = path.join(logDir, 'victim.txt');
      await fs.writeFile(victim, 'precious');
      await fs.symlink(victim, path.join(logDir, 'agent.20260817_081102.log'));

      expect(() => logToTmpFolder()).toThrow(/ELOOP/);
      expect(await fs.readFile(victim, 'utf8')).toBe('precious');
    },
  );

  it('writes the adk-python line shape and no ANSI escapes', async () => {
    const {logFilePath} = logToTmpFolder();

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

    const {logFilePath} = logToTmpFolder();
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
      const {logFilePath, latestLogPath} = logToTmpFolder();

      const linkPath = path.join(logDir, 'agent.latest.log');
      expect(latestLogPath).toBe(linkPath);
      expect(await fs.readlink(linkPath)).toBe(logFilePath);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'replaces a stale agent.latest.log with the newest run',
    async () => {
      freezeClockAt(8, 11, 2);
      const first = logToTmpFolder();
      freezeClockAt(8, 12, 5);
      const second = logToTmpFolder();

      const linkPath = path.join(logDir, 'agent.latest.log');
      expect(await fs.readlink(linkPath)).toBe(second.logFilePath);
      expect((await fs.stat(first.logFilePath)).isFile()).toBe(true);
    },
  );

  it('flushes the log file, so a caller may exit right after resetting', async () => {
    const {logFilePath} = logToTmpFolder();
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
    await fs.mkdir(logDir, {recursive: true});
    const linkPath = path.join(logDir, 'agent.latest.log');
    await fs.writeFile(linkPath, 'occupied');
    const emitWarning = vi
      .spyOn(process, 'emitWarning')
      .mockImplementation(() => {});

    const {logFilePath, latestLogPath} = logToTmpFolder();

    expect(latestLogPath).toBeUndefined();
    expect(emitWarning).toHaveBeenCalledWith(
      `Cannot create symlink for latest log file: file exists at ${linkPath}`,
    );
    expect(await fs.readFile(linkPath, 'utf8')).toBe('occupied');
    expect((await fs.stat(logFilePath)).isFile()).toBe(true);
  });
});
