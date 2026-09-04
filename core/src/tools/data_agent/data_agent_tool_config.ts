/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {InputValidationError} from '../../errors/input_validation_error.js';

const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;
const DEFAULT_DATA_AGENT_MODIFICATION_TIMEOUT_SECONDS = 60;
const DEFAULT_DATA_AGENT_MODIFICATION_POLL_INTERVAL_SECONDS = 2;

/** Configuration for Data Agent tools. */
export interface DataAgentToolConfig {
  /** Maximum number of rows a query result returns. Defaults to `50`. */
  maxQueryResultRows: number;

  /**
   * Google Cloud location of the data agent, such as `eu`, `us` or `global`.
   *
   * When absent, a tool derives the location from the data agent resource
   * name. A location named on the tool call outranks this value.
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
   * Seconds a tool waits for a data agent mutation to finish before it
   * abandons the operation. Must be positive. Defaults to `60`.
   */
  dataAgentModificationTimeoutSeconds: number;

  /**
   * Seconds between two polls of a running data agent mutation. Must be
   * positive. Defaults to `2`.
   */
  dataAgentModificationPollIntervalSeconds: number;

  /**
   * Whether the toolset may create, update and delete data agent resources.
   * Defaults to `false`, so a read-only toolset stays read-only.
   */
  enableDataAgentModification: boolean;
}

// The schema carries the defaults and rejects unknown keys, which is what
// adk-python's `extra='forbid'` model does. It stays module-private: the type
// and the factory are the public surface.
const dataAgentToolConfigSchema = z.strictObject({
  maxQueryResultRows: z.number().int().default(DEFAULT_MAX_QUERY_RESULT_ROWS),
  location: z.string().optional(),
  apiEndpoint: z.string().optional(),
  dataAgentModificationTimeoutSeconds: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_DATA_AGENT_MODIFICATION_TIMEOUT_SECONDS),
  dataAgentModificationPollIntervalSeconds: z
    .number()
    .int()
    .positive()
    .default(DEFAULT_DATA_AGENT_MODIFICATION_POLL_INTERVAL_SECONDS),
  enableDataAgentModification: z.boolean().default(false),
});

/**
 * Creates a {@link DataAgentToolConfig} with default values.
 *
 * A row cap of zero or less is stored verbatim, matching adk-python, which
 * constrains the two mutation timers and not the row cap.
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
  return result.data;
}
