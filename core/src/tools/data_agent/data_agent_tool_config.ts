/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../../errors/input_validation_error.js';

/** Rows a data agent query result returns when the caller names no cap. */
export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/** Seconds a data agent mutation may take before it is abandoned. */
export const DEFAULT_DATA_AGENT_MODIFICATION_TIMEOUT_SECONDS = 60;

/** Seconds between polls of a running data agent mutation. */
export const DEFAULT_DATA_AGENT_MODIFICATION_POLL_INTERVAL_SECONDS = 2;

/** Configuration for Data Agent tools. */
export interface DataAgentToolConfig {
  /**
   * Maximum number of rows a query result returns. Defaults to
   * {@link DEFAULT_MAX_QUERY_RESULT_ROWS}.
   */
  maxQueryResultRows: number;

  /**
   * Google Cloud location of the data agent, such as `eu`, `us` or `global`.
   *
   * When absent, the tool parses the location out of the data agent resource
   * name, and falls back to `global`. A location named on the tool call
   * outranks this value.
   */
  location?: string;

  /**
   * Gemini Data Analytics API endpoint to call.
   *
   * When present, it overrides the default endpoint and the endpoint derived
   * from {@link DataAgentToolConfig.location}.
   */
  apiEndpoint?: string;

  /**
   * Seconds the tool waits for a data agent mutation to finish before it
   * abandons the operation. Defaults to
   * {@link DEFAULT_DATA_AGENT_MODIFICATION_TIMEOUT_SECONDS}.
   */
  dataAgentModificationTimeoutSeconds: number;

  /**
   * Seconds between two polls of a running data agent mutation. Defaults to
   * {@link DEFAULT_DATA_AGENT_MODIFICATION_POLL_INTERVAL_SECONDS}.
   */
  dataAgentModificationPollIntervalSeconds: number;

  /**
   * Whether the toolset may create, update and delete data agent resources.
   * Defaults to `false`, so a read-only toolset stays read-only.
   */
  enableDataAgentModification: boolean;
}

// Unknown keys are rejected, which is what adk-python's `extra='forbid'`
// does. The schema stays module-private: the type and the factory are the
// public surface.
const dataAgentToolConfigSchema = z.strictObject({
  maxQueryResultRows: z.number().int().optional(),
  location: z.string().optional(),
  apiEndpoint: z.string().optional(),
  dataAgentModificationTimeoutSeconds: z.number().int().positive().optional(),
  dataAgentModificationPollIntervalSeconds: z
    .number()
    .int()
    .positive()
    .optional(),
  enableDataAgentModification: z.boolean().optional(),
});

/**
 * Creates a {@link DataAgentToolConfig} with default values.
 *
 * @param params Optional partial {@link DataAgentToolConfig} overriding
 *     defaults.
 * @returns A validated {@link DataAgentToolConfig}.
 * @throws {InputValidationError} When `params` carries an unknown key, a value
 *     of the wrong type, a non-integer number, or a non-positive timeout or
 *     poll interval.
 */
export function createDataAgentToolConfig(
  params: Partial<DataAgentToolConfig> = {},
): DataAgentToolConfig {
  const result = dataAgentToolConfigSchema.safeParse(params);
  if (!result.success) {
    throw new InputValidationError(
      `Invalid DataAgentToolConfig: ${z.prettifyError(result.error)}`,
    );
  }
  // A non-positive row cap is stored verbatim, matching adk-python, which
  // constrains the two mutation timers but not the row cap.
  return {
    maxQueryResultRows:
      result.data.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS,
    location: result.data.location,
    apiEndpoint: result.data.apiEndpoint,
    dataAgentModificationTimeoutSeconds:
      result.data.dataAgentModificationTimeoutSeconds ??
      DEFAULT_DATA_AGENT_MODIFICATION_TIMEOUT_SECONDS,
    dataAgentModificationPollIntervalSeconds:
      result.data.dataAgentModificationPollIntervalSeconds ??
      DEFAULT_DATA_AGENT_MODIFICATION_POLL_INTERVAL_SECONDS,
    enableDataAgentModification:
      result.data.enableDataAgentModification ?? false,
  };
}
