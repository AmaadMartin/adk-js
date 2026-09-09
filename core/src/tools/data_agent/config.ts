/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {GdaEndpointOptions} from './gda_stream_utils.js';

/** Rows returned from a data agent query result when nothing else is set. */
export const DEFAULT_MAX_QUERY_RESULT_ROWS = 50;

/**
 * Settings shared by every tool in the data agent toolset.
 *
 * The inherited `location` and `apiEndpoint` select the Gemini Data Analytics
 * host. A `location` left unset is parsed from the data agent resource name
 * and falls back to `global`.
 */
export interface DataAgentToolConfig extends GdaEndpointOptions {
  /**
   * Maximum number of rows returned from a query result. Defaults to
   * {@link DEFAULT_MAX_QUERY_RESULT_ROWS}.
   */
  maxQueryResultRows?: number;
}
