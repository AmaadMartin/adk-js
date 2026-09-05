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
 * Capabilities indicating what type of operations the Cloud Storage tools are
 * allowed to perform.
 */
export enum Capabilities {
  /** Only read operations are allowed. */
  READ_ONLY = 'read_only',

  /** Both read and write operations are allowed. */
  READ_WRITE = 'read_write',
}

/** Settings for the Cloud Storage tools. */
export interface GcsToolSettings {
  /**
   * Allowed capabilities for the Cloud Storage tools. Defaults to
   * `[Capabilities.READ_ONLY]`.
   *
   * By default, the tools allow only read operations. This behaviour may
   * change in future versions. An empty array exposes no tool at all.
   */
  capabilities?: Capabilities[];
}

/**
 * Creates {@link GcsToolSettings} with the adk-python defaults.
 *
 * Default values applied when the corresponding field is absent from `params`:
 * - `capabilities` → `[Capabilities.READ_ONLY]`
 *
 * @param params Optional partial {@link GcsToolSettings}.
 * @return The settings with defaults applied.
 * @throws Error if the `GCS_TOOL_SETTINGS` feature is disabled.
 */
export function createGcsToolSettings(
  params: GcsToolSettings = {},
): Required<GcsToolSettings> {
  if (!isFeatureEnabled(FeatureName.GCS_TOOL_SETTINGS)) {
    throw new Error(`Feature ${FeatureName.GCS_TOOL_SETTINGS} is not enabled.`);
  }
  return {capabilities: params.capabilities ?? [Capabilities.READ_ONLY]};
}
