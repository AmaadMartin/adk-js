/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';

import {AuthCredential} from '../../auth/auth_credential.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {getBooleanEnvVar} from '../../utils/env_aware_utils.js';

import type {
  MCPConnectionParams,
  StdioConnectionParams,
  StreamableHTTPConnectionParams,
} from './mcp_session_manager.js';

/**
 * Opts an application in to stdio MCP servers declared by a configuration
 * object. Set it to `1` or `true`.
 */
export const ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR =
  'ADK_ALLOW_CONFIG_STDIO_MCP_SERVERS';

/**
 * In-process override for {@link ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR}.
 * `undefined` means "not set, defer to the environment variable".
 */
let allowConfigStdioServers: boolean | undefined;

/** The message a config-declared stdio server is refused with. */
const STDIO_NOT_ALLOWED_MESSAGE =
  'Stdio MCP servers are not allowed in agent configs: the config-supplied ' +
  "'command' is launched as a local process when the agent starts, so an " +
  'untrusted config would be able to run arbitrary code. Construct the ' +
  'MCPToolset in code instead, use a remote transport ' +
  '(streamableHttpConnectionParams), or set ' +
  `${ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR}=1 if this application only loads ` +
  'agent configs it trusts.';

/** The message a config that declares the wrong number of transports fails with. */
const EXACTLY_ONE_TRANSPORT_MESSAGE =
  'Exactly one of stdioServerParams, stdioConnectionParams, ' +
  'streamableHttpConnectionParams must be set.';

/**
 * Declares one MCP server as plain data, for a caller that builds a toolset
 * from a configuration file rather than in code.
 *
 * Exactly one transport field must be set. `adk-python` also accepts
 * `sse_connection_params`; `adk-js` has no SSE transport, so there is no
 * counterpart here.
 */
export interface McpToolsetConfig {
  /**
   * Runs the MCP server as a local child process, declared as the raw
   * child-process parameters. This is `adk-python`'s `stdio_server_params`
   * spelling, and it is wrapped into a {@link StdioConnectionParams}.
   */
  stdioServerParams?: StdioServerParameters;
  /** Runs the MCP server as a local child process. */
  stdioConnectionParams?: StdioConnectionParams;
  /** Reaches the MCP server over streamable HTTP. */
  streamableHttpConnectionParams?: StreamableHTTPConnectionParams;
  /** Names the tools the toolset exposes. Defaults to all of them. */
  toolFilter?: string[];
  /** Prepended as `${prefix}_` to every discovered tool name. */
  prefix?: string;
  /** How long a `tools/list` response stays usable, in seconds. */
  toolListCacheTtlSeconds?: number;
  /** The scheme the MCP server authenticates with. */
  authScheme?: AuthScheme;
  /** The raw credential for {@link McpToolsetConfig.authScheme}. */
  authCredential?: AuthCredential;
  /** The key the credential is loaded and saved under. */
  credentialKey?: string;
  /** Adds `load_mcp_resource` so the model can read the server's resources. */
  useMcpResources?: boolean;
}

/**
 * Overrides whether a configuration object may declare a stdio MCP server.
 *
 * An application that embeds ADK and loads only agent configs it trusts can
 * call this at startup instead of setting
 * {@link ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR}. The override wins over the
 * environment variable, in both directions.
 *
 * @param value `true` to allow, `false` to refuse, `undefined` to defer to the
 *     environment variable again.
 */
export function setAllowConfigStdioServers(value: boolean | undefined): void {
  allowConfigStdioServers = value;
}

/** Whether a configuration object may declare a stdio MCP server. */
function allowConfigStdioServersEnabled(): boolean {
  return (
    allowConfigStdioServers ??
    getBooleanEnvVar(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR)
  );
}

/**
 * Returns the single connection param `config` declares.
 *
 * A stdio server launches a local process from a `command` the config
 * supplies, so an untrusted agent config could run arbitrary code with it.
 * That transport is therefore refused unless the host opts in, through
 * {@link setAllowConfigStdioServers} or
 * {@link ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR}. A remote transport is always
 * allowed.
 *
 * @param config The declared MCP server.
 * @return The one populated connection param.
 * @throws If the number of populated transport fields is not one, or if the
 *     config declares a stdio server without an opt-in.
 */
export function resolveConfigConnectionParams(
  config: McpToolsetConfig,
): MCPConnectionParams {
  // Push order is adk-python's precedence order in `McpToolset.from_config`.
  // `!= null` also rejects an explicit `null`, which is what JSON and YAML
  // produce for a field a config leaves blank.
  const populated: MCPConnectionParams[] = [];
  if (config.stdioServerParams != null) {
    populated.push({
      type: 'StdioConnectionParams',
      serverParams: config.stdioServerParams,
    });
  }
  if (config.stdioConnectionParams != null) {
    populated.push(config.stdioConnectionParams);
  }
  if (config.streamableHttpConnectionParams != null) {
    populated.push(config.streamableHttpConnectionParams);
  }

  if (populated.length !== 1) {
    throw new Error(EXACTLY_ONE_TRANSPORT_MESSAGE);
  }

  const [params] = populated;
  if (
    params.type === 'StdioConnectionParams' &&
    !allowConfigStdioServersEnabled()
  ) {
    throw new Error(STDIO_NOT_ALLOWED_MESSAGE);
  }

  return params;
}
