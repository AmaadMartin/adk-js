/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../../errors/input_validation_error.js';
import {
  FeatureName,
  isFeatureEnabled,
} from '../../features/feature_registry.js';

/** Configuration for Pub/Sub tools. */
export interface PubSubToolConfig {
  /**
   * GCP project ID to use for the Pub/Sub operations.
   *
   * When absent, the project ID is inferred from the environment or the
   * credentials.
   */
  projectId?: string;
}

// Unknown keys are rejected, which is what adk-python's `extra='forbid'`
// does. The schema stays module-private: the type and the factory are the
// public surface.
const pubSubToolConfigSchema = z.strictObject({
  projectId: z.string().optional(),
});

/**
 * Creates a {@link PubSubToolConfig}.
 *
 * @param params Optional {@link PubSubToolConfig} fields.
 * @returns A validated {@link PubSubToolConfig}.
 * @throws {Error} When the `PUBSUB_TOOL_CONFIG` feature is disabled.
 * @throws {InputValidationError} When `params` carries an unknown key, or
 *     `projectId` is not a string.
 */
export function createPubSubToolConfig(
  params: PubSubToolConfig = {},
): PubSubToolConfig {
  if (!isFeatureEnabled(FeatureName.PUBSUB_TOOL_CONFIG)) {
    throw new Error(
      `Feature ${FeatureName.PUBSUB_TOOL_CONFIG} is not enabled.`,
    );
  }
  const result = pubSubToolConfigSchema.safeParse(params);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid PubSubToolConfig: ${z.prettifyError(result.error)}`,
    );
  }
  return {projectId: result.data.projectId};
}
