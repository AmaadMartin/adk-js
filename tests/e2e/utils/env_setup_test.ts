/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DotenvConfigOptions, DotenvConfigOutput} from 'dotenv';
import {existsSync} from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {beforeEach, describe, expect, it, vi} from 'vitest';

const {configMock} = vi.hoisted(() => ({
  configMock: vi.fn<(options?: DotenvConfigOptions) => DotenvConfigOutput>(),
}));

vi.mock('dotenv', () => ({config: configMock}));

const UTILS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Resolved independently of the module under test, from this file. */
const E2E_ENV = path.resolve(UTILS_DIR, '..', '.env');

/** The repo-root `.env` this suite deliberately does not consult. */
const ROOT_ENV = path.resolve(UTILS_DIR, '..', '..', '..', '.env');

/**
 * Re-runs the setup module. vitest has already imported it once as a
 * `setupFiles` entry, so the registry is reset in `beforeEach` to re-execute it
 * against the mock registered above.
 */
async function runSetup(): Promise<void> {
  await import('./env_setup.js');
}

describe('e2e env setup', () => {
  beforeEach(() => {
    vi.resetModules();
    configMock.mockReset();
    configMock.mockReturnValue({parsed: {}});
  });

  it('reads tests/e2e/.env and suppresses the dotenv banner', async () => {
    await runSetup();

    expect(configMock).toHaveBeenCalledTimes(1);
    expect(configMock).toHaveBeenCalledWith({path: E2E_ENV, quiet: true});
  });

  it('resolves next to the committed .env.template', () => {
    expect(existsSync(path.join(path.dirname(E2E_ENV), '.env.template'))).toBe(
      true,
    );
  });

  it('never falls back to a repo-root .env', async () => {
    await runSetup();

    expect(configMock).toHaveBeenCalledTimes(1);
    expect(configMock).not.toHaveBeenCalledWith(
      expect.objectContaining({path: ROOT_ENV}),
    );
  });
});

describe('dotenv contract the setup relies on', () => {
  it('reports a missing file instead of throwing, so no existsSync guard is needed', async () => {
    const dotenv = await vi.importActual<typeof import('dotenv')>('dotenv');
    const missing = path.join(UTILS_DIR, 'no-such-file.env');
    expect(existsSync(missing)).toBe(false);

    const result = dotenv.config({path: missing, quiet: true});

    expect(result.error).toBeInstanceOf(Error);
    expect(result.parsed).toEqual({});
  });
});
