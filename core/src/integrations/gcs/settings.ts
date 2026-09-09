/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What class of operation the Cloud Storage tools are permitted to perform.
 *
 * The string values cross the boundary between the ADK SDKs, so they are the
 * same as adk-python's `Capabilities`.
 */
export enum GcsCapability {
  /** Only read operations are allowed. */
  READ_ONLY = 'read_only',
  /** Both read and write operations are allowed. */
  READ_WRITE = 'read_write',
}

/** Settings shared by the Cloud Storage toolsets. */
export interface GcsToolSettings {
  /**
   * Allowed capabilities for the Cloud Storage tools.
   *
   * The tools allow only read operations by default. An application has to opt
   * in to the mutating tools.
   */
  capabilities: GcsCapability[];
}

/** The read-only settings a toolset uses when it is given none. */
export const DEFAULT_GCS_TOOL_SETTINGS: GcsToolSettings = {
  capabilities: [GcsCapability.READ_ONLY],
};
