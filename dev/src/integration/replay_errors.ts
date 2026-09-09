/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Raised when a replayed run diverges from what was recorded. */
export class ReplayVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayVerificationError';
    Object.setPrototypeOf(this, ReplayVerificationError.prototype);
  }
}

/** Type guard for {@link ReplayVerificationError}. */
export function isReplayVerificationError(
  e: unknown,
): e is ReplayVerificationError {
  return e instanceof Error && e.name === 'ReplayVerificationError';
}

/** Raised when the replay configuration or its fixtures cannot be used. */
export class ReplayConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReplayConfigError';
    Object.setPrototypeOf(this, ReplayConfigError.prototype);
  }
}

/** Type guard for {@link ReplayConfigError}. */
export function isReplayConfigError(e: unknown): e is ReplayConfigError {
  return e instanceof Error && e.name === 'ReplayConfigError';
}
