/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../../agents/readonly_context.js';
import {AuthCredential} from '../../auth/auth_credential.js';
import {buildAuthHeaders} from '../../auth/auth_headers.js';
import {AuthScheme} from '../../auth/auth_schemes.js';
import {AuthConfig} from '../../auth/auth_tool.js';

/**
 * The credential key an MCP auth config falls back to.
 *
 * adk-python leaves `credential_key` optional; `AuthConfig` in adk-js declares
 * it required, so a toolset that supplies no key gets this one. It mirrors
 * `default_openapi_key` in the OpenAPI tool auth handler.
 */
export const DEFAULT_MCP_CREDENTIAL_KEY = 'default_mcp_key';

/**
 * Produces extra headers for one MCP request, from the invocation that asked
 * for it. Use it to carry per-tenant or per-user routing information.
 */
export type McpHeaderProvider = (
  context: ReadonlyContext,
) => Record<string, string> | Promise<Record<string, string>>;

/** The auth and header options shared by an MCP tool and an MCP toolset. */
export interface McpAuthOptions {
  /** The scheme the MCP server authenticates with. */
  authScheme?: AuthScheme;

  /** The raw credential for {@link McpAuthOptions.authScheme}. */
  authCredential?: AuthCredential;

  /** The key this credential is loaded and saved under. */
  credentialKey?: string;

  /** Extra headers to send with every MCP request. */
  headerProvider?: McpHeaderProvider;
}

/**
 * Builds the auth config an MCP caller exposes to the host.
 *
 * @param options The configured auth options.
 * @return The config, or `undefined` when no scheme was supplied.
 */
export function createMcpAuthConfig(
  options: McpAuthOptions,
): AuthConfig | undefined {
  if (!options.authScheme) {
    return undefined;
  }
  return {
    authScheme: options.authScheme,
    rawAuthCredential: options.authCredential,
    credentialKey: options.credentialKey ?? DEFAULT_MCP_CREDENTIAL_KEY,
  };
}

/**
 * Merges the header provider's output with the headers derived from the
 * exchanged credential.
 *
 * Auth headers are applied last, so a header provider cannot overwrite
 * `Authorization` with a value of its own.
 *
 * @param authConfig The config the host filled `exchangedAuthCredential` on.
 * @param headerProvider The configured header provider, when there is one.
 * @param context The invocation the headers are for. Without it the provider
 *     has nothing to read, so it is not called.
 * @return The merged headers, empty when there are none.
 */
export async function resolveMcpHeaders(
  authConfig: AuthConfig | undefined,
  headerProvider: McpHeaderProvider | undefined,
  context?: ReadonlyContext,
): Promise<Record<string, string>> {
  const headers: Record<string, string> = {};

  if (headerProvider && context) {
    Object.assign(headers, await headerProvider(context));
  }

  if (authConfig) {
    Object.assign(
      headers,
      buildAuthHeaders(
        authConfig.exchangedAuthCredential,
        authConfig.authScheme,
      ),
    );
  }

  return headers;
}
