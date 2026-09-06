/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Represents an error raised when a service does not implement an optional
 * capability.
 */
export class NotImplementedError extends Error {
  /**
   * @param message A message describing the unsupported capability.
   */
  constructor(message = 'This operation is not implemented.') {
    super(message);
    this.name = 'NotImplementedError';
  }
}
