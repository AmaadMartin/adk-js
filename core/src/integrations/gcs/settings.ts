/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What kind of Cloud Storage operations a {@link GcsToolset} may expose.
 *
 * The string values cross the language boundary and match adk-python's
 * `Capabilities` enum exactly.
 */
export enum GcsCapability {
  /** Only read operations are allowed. */
  READ_ONLY = 'read_only',
  /** Both read and write operations are allowed. */
  READ_WRITE = 'read_write',
}

/** Settings for the Cloud Storage tools. */
export interface GcsToolSettings {
  /**
   * Allowed capabilities for the Cloud Storage tools.
   *
   * Defaults to `[GcsCapability.READ_ONLY]` when omitted, so a toolset built
   * with no settings never exposes a write tool. This default may change in
   * future versions.
   */
  capabilities?: GcsCapability[];
}

/** The capabilities a toolset uses when the caller supplies none. */
export const DEFAULT_GCS_CAPABILITIES: GcsCapability[] = [
  GcsCapability.READ_ONLY,
];
