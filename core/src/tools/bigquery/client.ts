/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {BigQuery} from '@google-cloud/bigquery';

import {loadOptionalPeer} from '../../utils/optional_peer.js';

import {BigQueryCredentials} from './bigquery_credentials.js';

/** Identifies ADK's BigQuery tools to the BigQuery service. */
export const USER_AGENT = 'adk-bigquery-tool';

/** What {@link getBigQueryClient} needs to build a client. */
export interface BigQueryClientOptions {
  /** The Google Cloud project the client bills and scopes requests to. */
  projectId: string;
  /**
   * The end user's credential. When absent the client falls back to the
   * application default credentials of the process.
   */
  credentials?: BigQueryCredentials;
}

/**
 * Builds a BigQuery client, loading the `@google-cloud/bigquery` optional peer
 * dependency on first use.
 *
 * The credential is passed as an `authorized_user` credentials object rather
 * than as a pre-built auth client: `@google-cloud/bigquery` resolves
 * `google-auth-library` at a different major version from the one adk-js
 * pins, so the two client types are not interchangeable.
 *
 * @param options The project and the credential to authenticate with.
 * @return A BigQuery client.
 * @throws If `@google-cloud/bigquery` is not installed.
 */
export async function getBigQueryClient(
  options: BigQueryClientOptions,
): Promise<BigQuery> {
  const bigquery = await loadOptionalPeer(
    {packageName: '@google-cloud/bigquery', feature: 'BigQueryToolset'},
    () => import('@google-cloud/bigquery'),
  );

  return new bigquery.BigQuery({
    projectId: options.projectId,
    userAgent: USER_AGENT,
    credentials: options.credentials && {
      type: 'authorized_user',
      client_id: options.credentials.clientId,
      client_secret: options.credentials.clientSecret,
      refresh_token: options.credentials.refreshToken,
    },
  });
}
