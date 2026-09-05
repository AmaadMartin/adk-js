/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Why the Vertex AI Agent Engine sandbox integration failed. */
export enum SandboxErrorCode {
  /** An action ran before `prepare()` bound the session state. */
  SESSION_STATE_NOT_BOUND = 'SESSION_STATE_NOT_BOUND',
  /**
   * The installed `@google-cloud/vertexai` release exposes no sandbox method
   * for the request, and the caller supplied no replacement transport.
   */
  TRANSPORT_NOT_CONFIGURED = 'TRANSPORT_NOT_CONFIGURED',
  /** A create operation was still running when the poll budget ran out. */
  CREATE_OPERATION_INCOMPLETE = 'CREATE_OPERATION_INCOMPLETE',
  /** An unfinished create operation carried no name to poll it by. */
  CREATE_OPERATION_UNNAMED = 'CREATE_OPERATION_UNNAMED',
  /** A create operation finished without naming the resource it created. */
  CREATED_RESOURCE_UNNAMED = 'CREATED_RESOURCE_UNNAMED',
  /** The screenshot response carried no base64 image data. */
  SCREENSHOT_DATA_MISSING = 'SCREENSHOT_DATA_MISSING',
  /** The browser history entry to navigate to carried no id. */
  HISTORY_ENTRY_ID_MISSING = 'HISTORY_ENTRY_ID_MISSING',
}

/** A failure raised by the Vertex AI Agent Engine sandbox integration. */
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

/** Whether `value` is a {@link SandboxError}. */
export function isSandboxError(value: unknown): value is SandboxError {
  return value instanceof Error && value.name === 'SandboxError';
}
