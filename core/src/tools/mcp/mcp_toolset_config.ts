/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {StdioServerParameters} from '@modelcontextprotocol/sdk/client/stdio.js';

import {getBooleanEnvVar} from '../../utils/env_aware_utils.js';

import type {
  MCPConnectionParams,
  StdioConnectionParams,
  StreamableHTTPConnectionParams,
} from './mcp_session_manager.js';

/**
 * The declarative configuration of an `MCPToolset`, as an agent config
 * supplies it.
 *
 * Exactly one transport field must be set. adk-python also accepts
 * `sse_connection_params`; adk-js has no SSE transport, so there is no
 * counterpart here.
 */
export interface McpToolsetConfig {
  /** A stdio server, given as the raw child-process parameters. */
  stdioServerParams?: StdioServerParameters;

  /** A stdio server, given as full connection parameters. */
  stdioConnectionParams?: StdioConnectionParams;

  /** A remote server reached over streamable HTTP. */
  streamableHttpConnectionParams?: StreamableHTTPConnectionParams;

  /** The tool names to expose; all of them when omitted. */
  toolFilter?: string[];

  /** Prefix applied to every discovered tool name. */
  toolNamePrefix?: string;
}

/**
 * Environment variable that lets agent configs declare stdio MCP servers.
 *
 * Enabled when its value, lower-cased, is `true` or `1`.
 */
export const ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR =
  'ADK_ALLOW_CONFIG_STDIO_MCP_SERVERS';

/** The message a config-declared stdio server is refused with. */
const STDIO_NOT_ALLOWED_MESSAGE =
  'Stdio MCP servers are not allowed in agent configs: the config-supplied ' +
  "'command' is launched as a local process when the agent starts, so an " +
  'untrusted config would be able to run arbitrary code. Construct the ' +
  'MCPToolset in code instead, use a remote transport ' +
  '(streamableHttpConnectionParams), or set ' +
  `${ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR}=1 if this application only loads ` +
  'agent configs it trusts.';

/** The message a config that does not declare exactly one transport fails with. */
const EXACTLY_ONE_TRANSPORT_MESSAGE =
  'Exactly one of stdioServerParams, stdioConnectionParams, ' +
  'streamableHttpConnectionParams must be set.';

/**
 * Validates `config` and returns the single transport it declares.
 *
 * A stdio server launches a local process from a `command` the config
 * supplies, so an untrusted agent config could run arbitrary code with it.
 * That transport is therefore refused unless the operator opts in through
 * {@link ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR}. A remote transport is always
 * allowed.
 *
 * @param config The agent-config fields describing the MCP server.
 * @return The connection parameters to build the toolset with.
 * @throws If the config declares no transport or more than one, or declares a
 *   stdio server without the opt-in.
 */
export function resolveMcpConnectionParams(
  config: McpToolsetConfig,
): MCPConnectionParams {
  // Push order is adk-python's precedence order in `McpToolset.from_config`.
  const declared: MCPConnectionParams[] = [];
  if (config.stdioServerParams) {
    declared.push({
      type: 'StdioConnectionParams',
      serverParams: config.stdioServerParams,
    });
  }
  if (config.stdioConnectionParams) {
    declared.push(config.stdioConnectionParams);
  }
  if (config.streamableHttpConnectionParams) {
    declared.push(config.streamableHttpConnectionParams);
  }

  if (declared.length !== 1) {
    throw new Error(EXACTLY_ONE_TRANSPORT_MESSAGE);
  }

  const [params] = declared;
  if (
    params.type === 'StdioConnectionParams' &&
    !getBooleanEnvVar(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR)
  ) {
    throw new Error(STDIO_NOT_ALLOWED_MESSAGE);
  }
  return params;
}
