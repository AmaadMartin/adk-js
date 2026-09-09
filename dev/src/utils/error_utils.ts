/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The message of a caught value, which the type system reports as unknown. */
export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
