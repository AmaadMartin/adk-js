/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {BigQuery, BigQueryOptions} from '@google-cloud/bigquery';
import {CatalogServiceClient} from '@google-cloud/dataplex';
import {Context} from '../../agents/context.js';
import {BigQueryToolConfig} from './config.js';
import {BIGQUERY_SCOPES, BigQueryCredentialsConfig} from './credentials.js';

const USER_AGENT_BASE = 'google-adk-js';
const BQ_USER_AGENT = `adk-bigquery-tool ${USER_AGENT_BASE}`;
const DP_USER_AGENT = `adk-dataplex-tool ${USER_AGENT_BASE}`;

/**
 * Get a BigQuery client.
 */
export async function getBigQueryClient(
  projectId: string,
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: Partial<BigQueryToolConfig>,
  context?: Context,
): Promise<BigQuery> {
  const options: BigQueryOptions = {
    projectId: projectId,
  };

  if (toolConfig?.location) {
    options.location = toolConfig.location;
  }

  const userAgents = [BQ_USER_AGENT];
  if (toolConfig?.applicationName) {
    userAgents.push(toolConfig.applicationName);
  }
  options.userAgent = userAgents.join(' ');

  if (credentialsConfig) {
    if (credentialsConfig.credentials) {
      options.credentials = credentialsConfig.credentials;
    } else if (credentialsConfig.externalAccessTokenKey && context) {
      const token = context.state.get<string>(
        credentialsConfig.externalAccessTokenKey,
      );
      if (token) {
        (options as Record<string, unknown>).token = token;
      } else {
        throw new Error(
          `externalAccessTokenKey is provided but no access token found in toolContext.state with key ${credentialsConfig.externalAccessTokenKey}.`,
        );
      }
    } else if (
      credentialsConfig.clientId &&
      credentialsConfig.clientSecret &&
      context
    ) {
      const creds = await handleOAuthFlow(credentialsConfig, context);
      if (creds) {
        (options as Record<string, unknown>).token = creds.token;
      } else {
        throw new Error(
          'User authorization is required to access Google services. Authorization flow in progress.',
        );
      }
    }
  }

  return new BigQuery(options);
}

/**
 * Get a Dataplex CatalogServiceClient.
 */
export async function getDataplexClient(
  credentialsConfig?: BigQueryCredentialsConfig,
  toolConfig?: Partial<BigQueryToolConfig>,
  context?: Context,
): Promise<CatalogServiceClient> {
  const options = {} as NonNullable<
    ConstructorParameters<typeof CatalogServiceClient>[0]
  >;

  const userAgents = [DP_USER_AGENT];
  if (toolConfig?.applicationName) {
    userAgents.push(toolConfig.applicationName);
  }
  options.userAgent = userAgents.join(' ');

  if (credentialsConfig) {
    if (credentialsConfig.credentials) {
      options.credentials = credentialsConfig.credentials;
    } else if (credentialsConfig.externalAccessTokenKey && context) {
      const token = context.state.get<string>(
        credentialsConfig.externalAccessTokenKey,
      );
      if (token) {
        options.token = token;
      } else {
        throw new Error(
          `externalAccessTokenKey is provided but no access token found in toolContext.state with key ${credentialsConfig.externalAccessTokenKey}.`,
        );
      }
    } else if (
      credentialsConfig.clientId &&
      credentialsConfig.clientSecret &&
      context
    ) {
      const creds = await handleOAuthFlow(credentialsConfig, context);
      if (creds) {
        options.token = creds.token;
      } else {
        throw new Error(
          'User authorization is required to access Google services. Authorization flow in progress.',
        );
      }
    }
  }

  return new CatalogServiceClient(options);
}

async function handleOAuthFlow(
  config: BigQueryCredentialsConfig,
  context: Context,
): Promise<{token: string} | undefined> {
  const scopes = config.scopes || BIGQUERY_SCOPES;

  const authScheme = {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://accounts.google.com/o/oauth2/auth',
        tokenUrl: 'https://oauth2.googleapis.com/token',
        scopes: Object.fromEntries(scopes.map((s) => [s, `Access to ${s}`])),
      },
    },
  };

  const rawAuthCredential = {
    authType: 'oauth2',
    oauth2: {
      clientId: config.clientId,
      clientSecret: config.clientSecret,
    },
  };

  const authConfig = {
    authScheme,
    rawAuthCredential,
    credentialKey: 'bigquery_oauth',
  };

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const response = context.getAuthResponse(authConfig as any);
  if (response && response.oauth2?.accessToken) {
    return {token: response.oauth2.accessToken};
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  context.requestCredential(authConfig as any);
  return undefined;
}
