/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';
import {Context} from '../../agents/context.js';
import {formatError} from '../../utils/error_utils.js';
import {isRecord} from '../../utils/object_utils.js';
import {BaseTool} from '../base_tool.js';
import {FunctionTool, ToolExecuteArgument} from '../function_tool.js';
import {ResolvedDataAgentToolConfig} from './config.js';
import {DataAgentCredentialsManager} from './credentials.js';
import {
  createGdaSession,
  GDA_CLIENT_ID,
  GDA_REQUEST_TIMEOUT_SECONDS,
  GdaEndpointOptions,
  gdaHeaders,
  GdaResponse,
  GdaSession,
  GdaSessionFactory,
  GLOBAL_LOCATION,
  resolveGdaEndpoint,
  streamChat,
} from './gda_client.js';
import {awaitLro, Clock, systemClock} from './lro.js';
import {DataAgentToolError, DataAgentToolResult} from './tool_result.js';

/** One resource-name segment: the character class the API accepts. */
const SEGMENT = '[a-zA-Z0-9][a-zA-Z0-9_.-]*';

/**
 * A full data agent resource name. JavaScript anchors `^` and `$` to the whole
 * string without the `m` flag, which is what adk-python spells `\A`/`\Z` so a
 * trailing newline is rejected.
 */
const DATA_AGENT_NAME_PATTERN = new RegExp(
  `^projects/${SEGMENT}/locations/${SEGMENT}/dataAgents/${SEGMENT}$`,
);

const SEGMENT_PATTERN = new RegExp(`^${SEGMENT}$`);

/** What one data agent tool call needs beyond its model-supplied arguments. */
export interface DataAgentToolDeps {
  /** Opens an authorized session against the host the settings select. */
  openSession: GdaSessionFactory;
  /** The resolved toolset configuration. */
  settings: ResolvedDataAgentToolConfig;
  /** Drives the mutation polling loop. Defaults to the system clock. */
  clock?: Clock;
}

/**
 * Rejects a resource name that is not a data agent.
 *
 * @param dataAgentName The name to check.
 * @return The error to return to the model, or `undefined` when it is valid.
 */
export function validateDataAgentName(
  dataAgentName: string,
): DataAgentToolError | undefined {
  if (DATA_AGENT_NAME_PATTERN.test(dataAgentName)) {
    return undefined;
  }
  return {
    status: 'ERROR',
    error_details:
      'Invalid data_agent_name format. Expected format:' +
      ' projects/{project}/locations/{location}/dataAgents/{agent},' +
      ` got: '${dataAgentName}'`,
  };
}

/**
 * Rejects a value that cannot be interpolated into a URL path.
 *
 * @param value The value to check.
 * @param fieldName The field to name in the message.
 * @return The error to return to the model, or `undefined` when it is valid.
 */
export function validatePathSegment(
  value: string,
  fieldName: string,
): DataAgentToolError | undefined {
  if (SEGMENT_PATTERN.test(value)) {
    return undefined;
  }
  return {
    status: 'ERROR',
    error_details:
      `Invalid ${fieldName} format. Expected alphanumeric characters,` +
      ` hyphens, underscores, or periods, got: '${value}'`,
  };
}

/**
 * Reads the location out of a resource name.
 *
 * The last segment is excluded, so a name that ends in `locations` yields
 * nothing rather than reading past the end.
 *
 * @param resourceName The resource name to scan.
 * @return The location, or `undefined` when the name carries none.
 */
export function extractLocationFromResourceName(
  resourceName: string,
): string | undefined {
  const parts = resourceName.split('/');
  for (let i = 0; i < parts.length - 1; i++) {
    if (parts[i] === 'locations') {
      return parts[i + 1];
    }
  }
  return undefined;
}

/** Refuses a mutation the toolset was not configured to allow. */
function modificationDisabledError(
  settings: ResolvedDataAgentToolConfig,
): DataAgentToolError | undefined {
  if (settings.enableDataAgentModification) {
    return undefined;
  }
  return {
    status: 'ERROR',
    error_details:
      'Data agent mutation is disabled. Enable it by setting ' +
      '`enable_data_agent_modification=True` in DataAgentToolConfig.',
  };
}

/** The JSON type name to report for a value the API cannot accept. */
function typeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  return Array.isArray(value) ? 'array' : typeof value;
}

/**
 * Reads an agent config the model sent as a JSON string.
 *
 * The tool schemas declare `agent_config` as a plain string on purpose: a
 * `string | object` union emits an `anyOf` with a property-less object, which
 * the backend rejects. An object still arrives here from a programmatic
 * caller or a middleware that pre-parses tool arguments, so it is accepted.
 *
 * @param agentConfig The JSON string, or the object a caller already parsed.
 * @return The parsed config.
 * @throws Error if the value is not JSON, or is not a JSON object.
 */
export function parseAgentConfig(
  agentConfig: string | object,
): Record<string, unknown> {
  let parsed: unknown = agentConfig;
  if (typeof agentConfig === 'string') {
    try {
      parsed = JSON.parse(agentConfig);
    } catch (err: unknown) {
      throw new Error(`Invalid agent_config: ${formatError(err)}`);
    }
  }
  if (!isRecord(parsed)) {
    throw new Error(
      'Invalid agent_config: agent_config must be a dictionary or a JSON' +
        ` string representing a dictionary, got ${typeName(parsed)}`,
    );
  }
  return parsed;
}

/** Whether a dot-separated field path is present in a config. */
function maskFieldPresent(
  config: Record<string, unknown>,
  field: string,
): boolean {
  let node: unknown = config;
  for (const part of field.split('.')) {
    if (!isRecord(node) || !Object.hasOwn(node, part)) {
      return false;
    }
    node = node[part];
  }
  return true;
}

/** Builds the endpoint options a request runs against, dropping empty ones. */
function endpointOptions(
  location: string | undefined,
  apiEndpoint: string | undefined,
): GdaEndpointOptions {
  const options: GdaEndpointOptions = {};
  if (location) {
    options.location = location;
  }
  if (apiEndpoint) {
    options.apiEndpoint = apiEndpoint;
  }
  return options;
}

/** Turns a non-2xx read into a throw, so the tool's guard reports it. */
function raiseForStatus(response: GdaResponse): void {
  if (!response.ok) {
    throw new Error(
      `API returned error status: ${response.status} ${response.text}`,
    );
  }
}

/** One create, update or delete, and the operation it starts. */
interface MutateOptions {
  /** Builds the request URL from the API root. */
  buildUrl(baseUrl: string): string;
  method: 'POST' | 'PATCH' | 'DELETE';
  deps: DataAgentToolDeps;
  /** The location the request runs against, if it is not the configured one. */
  location?: string;
  params?: Record<string, string>;
  body?: unknown;
}

/** Issues a mutation and waits for its operation to finish. */
async function mutateDataAgent(
  options: MutateOptions,
): Promise<DataAgentToolResult> {
  const {buildUrl, method, deps, location, params, body} = options;
  const {settings} = deps;
  const clock = deps.clock ?? systemClock;

  // All three callers resolve a location before they get here, so the
  // fallback only guards a caller that does not. It matches adk-python's
  // `loc = location or settings.location`.
  const {session, endpoint} = await deps.openSession(
    endpointOptions(location ?? settings.location, settings.apiEndpoint),
  );
  const baseUrl = `${endpoint}/v1`;
  const totalTimeoutSeconds = settings.dataAgentModificationTimeoutSeconds;
  const deadline = clock.now() + totalTimeoutSeconds;

  const response = await session.request({
    method,
    url: buildUrl(baseUrl),
    headers: gdaHeaders(),
    timeoutSeconds: Math.min(
      GDA_REQUEST_TIMEOUT_SECONDS,
      Math.max(0, deadline - clock.now()),
    ),
    params,
    body,
  });

  return awaitLro({
    session,
    baseUrl,
    headers: gdaHeaders(),
    response,
    deadline,
    pollIntervalSeconds: settings.dataAgentModificationPollIntervalSeconds,
    totalTimeoutSeconds,
    clock,
  });
}

/** Arguments {@link listAccessibleDataAgents} takes. */
export interface ListAccessibleDataAgentsArgs {
  projectId: string;
  location?: string;
}

/**
 * Lists the data agents a project can see.
 *
 * @param args The project, and the location to look in.
 * @param deps The session factory and the resolved settings.
 * @return The data agents, or the reason the call failed.
 */
export async function listAccessibleDataAgents(
  args: ListAccessibleDataAgentsArgs,
  deps: DataAgentToolDeps,
): Promise<DataAgentToolResult> {
  const {settings} = deps;
  try {
    const location = args.location ?? settings.location ?? GLOBAL_LOCATION;
    const invalid =
      validatePathSegment(args.projectId, 'project_id') ??
      validatePathSegment(location, 'location');
    if (invalid) {
      return invalid;
    }

    const {session, endpoint} = await deps.openSession(
      endpointOptions(location, settings.apiEndpoint),
    );
    const response = await session.request({
      method: 'GET',
      url: `${endpoint}/v1/projects/${args.projectId}/locations/${location}/dataAgents:listAccessible`,
      headers: gdaHeaders(),
      timeoutSeconds: GDA_REQUEST_TIMEOUT_SECONDS,
    });
    raiseForStatus(response);
    const body: unknown = JSON.parse(response.text);
    const agents = isRecord(body) ? body['dataAgents'] : undefined;
    return {status: 'SUCCESS', response: agents ?? []};
  } catch (err: unknown) {
    return {status: 'ERROR', error_details: formatError(err)};
  }
}

/**
 * Reads one data agent, optionally over a session the caller already opened.
 *
 * `ask_data_agent` passes its own session so the preflight read and the chat
 * request share one connection.
 *
 * @param dataAgentName The resource name to read.
 * @param deps The session factory and the resolved settings.
 * @param session A session to reuse instead of opening one.
 * @return The data agent, or the reason the call failed.
 */
export async function getDataAgentInfo(
  dataAgentName: string,
  deps: DataAgentToolDeps,
  session?: GdaSession,
): Promise<DataAgentToolResult> {
  const {settings} = deps;
  try {
    const location =
      extractLocationFromResourceName(dataAgentName) ?? settings.location;
    const options = endpointOptions(location, settings.apiEndpoint);
    const url = `${resolveGdaEndpoint(options)}/v1/${dataAgentName}`;
    const active = session ?? (await deps.openSession(options)).session;
    const response = await active.request({
      method: 'GET',
      url,
      headers: gdaHeaders(),
      timeoutSeconds: GDA_REQUEST_TIMEOUT_SECONDS,
    });
    raiseForStatus(response);
    return {status: 'SUCCESS', response: JSON.parse(response.text)};
  } catch (err: unknown) {
    return {status: 'ERROR', error_details: formatError(err)};
  }
}

/** Arguments {@link askDataAgent} takes. */
export interface AskDataAgentArgs {
  dataAgentName: string;
  query: string;
}

/**
 * Asks a data agent a question and collects its streamed answer.
 *
 * The data agent is read first: a name the API rejects must not reach the
 * chat endpoint, so that read's error is returned unchanged.
 *
 * @param args The data agent to ask, and the question.
 * @param deps The session factory and the resolved settings.
 * @return The streamed messages, or the reason the call failed.
 */
export async function askDataAgent(
  args: AskDataAgentArgs,
  deps: DataAgentToolDeps,
): Promise<DataAgentToolResult> {
  const {settings} = deps;
  try {
    let location = settings.location;
    if (!location && !settings.apiEndpoint) {
      location = extractLocationFromResourceName(args.dataAgentName);
    }

    const {session, endpoint} = await deps.openSession(
      endpointOptions(location, settings.apiEndpoint),
    );
    const agentInfo = await getDataAgentInfo(args.dataAgentName, deps, session);
    if (agentInfo.status === 'ERROR') {
      return agentInfo;
    }

    const parent = args.dataAgentName.split('/').slice(0, -2).join('/');
    const messages = await streamChat(
      session,
      `${endpoint}/v1/${parent}:chat`,
      {
        messages: [{userMessage: {text: args.query}}],
        dataAgentContext: {dataAgent: args.dataAgentName},
        clientIdEnum: GDA_CLIENT_ID,
      },
      gdaHeaders(),
      settings.maxQueryResultRows,
    );
    return {status: 'SUCCESS', response: messages};
  } catch (err: unknown) {
    return {status: 'ERROR', error_details: formatError(err)};
  }
}

/** Arguments {@link createDataAgent} takes. */
export interface CreateDataAgentArgs {
  projectId: string;
  dataAgentId: string;
  agentConfig: string | object;
  location?: string;
}

/**
 * Creates a data agent and waits for the operation to finish.
 *
 * @param args The project, the new id, the config, and the location.
 * @param deps The session factory and the resolved settings.
 * @return The created data agent, or the reason the call failed.
 */
export async function createDataAgent(
  args: CreateDataAgentArgs,
  deps: DataAgentToolDeps,
): Promise<DataAgentToolResult> {
  const {settings} = deps;
  try {
    const disabled = modificationDisabledError(settings);
    if (disabled) {
      return disabled;
    }

    const location = args.location ?? settings.location ?? GLOBAL_LOCATION;
    const invalid =
      validatePathSegment(args.projectId, 'project_id') ??
      validatePathSegment(location, 'location') ??
      validatePathSegment(args.dataAgentId, 'data_agent_id');
    if (invalid) {
      return invalid;
    }

    const config = parseAgentConfig(args.agentConfig);
    return await mutateDataAgent({
      buildUrl: (baseUrl) =>
        `${baseUrl}/projects/${args.projectId}/locations/${location}/dataAgents`,
      method: 'POST',
      deps,
      location,
      params: {dataAgentId: args.dataAgentId},
      body: config,
    });
  } catch (err: unknown) {
    return {status: 'ERROR', error_details: formatError(err)};
  }
}

/** Arguments {@link updateDataAgent} takes. */
export interface UpdateDataAgentArgs {
  dataAgentName: string;
  agentConfig: string | object;
  updateMask: string;
}

/**
 * Patches a data agent under an update mask and waits for the operation.
 *
 * Every masked field must be present in the config: the API clears a masked
 * field the body omits, which silently destroys data the caller forgot to
 * send.
 *
 * @param args The data agent, the new config, and the fields to change.
 * @param deps The session factory and the resolved settings.
 * @return The updated data agent, or the reason the call failed.
 */
export async function updateDataAgent(
  args: UpdateDataAgentArgs,
  deps: DataAgentToolDeps,
): Promise<DataAgentToolResult> {
  const {settings} = deps;
  try {
    const disabled = modificationDisabledError(settings);
    if (disabled) {
      return disabled;
    }

    const invalidName = validateDataAgentName(args.dataAgentName);
    if (invalidName) {
      return invalidName;
    }

    const fields = args.updateMask
      .split(',')
      .map((field) => field.trim())
      .filter((field) => field.length > 0);
    if (fields.length === 0) {
      return {
        status: 'ERROR',
        error_details:
          'update_mask must be a non-empty comma-separated list of fields,' +
          ' e.g. "displayName,description".',
      };
    }

    const config = parseAgentConfig(args.agentConfig);
    const missing = fields.filter((field) => !maskFieldPresent(config, field));
    if (missing.length > 0) {
      return {
        status: 'ERROR',
        error_details:
          `update_mask fields ${missing.join(', ')} are not present in` +
          ' agent_config. Fields listed in update_mask but absent from' +
          ' agent_config will be cleared; include them explicitly or remove' +
          ' them from the mask.',
      };
    }

    return await mutateDataAgent({
      buildUrl: (baseUrl) => `${baseUrl}/${args.dataAgentName}`,
      method: 'PATCH',
      deps,
      location: extractLocationFromResourceName(args.dataAgentName),
      params: {updateMask: fields.join(',')},
      body: config,
    });
  } catch (err: unknown) {
    return {status: 'ERROR', error_details: formatError(err)};
  }
}

/**
 * Deletes a data agent and waits for the operation to finish.
 *
 * @param dataAgentName The data agent to delete.
 * @param deps The session factory and the resolved settings.
 * @return The delete operation's result, or the reason the call failed.
 */
export async function deleteDataAgent(
  dataAgentName: string,
  deps: DataAgentToolDeps,
): Promise<DataAgentToolResult> {
  try {
    const disabled = modificationDisabledError(deps.settings);
    if (disabled) {
      return disabled;
    }

    const invalidName = validateDataAgentName(dataAgentName);
    if (invalidName) {
      return invalidName;
    }

    return await mutateDataAgent({
      buildUrl: (baseUrl) => `${baseUrl}/${dataAgentName}`,
      method: 'DELETE',
      deps,
      location: extractLocationFromResourceName(dataAgentName),
    });
  } catch (err: unknown) {
    return {status: 'ERROR', error_details: formatError(err)};
  }
}

const projectIdField = z
  .string()
  .describe('The Google Cloud project that owns the data agents.');
const dataAgentNameField = z
  .string()
  .describe(
    'The resource name of the data agent, in format' +
      ' projects/{project}/locations/{location}/dataAgents/{agent}.',
  );
const agentConfigField = z
  .string()
  .describe(
    'A JSON string representing the DataAgent resource. For the REST' +
      ' resource schema, see' +
      ' https://docs.cloud.google.com/gemini/data-agents/reference/rest/v1/projects.locations.dataAgents#DataAgent',
  );

const listAccessibleDataAgentsParams = z.object({
  project_id: projectIdField,
  location: z
    .string()
    .optional()
    .describe(
      'The Google Cloud location to list agents from, for example "eu" or' +
        ' "us". Defaults to the location the toolset is configured with,' +
        ' falling back to "global".',
    ),
});

const getDataAgentInfoParams = z.object({
  data_agent_name: dataAgentNameField,
});

const askDataAgentParams = z.object({
  data_agent_name: dataAgentNameField,
  query: z.string().describe('The question to ask the data agent.'),
});

const createDataAgentParams = z.object({
  project_id: projectIdField,
  data_agent_id: z.string().describe('The id to give the new data agent.'),
  agent_config: agentConfigField,
  location: z
    .string()
    .optional()
    .describe(
      'The Google Cloud location to create the data agent in. Defaults to' +
        ' the location the toolset is configured with, falling back to' +
        ' "global". Only set this when the user asks for a specific region.',
    ),
});

const updateDataAgentParams = z.object({
  data_agent_name: dataAgentNameField,
  agent_config: agentConfigField,
  update_mask: z
    .string()
    .describe(
      "Comma-separated list of fields to update, using the API's camelCase" +
        ' JSON field names, for example "displayName,description". Every' +
        ' field listed here must also be present in agent_config.',
    ),
});

const deleteDataAgentParams = z.object({
  data_agent_name: dataAgentNameField,
});

/** One data agent tool: what the model sees, and what the call does. */
interface DataAgentToolDefinition<TParams extends z.ZodObject> {
  name: string;
  description: string;
  parameters: TParams;
  run(
    args: ToolExecuteArgument<TParams>,
    deps: DataAgentToolDeps,
  ): Promise<DataAgentToolResult>;
}

/** Builds one tool once the toolset knows its credentials and settings. */
type DataAgentToolBuilder = (
  credentials: DataAgentCredentialsManager | undefined,
  settings: ResolvedDataAgentToolConfig,
) => BaseTool;

/**
 * Binds a definition to its own parameter type.
 *
 * The six definitions have six different schemas, so they can only share one
 * array after each has been paired with the code that reads its arguments.
 */
function defineDataAgentTool<TParams extends z.ZodObject>(
  definition: DataAgentToolDefinition<TParams>,
): DataAgentToolBuilder {
  return (credentials, settings) =>
    createDataAgentTool(credentials, settings, definition);
}

const READ_TOOLS: readonly DataAgentToolBuilder[] = [
  defineDataAgentTool({
    name: 'list_accessible_data_agents',
    description: 'Lists accessible data agents in a project.',
    parameters: listAccessibleDataAgentsParams,
    run: (args, deps) =>
      listAccessibleDataAgents(
        {projectId: args.project_id, location: args.location},
        deps,
      ),
  }),
  defineDataAgentTool({
    name: 'get_data_agent_info',
    description: 'Gets a data agent by name.',
    parameters: getDataAgentInfoParams,
    run: (args, deps) => getDataAgentInfo(args.data_agent_name, deps),
  }),
  defineDataAgentTool({
    name: 'ask_data_agent',
    description:
      'Asks a question to a data agent. Answers with the steps the agent' +
      ' took, the SQL it generated and the rows it read.',
    parameters: askDataAgentParams,
    run: (args, deps) =>
      askDataAgent(
        {dataAgentName: args.data_agent_name, query: args.query},
        deps,
      ),
  }),
];

const MUTATION_TOOLS: readonly DataAgentToolBuilder[] = [
  defineDataAgentTool({
    name: 'create_data_agent',
    description:
      'Creates a new data agent. Waits for the create operation to finish;' +
      ' a timeout does not mean the create failed, because the operation may' +
      ' still be running in the background.',
    parameters: createDataAgentParams,
    run: (args, deps) =>
      createDataAgent(
        {
          projectId: args.project_id,
          dataAgentId: args.data_agent_id,
          agentConfig: args.agent_config,
          location: args.location,
        },
        deps,
      ),
  }),
  defineDataAgentTool({
    name: 'delete_data_agent',
    description:
      'Deletes an existing data agent. Waits for the delete operation to' +
      ' finish; a timeout does not mean the delete failed, because the' +
      ' operation may still be running in the background.',
    parameters: deleteDataAgentParams,
    run: (args, deps) => deleteDataAgent(args.data_agent_name, deps),
  }),
  defineDataAgentTool({
    name: 'update_data_agent',
    description:
      'Updates an existing data agent. Every field named in update_mask must' +
      ' also be present in agent_config, because the API clears a masked' +
      ' field the config omits.',
    parameters: updateDataAgentParams,
    run: (args, deps) =>
      updateDataAgent(
        {
          dataAgentName: args.data_agent_name,
          agentConfig: args.agent_config,
          updateMask: args.update_mask,
        },
        deps,
      ),
  }),
];

/**
 * Wraps one data agent function as a tool that never throws.
 *
 * This reproduces what adk-python's `GoogleTool` does for these functions:
 * the credential and the settings stay out of the model-facing schema, the
 * credential is resolved before the call, an OAuth flow in flight answers
 * with the authorization message, and any throw becomes an `ERROR` result.
 *
 * @param credentials Resolves the end user's credentials, when the toolset
 *   was given a credentials config.
 * @param settings The resolved toolset configuration.
 * @param definition What the tool declares and what the call does.
 * @return The tool.
 */
export function createDataAgentTool<TParams extends z.ZodObject>(
  credentials: DataAgentCredentialsManager | undefined,
  settings: ResolvedDataAgentToolConfig,
  definition: DataAgentToolDefinition<TParams>,
): FunctionTool<TParams> {
  const {name} = definition;
  return new FunctionTool({
    name,
    description: definition.description,
    parameters: definition.parameters,
    async execute(
      args: ToolExecuteArgument<TParams>,
      toolContext?: Context,
    ): Promise<DataAgentToolResult | string> {
      try {
        const authClient = await credentials?.getAuthClient(toolContext);
        if (credentials && !authClient) {
          return (
            'User authorization is required to access Google services for' +
            ` ${name}. Please complete the authorization flow.`
          );
        }
        return await definition.run(args, {
          openSession: (options) => createGdaSession(authClient, options),
          settings,
        });
      } catch (err: unknown) {
        return {status: 'ERROR', error_details: formatError(err)};
      }
    },
  });
}

/**
 * Builds the tools a data agent toolset exposes.
 *
 * The three mutation tools are only built when the settings allow mutation.
 * Each one refuses again at call time, so a tool obtained directly rather
 * than through the toolset is still gated.
 *
 * @param credentials Resolves the end user's credentials, if configured.
 * @param settings The resolved toolset configuration.
 * @return The read tools, and the mutation tools when they are enabled.
 */
export function buildDataAgentTools(
  credentials: DataAgentCredentialsManager | undefined,
  settings: ResolvedDataAgentToolConfig,
): BaseTool[] {
  const builders = settings.enableDataAgentModification
    ? [...READ_TOOLS, ...MUTATION_TOOLS]
    : READ_TOOLS;
  return builders.map((build) => build(credentials, settings));
}
