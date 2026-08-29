/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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
 * Declares one MCP server as plain data, for callers that build a toolset from
 * a configuration file rather than in code.
 *
 * Exactly one connection-param field must be set.
 */
export interface McpToolsetConfig {
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
  /** Adds `load_mcp_resource` so the model can read the server's resources. */
  useMcpResources?: boolean;
}

/**
 * Returns the single connection param `config` declares.
 *
 * @throws If the number of populated connection-param fields is not one, or if
 *     the configuration declares a stdio server without an opt-in.
 */
export function resolveConfigConnectionParams(
  config: McpToolsetConfig,
): MCPConnectionParams {
  const populated = [
    config.stdioConnectionParams,
    config.streamableHttpConnectionParams,
    // `!= null` rejects an explicit `null`, which is what JSON and YAML produce
    // for a field a config leaves blank.
  ].filter((params): params is MCPConnectionParams => params != null);

  if (populated.length !== 1) {
    throw new Error(
      'Exactly one of stdioConnectionParams, streamableHttpConnectionParams ' +
        'must be set.',
    );
  }

  if (
    config.stdioConnectionParams &&
    !getBooleanEnvVar(ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR)
  ) {
    throw new Error(
      'Stdio MCP servers are not allowed in agent configs: the ' +
        "config-supplied 'command' is launched as a local process when the " +
        'agent starts, so an untrusted config would be able to run arbitrary ' +
        'code. Construct the MCPToolset in code instead, use a remote ' +
        'transport (streamableHttpConnectionParams), or set ' +
        `${ALLOW_CONFIG_STDIO_SERVERS_ENV_VAR}=1 if this application only ` +
        'loads agent configs it trusts.',
    );
  }

  return populated[0];
}
