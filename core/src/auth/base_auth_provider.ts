/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ReadonlyContext} from '../agents/readonly_context.js';
import {AuthCredential} from './auth_credential.js';
import {CustomAuthConfig} from './auth_tool.js';

/**
 * Abstract base interface for custom authentication providers.
 */
export interface BaseAuthProvider {
  /**
   * The auth scheme `type` discriminators this provider serves.
   *
   * `registerAuthProvider` registers the provider under every entry.
   */
  readonly supportedAuthSchemes: readonly string[];

  /**
   * Provide an AuthCredential asynchronously.
   *
   * @param authConfig The current authentication configuration.
   * @param context The context of the invocation that needs the credential.
   * @returns The retrieved AuthCredential, or undefined if unavailable.
   */
  getAuthCredential(
    authConfig: CustomAuthConfig,
    context?: ReadonlyContext,
  ): Promise<AuthCredential | undefined>;
}
