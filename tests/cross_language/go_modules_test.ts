/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {ExecFileException, ExecFileOptions} from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {ensureGoModules, GO_MOD_TIDY_TIMEOUT_MS} from './go_modules.js';

type ExecFileCallback = (
  error: ExecFileException | null,
  stdout: string,
  stderr: string,
) => void;

/**
 * `promisify` only uses a function's `util.promisify.custom` implementation,
 * which this replacement does not carry, so it falls back to the generic
 * callback path. The mock must therefore call its last argument.
 */
const execFileMock = vi.hoisted(() =>
  vi.fn<
    (
      file: string,
      args: readonly string[],
      options: ExecFileOptions,
      callback: ExecFileCallback,
    ) => void
  >(),
);

vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:child_process')>()),
  execFile: execFileMock,
}));

/** Fails the tidy with `error`, as `execFile`'s callback would. */
function rejectWith(error: ExecFileException): void {
  execFileMock.mockImplementation((_file, _args, _options, callback) => {
    callback(error, '', '');
  });
}

describe('ensureGoModules', () => {
  let moduleDir: string;

  beforeEach(() => {
    moduleDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-go-modules-'));
    execFileMock.mockImplementation((_file, _args, _options, callback) => {
      callback(null, '', '');
    });
  });

  afterEach(() => {
    fs.rmSync(moduleDir, {recursive: true, force: true});
    execFileMock.mockReset();
  });

  it('does not tidy when go.sum already exists', async () => {
    fs.writeFileSync(path.join(moduleDir, 'go.sum'), '');

    await ensureGoModules(moduleDir);

    expect(execFileMock).not.toHaveBeenCalled();
  });

  it('tidies the module directory when go.sum is absent', async () => {
    await ensureGoModules(moduleDir);

    expect(execFileMock).toHaveBeenCalledWith(
      'go',
      ['mod', 'tidy'],
      expect.objectContaining({
        cwd: moduleDir,
        timeout: GO_MOD_TIDY_TIMEOUT_MS,
      }),
      expect.any(Function),
    );
  });

  it('rejects by name when the go executable is missing', async () => {
    rejectWith(Object.assign(new Error('spawn go ENOENT'), {code: 'ENOENT'}));

    await expect(ensureGoModules(moduleDir)).rejects.toThrow(
      `go mod tidy failed in ${moduleDir}: the 'go' executable was not found ` +
        `on PATH. Install the Go toolchain (https://go.dev/dl/) or run ` +
        `'go mod tidy' in that directory manually before running the ` +
        `cross-language tests.`,
    );
  });

  it('rejects with the budget it was given when the tidy times out', async () => {
    rejectWith(Object.assign(new Error('killed'), {killed: true, code: null}));

    await expect(ensureGoModules(moduleDir, 1234)).rejects.toThrow(
      'it exceeded its 1234ms budget',
    );
    expect(execFileMock).toHaveBeenCalledWith(
      'go',
      ['mod', 'tidy'],
      expect.objectContaining({timeout: 1234}),
      expect.any(Function),
    );
  });

  it('reports stderr when the tidy exits non-zero', async () => {
    rejectWith(
      Object.assign(new Error('exit 1'), {
        code: 1,
        stderr: 'go: some/module@v1: invalid version\n',
      }),
    );

    await expect(ensureGoModules(moduleDir)).rejects.toThrow(
      'it exited with code 1\ngo: some/module@v1: invalid version.',
    );
  });

  it('omits the stderr line when the failed tidy wrote nothing', async () => {
    rejectWith(Object.assign(new Error('exit 2'), {code: 2, stderr: ''}));

    await expect(ensureGoModules(moduleDir)).rejects.toThrow(
      'it exited with code 2. Install the Go toolchain',
    );
  });

  it('stringifies a rejection that is not an object', async () => {
    execFileMock.mockImplementation(() => {
      throw 'go exploded';
    });

    await expect(ensureGoModules(moduleDir)).rejects.toThrow(
      `go mod tidy failed in ${moduleDir}: go exploded.`,
    );
  });

  it('keeps the original failure as the error cause', async () => {
    const original = Object.assign(new Error('spawn go ENOENT'), {
      code: 'ENOENT',
    });
    rejectWith(original);

    const rejection = await ensureGoModules(moduleDir).catch(
      (error: unknown) => error,
    );

    if (!(rejection instanceof Error)) {
      expect.fail(`expected a rejection, got ${String(rejection)}`);
    }
    expect(rejection.cause).toBe(original);
  });
});
