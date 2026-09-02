/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Reports whether an environment variable is enabled.
 *
 * A variable counts as enabled when its value, lowercased, is `true` or `1`.
 *
 * @param name Name of the environment variable to read.
 * @param defaultValue Value to assume when the variable is not set.
 */
export function isEnvEnabled(name: string, defaultValue = '0'): boolean {
  return ['true', '1'].includes(
    (process.env[name] ?? defaultValue).toLowerCase(),
  );
}
