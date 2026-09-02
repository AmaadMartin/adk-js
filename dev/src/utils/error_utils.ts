/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Describes a caught value, which `catch` types as `unknown` because anything
 * can be thrown.
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
