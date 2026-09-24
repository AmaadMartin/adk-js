/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** What a Cloud Storage tool is allowed to do. */
export enum GcsCapability {
  /** Only read operations are allowed. */
  READ_ONLY = 'read_only',
  /** Both read and write operations are allowed. */
  READ_WRITE = 'read_write',
}

/** Settings shared by every Cloud Storage tool a toolset builds. */
export interface GcsToolSettings {
  /** The operations the tools may perform. */
  capabilities: GcsCapability[];
}

/**
 * The settings a toolset built without any uses.
 *
 * Read-only, so an agent cannot create, change or delete a bucket unless its
 * author asked for that. This default may change in a future version.
 */
export const DEFAULT_GCS_TOOL_SETTINGS: GcsToolSettings = {
  capabilities: [GcsCapability.READ_ONLY],
};
