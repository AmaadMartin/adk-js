/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {Context} from '../agents/context.js';

import {AuthCredential} from './auth_credential.js';
import {AuthConfig} from './auth_tool.js';

/**
 * Abstract base interface for custom authentication providers.
 */
export interface BaseAuthProvider {
  /**
   * The scheme `type` literals this provider serves.
   *
   * `CredentialManager.registerAuthProvider` reads this and registers the
   * provider under each of them. It defaults to none, matching adk-python's
   * empty tuple.
   */
  readonly supportedAuthSchemes?: readonly string[];

  /**
   * Provide an AuthCredential asynchronously.
   *
   * @param authConfig The current authentication configuration.
   * @param context The context of the current tool call.
   * @returns The retrieved AuthCredential, or undefined if unavailable.
   */
  getAuthCredential(
    authConfig: AuthConfig,
    context: Context,
  ): Promise<AuthCredential | undefined>;
}
