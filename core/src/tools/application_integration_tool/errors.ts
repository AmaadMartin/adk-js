/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Why an Application Integration or Integration Connectors call failed. */
export enum ApplicationIntegrationErrorCode {
  /** No usable credential could be resolved. */
  CREDENTIALS = 'CREDENTIALS',
  /** The API rejected the request as malformed or unknown (HTTP 400 / 404). */
  INVALID_REQUEST = 'INVALID_REQUEST',
  /** The call reached the API but did not succeed. */
  REQUEST_FAILED = 'REQUEST_FAILED',
}

/** An error raised by the Application Integration clients. */
export class ApplicationIntegrationError extends Error {
  constructor(
    readonly code: ApplicationIntegrationErrorCode,
    message: string,
    options?: {cause?: unknown},
  ) {
    super(message, options);
    this.name = 'ApplicationIntegrationError';
  }
}
