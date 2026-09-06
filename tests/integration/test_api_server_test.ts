/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as childProcess from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {describe, expect, it, vi} from 'vitest';
import {AdkTsApiServer, assertAdkCliBuilt} from './test_api_server.js';

// Reports the CLI entrypoint as missing so start() takes the unbuilt-checkout
// path on a built tree. Every other path keeps the real answer.
vi.mock('node:fs', async (importActual) => {
  const actual = await importActual<typeof import('node:fs')>();
  return {
    ...actual,
    existsSync: (target: fs.PathLike) =>
      String(target).endsWith('cli_entrypoint.js')
        ? false
        : actual.existsSync(target),
  };
});

vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  return {...actual, spawn: vi.fn(actual.spawn)};
});

const START_BUDGET_MS = 5000;

describe('assertAdkCliBuilt', () => {
  it('names the missing entrypoint and the build command', () => {
    const missing = path.resolve(__dirname, 'not_built/cli_entrypoint.js');

    expect(() => assertAdkCliBuilt(missing)).toThrowError(missing);
    expect(() => assertAdkCliBuilt(missing)).toThrowError('npm run build');
  });

  it('accepts an entrypoint that exists', () => {
    const present = path.resolve(__dirname, 'test_api_server.ts');

    expect(() => assertAdkCliBuilt(present)).not.toThrow();
  });
});

describe('AdkTsApiServer.start', () => {
  it(
    'rejects before it spawns the CLI',
    async () => {
      const server = new AdkTsApiServer({agentsDir: __dirname});

      await expect(server.start()).rejects.toThrowError('npm run build');
      expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
    },
    START_BUDGET_MS,
  );
});
