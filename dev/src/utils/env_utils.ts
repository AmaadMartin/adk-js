/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether an environment variable is turned on.
 *
 * A variable counts as on when it reads `1` or `true`, in any case, which is
 * the spelling adk-python accepts for the same flags.
 */
export function isEnvEnabled(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase();
  return value === '1' || value === 'true';
}
