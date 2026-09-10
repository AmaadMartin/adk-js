/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {CredentialManager} from '../auth/credential_manager.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {BaseTool, BaseToolParams, RunAsyncToolRequest} from './base_tool.js';

/**
 * The tool result returned while the client collects the credential.
 *
 * The model sees this string as the tool response, so it is the same value
 * adk-python returns.
 */
export const PENDING_USER_AUTHORIZATION = 'Pending User Authorization.';

/**
 * Parameters for the {@link BaseAuthenticatedTool} constructor.
 */
export interface BaseAuthenticatedToolParams extends BaseToolParams {
  /** The credential this tool needs, and the scheme that provides it. */
  authConfig?: AuthConfig;
  /**
   * The response to return while the tool asks the client for a credential.
   * Defaults to {@link PENDING_USER_AUTHORIZATION}.
   */
  responseForAuthRequired?: Record<string, unknown> | string;
}

/**
 * The parameters for {@link BaseAuthenticatedTool.runAsyncImpl}.
 */
export interface AuthenticatedRunRequest extends RunAsyncToolRequest {
  /**
   * The resolved credential, or `undefined` when the tool carries no
   * `authConfig`.
   */
  credential?: AuthCredential;
}

/**
 * A tool that resolves its credential before its body runs.
 *
 * A subclass implements {@link runAsyncImpl} and receives the ready-to-use
 * credential. When no credential is available the tool asks the client for one
 * and returns the pending response instead of running.
 *
 * This class is experimental and its API may change without a major release.
 */
@experimental
export abstract class BaseAuthenticatedTool extends BaseTool {
  private readonly credentialManager?: CredentialManager;
  private readonly responseForAuthRequired?: Record<string, unknown> | string;

  /**
   * @param params The name, description and auth configuration of the tool.
   */
  constructor(params: BaseAuthenticatedToolParams) {
    super(params);

    if (params.authConfig?.authScheme) {
      this.credentialManager = new CredentialManager(params.authConfig);
    } else {
      logger.debug(
        'authConfig or authConfig.authScheme is missing, so authentication will be skipped.',
      );
    }
    this.responseForAuthRequired = params.responseForAuthRequired;
  }

  /**
   * Resolves the credential, then runs {@link runAsyncImpl} with it.
   *
   * @param request The arguments and context of the tool call.
   * @return The pending response when the client still has to supply a
   *     credential, otherwise whatever {@link runAsyncImpl} returns.
   */
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    let credential: AuthCredential | undefined;

    if (this.credentialManager) {
      credential = await this.credentialManager.getAuthCredential(
        request.toolContext,
      );
      if (!credential) {
        await this.credentialManager.requestCredential(request.toolContext);
        return this.responseForAuthRequired ?? PENDING_USER_AUTHORIZATION;
      }
    }

    return this.runAsyncImpl({...request, credential});
  }

  /**
   * Runs the tool body with the resolved credential.
   *
   * @param request The arguments, context and credential of the tool call.
   * @return The tool response.
   */
  protected abstract runAsyncImpl(
    request: AuthenticatedRunRequest,
  ): Promise<unknown>;
}
