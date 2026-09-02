/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const DISABLE_FLAG = 'ADK_DISABLE_LOAD_DOTENV';
const FROM_FILE = 'ADK_TEST_BOOTSTRAP_FROM_FILE';

/**
 * Budget (ms) for importing the CLI. The import pulls in the whole command
 * graph, whose first transform is slow on a loaded machine.
 */
const IMPORT_TIMEOUT_MS = 60000;

/**
 * Evaluates the CLI module graph with `workingDir` as the working directory.
 *
 * The start-up `.env` load runs in the body of `cli.ts`, so importing the real
 * module is the only way to exercise it.
 */
async function startCli(workingDir: string): Promise<void> {
  vi.resetModules();
  vi.spyOn(process, 'cwd').mockReturnValue(workingDir);
  await import('../../src/cli/cli.js');
}

describe('the CLI start-up .env load', () => {
  let originalEnv: typeof process.env;
  let workingDir: string;

  beforeEach(() => {
    originalEnv = {...process.env};
    workingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adk-bootstrap-'));
    fs.writeFileSync(path.join(workingDir, '.env'), `${FROM_FILE}=from-root\n`);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) {
        delete process.env[key];
      }
    }
    Object.assign(process.env, originalEnv);
    fs.rmSync(workingDir, {recursive: true, force: true});
  });

  it(
    'applies the .env of the working directory',
    async () => {
      await startCli(workingDir);

      expect(process.env[FROM_FILE]).toBe('from-root');
    },
    IMPORT_TIMEOUT_MS,
  );

  it(
    `reads no file when ${DISABLE_FLAG} is set`,
    async () => {
      process.env[DISABLE_FLAG] = '1';

      await startCli(workingDir);

      expect(process.env[FROM_FILE]).toBeUndefined();
    },
    IMPORT_TIMEOUT_MS,
  );
});
