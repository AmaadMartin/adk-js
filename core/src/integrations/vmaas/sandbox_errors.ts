/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** The reasons the Vertex AI sandbox integration reports a failure. */
export enum SandboxErrorCode {
  /**
   * The installed `@google-cloud/vertexai` release does not expose the sandbox
   * method the operation needs, and the caller supplied no replacement.
   */
  SDK_TRANSPORT_UNAVAILABLE = 'SDK_TRANSPORT_UNAVAILABLE',
  /** An action ran before `prepare()` bound the session state. */
  SESSION_STATE_NOT_BOUND = 'SESSION_STATE_NOT_BOUND',
  /** The agent engine creation operation did not finish in time. */
  AGENT_ENGINE_CREATE_TIMED_OUT = 'AGENT_ENGINE_CREATE_TIMED_OUT',
  /** The completed create operation carried no agent engine resource name. */
  AGENT_ENGINE_NAME_MISSING = 'AGENT_ENGINE_NAME_MISSING',
  /** The completed create operation carried no sandbox resource name. */
  SANDBOX_NAME_MISSING = 'SANDBOX_NAME_MISSING',
  /** The screenshot response carried no base64 image data. */
  SCREENSHOT_DATA_MISSING = 'SCREENSHOT_DATA_MISSING',
}

/** A failure raised by the Vertex AI sandbox integration. */
export class SandboxError extends Error {
  constructor(
    readonly code: SandboxErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'SandboxError';
    Object.setPrototypeOf(this, SandboxError.prototype);
  }
}

/** Type guard for {@link SandboxError}. */
export function isSandboxError(value: unknown): value is SandboxError {
  return value instanceof Error && value.name === 'SandboxError';
}
