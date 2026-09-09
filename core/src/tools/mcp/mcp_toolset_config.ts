/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

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

/**
 * Declares one MCP server as plain data, for a caller that builds a toolset
 * from a configuration file rather than in code.
 *
 * Exactly one connection-param field must be set. `adk-python` also accepts
 * `stdio_server_params` and `sse_connection_params`; `adk-js` has no SSE
 * transport, and its {@link StdioConnectionParams} already wraps the raw
 * server parameters, so this config declares two transport fields rather than
 * four.
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

/** One transport field of a config, with the params it declares. */
interface DeclaredTransport {
  field: string;
  /** The `type` a params object under `field` must carry. */
  expectedType: MCPConnectionParams['type'];
  params: MCPConnectionParams;
}

/**
 * Collects the transport fields `config` populates.
 *
 * `!= null` also rejects an explicit `null`, which is what JSON and YAML
 * produce for a field a config leaves blank.
 */
function declaredTransports(config: McpToolsetConfig): DeclaredTransport[] {
  const declared: DeclaredTransport[] = [];
  if (config.stdioConnectionParams != null) {
    declared.push({
      field: 'stdioConnectionParams',
      expectedType: 'StdioConnectionParams',
      params: config.stdioConnectionParams,
    });
  }
  if (config.streamableHttpConnectionParams != null) {
    declared.push({
      field: 'streamableHttpConnectionParams',
      expectedType: 'StreamableHTTPConnectionParams',
      params: config.streamableHttpConnectionParams,
    });
  }
  return declared;
}

/**
 * Returns the single connection param `config` declares.
 *
 * A config that reaches this point is untrusted data: `McpToolsetConfig` is an
 * interface, so nothing has checked at runtime that the object under a field
 * is the kind of transport that field names. Both the field and the object's
 * own `type` are therefore checked, because `MCPSessionManager` dispatches on
 * the `type`, and a mismatch would otherwise open a local process through the
 * remote-transport field.
 *
 * @param config The declared MCP server.
 * @return The one populated connection param.
 * @throws If the number of populated transport fields is not one, if the
 *     params carry a `type` that does not match the field they are declared
 *     under, or if the config declares a stdio server without an opt-in.
 */
export function resolveConfigConnectionParams(
  config: McpToolsetConfig,
): MCPConnectionParams {
  const declared = declaredTransports(config);

  if (declared.length !== 1) {
    throw new Error(
      'Exactly one of stdioConnectionParams, streamableHttpConnectionParams ' +
        'must be set.',
    );
  }

  const [transport] = declared;
  if (transport.params.type !== transport.expectedType) {
    throw new Error(
      `${transport.field} must declare connection params of type ` +
        `'${transport.expectedType}', but it declares ` +
        `'${String(transport.params.type)}'. The transport is chosen from the ` +
        'type, so a mismatch would let a config reach a transport its field ' +
        'does not name.',
    );
  }

  if (
    transport.params.type === 'StdioConnectionParams' &&
    !allowConfigStdioServersEnabled()
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

  return transport.params;
}
