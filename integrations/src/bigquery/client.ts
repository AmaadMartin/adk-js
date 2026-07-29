/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQuery, BigQueryOptions} from '@google-cloud/bigquery';

import {BigQueryToolConfig} from './bigquery_config.js';
import {BigQueryCredentialsConfig} from './bigquery_credentials.js';

/** Prefix used to attribute BigQuery API traffic to the ADK BigQuery tools. */
const USER_AGENT_PREFIX = 'adk-bigquery';

export function getBigQueryClient(
  project?: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  settings?: BigQueryToolConfig,
  callerName?: string,
): BigQuery {
  const options: BigQueryOptions = {
    projectId: project || credentialsConfig?.projectId,
    keyFilename: credentialsConfig?.keyFilename,
    credentials: credentialsConfig?.credentials,
    userAgent: callerName
      ? `${USER_AGENT_PREFIX}/${callerName}`
      : USER_AGENT_PREFIX,
  };

  if (settings?.location) {
    options.location = settings.location;
  }

  return new BigQuery(options);
}
