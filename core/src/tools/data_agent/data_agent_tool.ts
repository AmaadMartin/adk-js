/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {formatError} from '../../utils/error_utils.js';
import {asRecord} from '../../utils/object_utils.js';

import {DataAgentToolConfig, DEFAULT_MAX_QUERY_RESULT_ROWS} from './config.js';
import {DataAgentCredentialsConfig} from './credentials.js';
import {
  GDA_CLIENT_ID,
  GdaEndpointOptions,
  getGdaEndpoint,
  GLOBAL_LOCATION,
  readGdaStream,
  throwIfNotOk,
} from './gda_stream_utils.js';

/** The envelope every data agent tool returns. Never throws. */
export type DataAgentToolResult =
  | {status: 'SUCCESS'; response: unknown}
  | {status: 'ERROR'; errorDetails: string};

/** The non-model-facing collaborators each data agent tool needs. */
export interface DataAgentToolDeps {
  /** Resolves the authorization headers for each request. */
  credentials: DataAgentCredentialsConfig;
  /** Endpoint and result-size settings. */
  settings?: DataAgentToolConfig;
  /** The invoking tool context, needed for the external access token path. */
  toolContext?: Context;
}

/**
 * Extracts the location segment of a Google Cloud resource name.
 *
 * @param resourceName A resource name such as
 *     `projects/p/locations/eu/dataAgents/a`.
 * @return The location, or `undefined` when the name carries none.
 */
export function extractLocationFromResourceName(
  resourceName: string,
): string | undefined {
  const parts = resourceName.split('/');
  // The last segment cannot be a location: it would have no value after it.
  const index = parts.slice(0, -1).indexOf('locations');
  return index === -1 ? undefined : parts[index + 1];
}

/**
 * Resolves the endpoint options for a call that targets one data agent. The
 * resource name supplies the location only when the settings pin neither a
 * location nor a custom endpoint.
 */
function resolveEndpointOptions(
  dataAgentName: string,
  settings?: DataAgentToolConfig,
): GdaEndpointOptions {
  const {location, apiEndpoint} = settings ?? {};
  if (!location && !apiEndpoint) {
    return {location: extractLocationFromResourceName(dataAgentName)};
  }
  return {location, apiEndpoint};
}

/**
 * Sends one authenticated request to the Gemini Data Analytics API and throws
 * when it fails. A request with a body is posted; one without is a GET.
 */
async function gdaFetch(
  url: string,
  deps: DataAgentToolDeps,
  body?: string,
): Promise<Response> {
  const headers = await deps.credentials.getRequestHeaders(
    url,
    deps.toolContext,
  );
  headers.set('Content-Type', 'application/json');
  headers.set('X-Goog-API-Client', GDA_CLIENT_ID);

  const response = await fetch(url, {
    method: body === undefined ? 'GET' : 'POST',
    body,
    headers,
  });
  throwIfNotOk(response, url);
  return response;
}

/**
 * Lists the data agents a project can reach.
 *
 * @param args The project to list agents in.
 * @param deps The credentials and settings for the call.
 * @return The `dataAgents` array on success, or the failure reason.
 */
export async function listAccessibleDataAgents(
  args: {projectId: string},
  deps: DataAgentToolDeps,
): Promise<DataAgentToolResult> {
  try {
    const endpoint = getGdaEndpoint(deps.settings);
    const location = deps.settings?.location || GLOBAL_LOCATION;
    const url =
      `${endpoint}/v1/projects/${args.projectId}` +
      `/locations/${location}/dataAgents:listAccessible`;

    const body: unknown = await (await gdaFetch(url, deps)).json();
    return {status: 'SUCCESS', response: asRecord(body)?.['dataAgents'] ?? []};
  } catch (e: unknown) {
    return {status: 'ERROR', errorDetails: formatError(e)};
  }
}

/**
 * Gets the details of one data agent.
 *
 * @param args The resource name of the agent.
 * @param deps The credentials and settings for the call.
 * @return The agent resource on success, or the failure reason.
 */
export async function getDataAgentInfo(
  args: {dataAgentName: string},
  deps: DataAgentToolDeps,
): Promise<DataAgentToolResult> {
  try {
    const endpoint = getGdaEndpoint(
      resolveEndpointOptions(args.dataAgentName, deps.settings),
    );
    const url = `${endpoint}/v1/${args.dataAgentName}`;

    const response: unknown = await (await gdaFetch(url, deps)).json();
    return {status: 'SUCCESS', response};
  } catch (e: unknown) {
    return {status: 'ERROR', errorDetails: formatError(e)};
  }
}

/**
 * Asks a data agent a question and reads its streamed answer.
 *
 * @param args The resource name of the agent and the natural-language query.
 * @param deps The credentials and settings for the call.
 * @return The agent's messages on success, or the failure reason.
 */
export async function askDataAgent(
  args: {dataAgentName: string; query: string},
  deps: DataAgentToolDeps,
): Promise<DataAgentToolResult> {
  try {
    const endpoint = getGdaEndpoint(
      resolveEndpointOptions(args.dataAgentName, deps.settings),
    );

    const agentInfo = await getDataAgentInfo(args, deps);
    if (agentInfo.status === 'ERROR') {
      return agentInfo;
    }

    const parent = args.dataAgentName.split('/').slice(0, -2).join('/');
    const response = await gdaFetch(
      `${endpoint}/v1/${parent}:chat`,
      deps,
      JSON.stringify({
        messages: [{userMessage: {text: args.query}}],
        dataAgentContext: {dataAgent: args.dataAgentName},
        clientIdEnum: GDA_CLIENT_ID,
      }),
    );

    return {
      status: 'SUCCESS',
      response: await readGdaStream(
        response,
        deps.settings?.maxQueryResultRows ?? DEFAULT_MAX_QUERY_RESULT_ROWS,
      ),
    };
  } catch (e: unknown) {
    return {status: 'ERROR', errorDetails: formatError(e)};
  }
}
