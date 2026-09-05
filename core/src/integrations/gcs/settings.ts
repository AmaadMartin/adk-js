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
