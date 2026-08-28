/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQuery, BigQueryOptions} from '@google-cloud/bigquery';

import {version} from '../version.js';

/** The user agent every BigQuery API call from ADK starts with. */
export const BQ_USER_AGENT = `adk-bigquery-tool google-adk/${version}`;

/** What {@link getBigQueryClient} needs to reach the BigQuery API. */
export interface BigQueryClientOptions {
  /** The project the call runs and bills in. */
  project: string;
  /**
   * The auth client the call uses. When it is undefined, the BigQuery client
   * resolves Application Default Credentials.
   */
  authClient?: BigQueryOptions['authClient'];
  /** The BigQuery location, when the toolset pins one. */
  location?: string;
  /**
   * Extra user-agent parts, appended after {@link BQ_USER_AGENT} in order. An
   * undefined or empty part is dropped, so a caller can pass an optional
   * setting straight through.
   */
  userAgent?: Array<string | undefined>;
}

/**
 * Builds a BigQuery client that identifies itself as ADK.
 *
 * @param options The project, credentials, location and extra user agents.
 * @return The client, stamped with the ADK user agent.
 */
export function getBigQueryClient(options: BigQueryClientOptions): BigQuery {
  return new BigQuery({
    projectId: options.project,
    authClient: options.authClient,
    location: options.location,
    userAgent: [BQ_USER_AGENT, ...(options.userAgent ?? [])]
      .filter((part): part is string => Boolean(part))
      .join(' '),
  });
}
