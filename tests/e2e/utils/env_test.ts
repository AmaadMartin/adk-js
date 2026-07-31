/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, existsSync: vi.fn()};
});

vi.mock('dotenv', () => {
  const config = vi.fn();
  return {config, default: {config}};
});

const UTILS_DIR = path.dirname(fileURLToPath(import.meta.url));
const E2E_ENV = path.resolve(UTILS_DIR, '..', '.env');
const ROOT_ENV = path.resolve(UTILS_DIR, '..', '..', '..', '.env');

/**
 * Runs the loader with `fs.existsSync` answering `exists`, and reports the
 * candidates it probed, in order.
 *
 * env_setup.ts imports the loader before this file runs, so the module is
 * re-imported here — after the mocks above are registered — to bind it to the
 * mocked dependencies rather than the real ones.
 */
async function probe(
  exists: (candidate: string) => boolean,
): Promise<string[]> {
  const probed: string[] = [];
  vi.mocked(fs.existsSync).mockImplementation((candidate) => {
    probed.push(String(candidate));
    return exists(String(candidate));
  });
  const {loadE2eEnv} = await import('./env.js');
  loadE2eEnv();
  return probed;
}

describe('loadE2eEnv', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
  });

  it('probes tests/e2e/.env then the repo root, and loads neither when absent', async () => {
    expect(await probe(() => false)).toEqual([E2E_ENV, ROOT_ENV]);
    expect(dotenv.config).not.toHaveBeenCalled();
  });

  it('loads tests/e2e/.env and stops there when it exists', async () => {
    expect(await probe((candidate) => candidate === E2E_ENV)).toEqual([
      E2E_ENV,
    ]);
    expect(dotenv.config).toHaveBeenCalledTimes(1);
    expect(dotenv.config).toHaveBeenCalledWith({path: E2E_ENV});
  });

  it('falls back to the repo root .env when tests/e2e/.env is absent', async () => {
    expect(await probe((candidate) => candidate === ROOT_ENV)).toEqual([
      E2E_ENV,
      ROOT_ENV,
    ]);
    expect(dotenv.config).toHaveBeenCalledTimes(1);
    expect(dotenv.config).toHaveBeenCalledWith({path: ROOT_ENV});
  });

  it('reads only tests/e2e/.env when both candidates exist', async () => {
    expect(await probe(() => true)).toEqual([E2E_ENV]);
    expect(dotenv.config).toHaveBeenCalledTimes(1);
    expect(dotenv.config).toHaveBeenCalledWith({path: E2E_ENV});
  });
});
