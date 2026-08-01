/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {DotenvConfigOptions, DotenvConfigOutput} from 'dotenv';
import {existsSync} from 'node:fs';
import * as path from 'node:path';
import {fileURLToPath} from 'node:url';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

const {configMock} = vi.hoisted(() => ({
  configMock: vi.fn<(options?: DotenvConfigOptions) => DotenvConfigOutput>(),
}));

vi.mock('dotenv', () => ({config: configMock}));

const UTILS_DIR = path.dirname(fileURLToPath(import.meta.url));

/** Resolved independently of the helper, from this test's own location. */
const E2E_ENV = path.resolve(UTILS_DIR, '..', '.env');

/** The repo-root `.env` that this loader deliberately does not consult. */
const ROOT_ENV = path.resolve(UTILS_DIR, '..', '..', '..', '.env');

/**
 * Builds a failure result in the shape dotenv declares. `DotenvError` is not
 * exported, so it is recovered from the public output type.
 */
function missingFileResult(): DotenvConfigOutput {
  return {
    parsed: {},
    error: Object.assign(new Error('no such file or directory'), {
      code: 'MISSING_DATA' as const,
    }),
  };
}

describe('loadE2eEnv', () => {
  let loadE2eEnv: () => void;

  beforeEach(async () => {
    // env_setup.ts imports the loader before this file runs, so it is
    // re-imported here to bind to the mock registered above.
    vi.resetModules();
    configMock.mockReset();
    configMock.mockReturnValue({parsed: {}});
    ({loadE2eEnv} = await import('./env.js'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('reads tests/e2e/.env and suppresses the dotenv banner', () => {
    loadE2eEnv();

    expect(configMock).toHaveBeenCalledTimes(1);
    expect(configMock).toHaveBeenCalledWith({path: E2E_ENV, quiet: true});
  });

  it('resolves next to the committed .env.template', () => {
    expect(existsSync(path.join(path.dirname(E2E_ENV), '.env.template'))).toBe(
      true,
    );
  });

  it('never falls back to a repo-root .env', () => {
    expect(ROOT_ENV).not.toBe(E2E_ENV);

    loadE2eEnv();

    expect(configMock).toHaveBeenCalledTimes(1);
    expect(configMock).not.toHaveBeenCalledWith(
      expect.objectContaining({path: ROOT_ENV}),
    );
  });

  it('makes the loaded values visible on process.env', () => {
    configMock.mockImplementation(() => {
      vi.stubEnv('ADK_E2E_ENV_FIXTURE', 'from-dotenv-file');
      return {parsed: {ADK_E2E_ENV_FIXTURE: 'from-dotenv-file'}};
    });
    expect(process.env.ADK_E2E_ENV_FIXTURE).toBeUndefined();

    loadE2eEnv();

    expect(process.env.ADK_E2E_ENV_FIXTURE).toBe('from-dotenv-file');
  });

  it('does not throw when tests/e2e/.env is absent', () => {
    configMock.mockReturnValue(missingFileResult());

    expect(() => loadE2eEnv()).not.toThrow();
  });
});

describe('dotenv contract the loader relies on', () => {
  it('reports a missing file instead of throwing, so no existsSync guard is needed', async () => {
    const dotenv = await vi.importActual<typeof import('dotenv')>('dotenv');
    const missing = path.join(UTILS_DIR, 'no-such-file.env');
    expect(existsSync(missing)).toBe(false);

    const result = dotenv.config({path: missing, quiet: true});

    expect(result.error).toBeInstanceOf(Error);
    expect(result.parsed).toEqual({});
  });
});
