/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** Prefix applied to every GCS tool name exposed to the model. */
export const GCS_TOOL_NAME_PREFIX = 'gcs';

/** Outcome of a GCS tool invocation. */
export enum GcsToolStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
}

/**
 * Result payload returned to the model by every GCS tool.
 *
 * The keys are snake_case and the status values are SCREAMING_CASE because
 * this object crosses the model boundary as the function response, and it
 * must stay identical to the payload adk-python returns.
 */
export interface GcsToolResult {
  status: GcsToolStatus;
  results?: unknown;
  error_details?: string;
  next_page_token?: string;
  encoding?: 'text' | 'base64';
}

/** Type of operations a GCS toolset is allowed to expose. */
export enum GcsCapability {
  /** Only read operations are allowed. */
  READ_ONLY = 'read_only',
  /** Both read and write operations are allowed. */
  READ_WRITE = 'read_write',
}

/** Settings for GCS tools. */
export interface GcsToolSettings {
  /**
   * Allowed capabilities for GCS tools. Defaults to
   * `[GcsCapability.READ_ONLY]` when omitted, so tools allow only read
   * operations. This behaviour may change in future versions.
   */
  capabilities?: GcsCapability[];
}
