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
 * Capabilities indicating what type of operations are allowed for GCS tools.
 *
 * The string values cross the boundary between the ADK SDKs, so they are the
 * same as adk-python's `Capabilities`.
 */
export enum Capabilities {
  /** Only read operations are allowed. */
  READ_ONLY = 'read_only',
  /** Both read and write operations are allowed. */
  READ_WRITE = 'read_write',
}

/** Settings for GCS tools. */
export interface GcsToolSettings {
  /**
   * Allowed capabilities for GCS tools.
   *
   * By default, tools allow only read operations. This behaviour may change in
   * future versions.
   */
  capabilities: Capabilities[];
}

/** The capabilities a caller gets when they name none. */
export const DEFAULT_GCS_CAPABILITIES: readonly Capabilities[] = [
  Capabilities.READ_ONLY,
];

/**
 * Creates {@link GcsToolSettings} with the adk-python defaults.
 *
 * Default applied when the field is absent from `params`:
 * - `capabilities` → `[Capabilities.READ_ONLY]`
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
