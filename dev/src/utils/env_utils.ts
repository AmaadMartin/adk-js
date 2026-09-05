/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import dotenv from 'dotenv';

/** Set this to `1` or `true` to stop the CLI reading any `.env` file. */
export const DISABLE_LOAD_DOTENV_ENV_VAR = 'ADK_DISABLE_LOAD_DOTENV';

/**
 * Whether an environment variable is turned on.
 *
 * A variable counts as on when it reads `1` or `true`, in any case, which is
 * what adk-python's `is_env_enabled` accepts.
 *
 * @param name Name of the environment variable to read.
 */
export function isEnvEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

/**
 * Applies the working directory's `.env` to `process.env`.
 *
 * A run that sets `ADK_DISABLE_LOAD_DOTENV` reads no file, so a locked-down
 * environment keeps the variables it was started with.
 */
export function loadDotenvFromCwd(): void {
  if (isEnvEnabled(DISABLE_LOAD_DOTENV_ENV_VAR)) {
    return;
  }

  dotenv.config({quiet: true});
}
