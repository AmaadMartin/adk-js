/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GdaEndpointOptions} from './gda_client.js';

/** Rows a query returns when the config names no limit. */
const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/** Seconds a mutation may take in total when the config names no timeout. */
const DEFAULT_MODIFICATION_TIMEOUT_SECONDS = 60;

/** Seconds between two polls when the config names no interval. */
const DEFAULT_MODIFICATION_POLL_INTERVAL_SECONDS = 2;

/**
 * How the data agent tools behave: where the agents live, how much data a
 * query may return, and whether the tools may change anything.
 */
export interface DataAgentToolConfig extends GdaEndpointOptions {
  /** Rows a query result may carry. Defaults to 50. */
  maxQueryResultRows?: number;
  /**
   * Seconds to wait in total for a create, update or delete to finish.
   * Defaults to 60. Must be greater than zero.
   */
  dataAgentModificationTimeoutSeconds?: number;
  /**
   * Seconds between two polls of a running create, update or delete.
   * Defaults to 2. Must be greater than zero.
   */
  dataAgentModificationPollIntervalSeconds?: number;
  /**
   * Whether the toolset may create, update and delete data agents. Defaults
   * to `false`, so a read-only toolset stays read-only.
   */
  enableDataAgentModification?: boolean;
}

/** A {@link DataAgentToolConfig} with every default filled in. */
export interface ResolvedDataAgentToolConfig extends GdaEndpointOptions {
  maxQueryResultRows: number;
  dataAgentModificationTimeoutSeconds: number;
  dataAgentModificationPollIntervalSeconds: number;
  enableDataAgentModification: boolean;
}

/** Rejects a timing field that would make the polling loop never run. */
function requirePositive(value: number, fieldName: string): number {
  if (!(value > 0)) {
    throw new Error(`${fieldName} must be greater than zero, got: ${value}`);
  }
  return value;
}

/**
 * Fills in the defaults a data agent toolset runs with.
 *
 * @param config The caller's configuration, if any.
 * @return The resolved configuration.
 * @throws Error if either timing field is zero or negative, matching the
 *   `gt=0` constraint adk-python puts on both.
 */
export function resolveDataAgentToolConfig(
  config: DataAgentToolConfig = {},
): ResolvedDataAgentToolConfig {
  return {
    location: config.location,
    apiEndpoint: config.apiEndpoint,
    maxQueryResultRows:
      config.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS,
    dataAgentModificationTimeoutSeconds: requirePositive(
      config.dataAgentModificationTimeoutSeconds ??
        DEFAULT_MODIFICATION_TIMEOUT_SECONDS,
      'dataAgentModificationTimeoutSeconds',
    ),
    dataAgentModificationPollIntervalSeconds: requirePositive(
      config.dataAgentModificationPollIntervalSeconds ??
        DEFAULT_MODIFICATION_POLL_INTERVAL_SECONDS,
      'dataAgentModificationPollIntervalSeconds',
    ),
    enableDataAgentModification: config.enableDataAgentModification ?? false,
  };
}
