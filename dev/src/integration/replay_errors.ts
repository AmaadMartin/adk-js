/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Raised when the replay configuration is missing, incomplete or unusable.
 *
 * Ported from `ReplayConfigError` in adk-python's
 * `src/google/adk/cli/plugins/replay_plugin.py`.
 */
export class ReplayConfigError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'ReplayConfigError';
    Object.setPrototypeOf(this, ReplayConfigError.prototype);
  }
}

/**
 * Raised when a replayed run diverges from what was recorded.
 *
 * Ported from `ReplayVerificationError` in adk-python's
 * `src/google/adk/cli/plugins/replay_plugin.py`.
 */
export class ReplayVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayVerificationError';
    Object.setPrototypeOf(this, ReplayVerificationError.prototype);
  }
}
