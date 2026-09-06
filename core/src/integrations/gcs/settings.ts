/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';

/**
 * What kind of Cloud Storage operations a {@link GcsToolset} or a
 * {@link GcsAdminToolset} may expose.
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

/**
 * The upstream name of {@link GcsCapability}.
 *
 * `GcsToolset` and the settings port arrived separately and named one enum two
 * ways. Both names stay, so both barrels keep the export they declare.
 */
export {GcsCapability as Capabilities};

/** Settings for GCS tools. */
export interface GcsToolSettings {
  /**
   * Allowed capabilities for GCS tools.
   *
   * By default, tools allow only read operations. This behaviour may change in
   * future versions.
   */
  capabilities: GcsCapability[];
}

/** The capabilities a caller gets when they name none. */
export const DEFAULT_GCS_CAPABILITIES: readonly GcsCapability[] = [
  GcsCapability.READ_ONLY,
];

/**
 * Creates {@link GcsToolSettings} with the adk-python defaults.
 *
 * Default applied when the field is absent from `params`:
 * - `capabilities` → `[GcsCapability.READ_ONLY]`
 *
 * @param params Optional partial {@link GcsToolSettings} overriding defaults.
 * @returns A merged {@link GcsToolSettings} object.
 * @throws {Error} When the `GCS_TOOL_SETTINGS` feature is disabled.
 */
export function createGcsToolSettings(
  params: Partial<GcsToolSettings> = {},
): GcsToolSettings {
  if (!isFeatureEnabled(FeatureName.GCS_TOOL_SETTINGS)) {
    throw new Error(`Feature ${FeatureName.GCS_TOOL_SETTINGS} is not enabled.`);
  }
  // An empty list is a caller decision meaning "no operations permitted", so
  // only an absent field takes the default.
  return {capabilities: params.capabilities ?? [...DEFAULT_GCS_CAPABILITIES]};
}

/**
 * The settings a toolset built without any uses.
 *
 * Read-only, so an agent cannot create, change or delete a bucket unless its
 * author asked for that. This default may change in a future version.
 *
 * {@link createGcsToolSettings} builds the same value, but only once the
 * `GCS_TOOL_SETTINGS` feature is enabled. {@link GcsAdminToolset} needs a
 * default that is always available, so it reads this constant instead.
 */
export const DEFAULT_GCS_TOOL_SETTINGS: GcsToolSettings = {
  capabilities: [...DEFAULT_GCS_CAPABILITIES],
};
