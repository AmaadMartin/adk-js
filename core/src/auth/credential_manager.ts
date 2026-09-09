/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../agents/readonly_context.js';
import {logger} from '../utils/logger.js';
import {AuthCredential} from './auth_credential.js';
import {AuthProviderRegistry} from './auth_provider_registry.js';
import {CustomAuthConfig} from './auth_tool.js';
import {BaseAuthProvider} from './base_auth_provider.js';

/**
 * Custom auth scheme dispatch, ported from the `CustomAuthScheme` branch of
 * adk-python's `CredentialManager` (`google/adk/auth/credential_manager.py`).
 *
 * Only that branch is ported, so this module exports functions rather than a
 * `CredentialManager` class: the remaining steps of the Python class already
 * exist in adk-js under other names. Validation, exchange and caching for the
 * OpenAPI schemes live in
 * `tools/openapi_tool/openapi_spec_parser/tool_auth_handler.ts`, auth-request
 * generation lives in `auth/auth_handler.ts`, persistence in
 * `auth/credential_service/`, and OAuth2 exchange and refresh in
 * `auth/exchanger/` and `auth/refresher/`.
 */

/** Registry of the providers {@link registerAuthProvider} records. */
const registry = new AuthProviderRegistry();

/**
 * Registers `provider` for every scheme type it declares in
 * {@link BaseAuthProvider.supportedAuthSchemes}.
 *
 * A scheme type that already has a different provider keeps that provider and
 * is logged. Registering the same instance twice is a no-op.
 */
export function registerAuthProvider(provider: BaseAuthProvider): void {
  for (const schemeType of provider.supportedAuthSchemes) {
    const existing = registry.getProvider({type: schemeType});
    if (existing === provider) {
      continue;
    }
    if (existing) {
      logger.warn(
        `An auth provider is already registered for scheme ${schemeType}. ` +
          'Ignoring the new provider.',
      );
      continue;
    }
    registry.register(schemeType, provider);
  }
}

/**
 * Resolves the credential for a custom auth scheme through its registered
 * provider.
 *
 * @param authConfig The config carrying the custom scheme to resolve.
 * @param context The context of the invocation that needs the credential.
 * @returns The credential the provider returned.
 * @throws If no provider is registered for the scheme type, or if the provider
 *   returns no credential.
 */
export async function getCustomSchemeCredential(
  authConfig: CustomAuthConfig,
  context?: ReadonlyContext,
): Promise<AuthCredential> {
  const provider = registry.getProvider(authConfig.authScheme);
  if (!provider) {
    throw new Error(
      `No auth provider registered for custom auth scheme '${authConfig.authScheme.type}'. ` +
        'Register it using `registerAuthProvider(<YourAuthProviderInstance>)`.',
    );
  }

  const credential = await provider.getAuthCredential(authConfig, context);
  if (!credential) {
    throw new Error('AuthProvider did not return a credential.');
  }
  return credential;
}
