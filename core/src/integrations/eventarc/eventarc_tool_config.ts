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

/**
 * Default publish timeout, in seconds.
 *
 * The unit is seconds, matching adk-python's `publish_timeout: float = 15.0`.
 * A caller that forwards this to `google-gax` must multiply by 1000, because
 * `CallOptions.timeout` is milliseconds.
 */
export const EVENTARC_DEFAULT_PUBLISH_TIMEOUT_SECONDS = 15.0;

/** Fields accepted by {@link createEventarcToolConfig}. */
export interface EventarcToolConfigParams {
  /** Optional project ID for telemetry and API calls. */
  projectId?: string;
  /**
   * Timeout in seconds for publishing messages. Defaults to
   * {@link EVENTARC_DEFAULT_PUBLISH_TIMEOUT_SECONDS}.
   */
  publishTimeout?: number;
}

/** Configuration for the Eventarc tool. */
export interface EventarcToolConfig {
  /** Optional project ID for telemetry and API calls. */
  projectId?: string;
  /** Timeout in seconds for publishing messages. */
  publishTimeout: number;
}

// Unknown keys are dropped, not rejected. adk-python's model leaves pydantic's
// `extra` at its default `'ignore'`, so this deliberately uses `z.object`
// where the neighbouring Pub/Sub config uses `z.strictObject`.
const eventarcToolConfigSchema = z.object({
  projectId: z.string().optional(),
  publishTimeout: z.number().default(EVENTARC_DEFAULT_PUBLISH_TIMEOUT_SECONDS),
});

/**
 * Creates an {@link EventarcToolConfig}.
 *
 * @param params Optional {@link EventarcToolConfigParams} fields.
 * @returns A validated {@link EventarcToolConfig}.
 * @throws {Error} When the `EVENTARC_TOOL_CONFIG` feature is disabled.
 * @throws {InputValidationError} When `projectId` is not a string, or
 *     `publishTimeout` is not a number.
 */
export function createEventarcToolConfig(
  params: EventarcToolConfigParams = {},
): EventarcToolConfig {
  if (!isFeatureEnabled(FeatureName.EVENTARC_TOOL_CONFIG)) {
    throw new Error(
      `Feature ${FeatureName.EVENTARC_TOOL_CONFIG} is not enabled.`,
    );
  }
  const result = eventarcToolConfigSchema.safeParse(params);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid EventarcToolConfig: ${z.prettifyError(result.error)}`,
    );
  }
  return {
    projectId: result.data.projectId,
    publishTimeout: result.data.publishTimeout,
  };
}
