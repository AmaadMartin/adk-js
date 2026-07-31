/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as dotenv from 'dotenv';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {beforeEach, describe, expect, it, vi} from 'vitest';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {...actual, existsSync: vi.fn()};
});

vi.mock('dotenv', () => {
  const config = vi.fn();
  return {config, default: {config}};
});

/** Path tail of candidate 1, spelled with the platform separator. */
const CANONICAL_SUFFIX = path.join('tests', 'e2e', '.env');

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
    const probed = await probe(() => false);

    expect(probed).toHaveLength(2);
    expect(probed[0].endsWith(CANONICAL_SUFFIX)).toBe(true);
    expect(path.basename(probed[1])).toBe('.env');
    // The repo root is exactly the two directories above tests/e2e.
    expect(
      path.relative(path.dirname(probed[0]), path.dirname(probed[1])),
    ).toBe(path.join('..', '..'));
    expect(dotenv.config).not.toHaveBeenCalled();
  });

  it('loads tests/e2e/.env and stops there when it exists', async () => {
    const probed = await probe((candidate) =>
      candidate.endsWith(CANONICAL_SUFFIX),
    );

    expect(probed).toHaveLength(1);
    expect(dotenv.config).toHaveBeenCalledTimes(1);
    expect(dotenv.config).toHaveBeenCalledWith({path: probed[0]});
  });

  it('falls back to the repo root .env when tests/e2e/.env is absent', async () => {
    const probed = await probe(
      (candidate) => !candidate.endsWith(CANONICAL_SUFFIX),
    );

    expect(probed).toHaveLength(2);
    expect(dotenv.config).toHaveBeenCalledTimes(1);
    expect(dotenv.config).toHaveBeenCalledWith({path: probed[1]});
  });

  it('reads only tests/e2e/.env when both candidates exist', async () => {
    const probed = await probe(() => true);

    expect(probed).toHaveLength(1);
    expect(probed[0].endsWith(CANONICAL_SUFFIX)).toBe(true);
    expect(dotenv.config).toHaveBeenCalledTimes(1);
    expect(dotenv.config).toHaveBeenCalledWith({path: probed[0]});
  });
});
