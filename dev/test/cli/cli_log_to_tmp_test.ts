/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// These cases drive the CLI against the real filesystem and the real logging
// stack, so that the flag is proven end to end. Only the server is replaced,
// so that no port is bound. Every case redirects the system temp folder first,
// so that it never touches a developer's own /tmp/agents_log.

import {getLogger, setLogger} from '@google/adk';
import {mkdtempSync, readFileSync, readlinkSync} from 'node:fs';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {createProgram} from '../../src/cli/cli.js';
import {AdkApiServer} from '../../src/server/adk_api_server.js';
import {resetFileLogTarget} from '../../src/utils/logger.js';

vi.mock('../../src/server/adk_api_server', () => ({
  AdkApiServer: vi.fn(() => ({start: vi.fn()})),
}));

/** The environment variables `os.tmpdir()` reads, across platforms. */
const TMP_ENV_VARS = ['TMPDIR', 'TMP', 'TEMP'];

const SETUP_LINE_PREFIX = 'Log setup complete: ';
const LATEST_LINE_PREFIX = 'To access latest log: tail -F ';

describe('adk web and api_server with --log_to_tmp', () => {
  const savedEnv = new Map<string, string | undefined>();
  const printed: string[] = [];
  let tmpRoot = '';
  let logDir = '';

  beforeEach(() => {
    tmpRoot = mkdtempSync(path.join(os.tmpdir(), 'adk_cli_log_test_'));
    for (const name of TMP_ENV_VARS) {
      savedEnv.set(name, process.env[name]);
      process.env[name] = tmpRoot;
    }
    logDir = path.join(tmpRoot, 'agents_log');
    printed.length = 0;
    vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
      printed.push(args.map(String).join(' '));
    });
  });

  afterEach(async () => {
    // Release the log file before deleting it: Windows refuses to unlink a
    // file that still has an open write handle.
    await resetFileLogTarget();
    setLogger(null);
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

  async function runCli(args: string[]): Promise<void> {
    const program = createProgram();
    program.exitOverride();
    await program.parseAsync(['node', 'cli_entrypoint.js', ...args]);
  }

  /** The path the CLI printed after `prefix`. */
  function printedPath(prefix: string): string {
    const line = printed.find((entry) => entry.startsWith(prefix));
    if (line === undefined) {
      expect.fail(`the CLI printed no line starting with "${prefix}"`);
    }
    return line.slice(prefix.length);
  }

  it('writes the ADK log records to the file and not to the terminal', async () => {
    await runCli(['api_server', '--log_to_tmp']);
    const logFilePath = printedPath(SETUP_LINE_PREFIX);
    const stdout = vi
      .spyOn(process.stdout, 'write')
      .mockImplementation(() => true);

    getLogger().info('served a request');

    expect(stdout).not.toHaveBeenCalled();
    expect(path.dirname(logFilePath)).toBe(logDir);
    await vi.waitFor(() => {
      const content = readFileSync(logFilePath, 'utf8');
      expect(content).toContain(' - INFO - ADK - served a request');
      // A file must not receive the terminal's colour escapes.
      expect(content).not.toContain('\u001b[');
    });
  });

  it('points the latest log line at a link that resolves to the file', async () => {
    await runCli(['web', '--log_to_tmp']);

    const logFilePath = printedPath(SETUP_LINE_PREFIX);
    const latestLogPath = printedPath(LATEST_LINE_PREFIX);
    expect(latestLogPath).toBe(path.join(logDir, 'agent.latest.log'));
    expect(readlinkSync(latestLogPath)).toBe(logFilePath);
  });

  it('applies --log_level to the file logger', async () => {
    // The level is set after the file logger is installed. Set it before, and
    // it lands on the logger this command replaces, leaving the file logger on
    // its INFO default and dropping this record.
    await runCli(['api_server', '--log_to_tmp', '--log_level', 'debug']);
    const logFilePath = printedPath(SETUP_LINE_PREFIX);

    getLogger().debug('loader details');

    await vi.waitFor(() => {
      expect(readFileSync(logFilePath, 'utf8')).toContain(
        ' - DEBUG - ADK - loader details',
      );
    });
  });

  it('creates no log folder when the flag is absent', async () => {
    await runCli(['api_server']);

    await expect(fs.stat(logDir)).rejects.toThrow();
    expect(printed.some((line) => line.startsWith(SETUP_LINE_PREFIX))).toBe(
      false,
    );
  });

  it('starts the server anyway when a stale file occupies the log folder path', async () => {
    // A leftover file, or another user's, at the fixed folder name. `mkdir`
    // fails with EEXIST, and the command has to survive it.
    await fs.writeFile(logDir, 'not a folder');
    const warned: string[] = [];
    vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      warned.push(args.map(String).join(' '));
    });

    await runCli(['api_server', '--log_to_tmp']);

    expect(vi.mocked(AdkApiServer)).toHaveBeenCalledTimes(1);
    expect(warned.some((line) => line.includes('EEXIST'))).toBe(true);
    expect(printed.some((line) => line.startsWith(SETUP_LINE_PREFIX))).toBe(
      false,
    );
    expect(await fs.readFile(logDir, 'utf8')).toBe('not a folder');
  });

  it.skipIf(process.platform === 'win32')(
    'starts the server anyway when the log folder refuses the write',
    async () => {
      await fs.mkdir(logDir, {mode: 0o500});
      const warned: string[] = [];
      vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
        warned.push(args.map(String).join(' '));
      });

      await runCli(['api_server', '--log_to_tmp']);

      expect(vi.mocked(AdkApiServer)).toHaveBeenCalledTimes(1);
      expect(warned.some((line) => line.includes('EACCES'))).toBe(true);
      expect(await fs.readdir(logDir)).toEqual([]);
      // Let afterEach delete it.
      await fs.chmod(logDir, 0o700);
    },
  );
});
