/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {CredentialManager} from '../auth/credential_manager.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {BaseTool, BaseToolParams, RunAsyncToolRequest} from './base_tool.js';

/** The response the tool returns while it waits for the client to authorize. */
export const PENDING_USER_AUTHORIZATION = 'Pending User Authorization.';

/** The parameters {@link BaseAuthenticatedTool.runAsyncImpl} receives. */
export interface AuthenticatedRunAsyncToolRequest extends RunAsyncToolRequest {
  /**
   * The credential resolved for this call, or `undefined` when the tool was
   * built without an auth scheme and therefore runs unauthenticated.
   */
  credential?: AuthCredential;
}

/**
 * The collaborator {@link BaseAuthenticatedTool} resolves credentials with.
 *
 * {@link CredentialManager} satisfies it, and a test or an embedder can supply
 * its own resolver instead.
 */
export interface ToolCredentialManager {
  /**
   * Resolves the credential for this call, or `undefined` when the client
   * still has to authorize one.
   */
  getAuthCredential(context: Context): Promise<AuthCredential | undefined>;

  /** Asks the client to collect a credential. */
  requestCredential(context: Context): Promise<void>;
}

/** Parameters for the {@link BaseAuthenticatedTool} constructor. */
export interface BaseAuthenticatedToolParams extends BaseToolParams {
  /** The auth configuration of the tool. */
  authConfig?: AuthConfig;

  /**
   * The response to return while the client is being asked for a credential.
   *
   * Two cases reach it: the tool configured no credential at all, or the
   * credential it configured is not enough on its own. An OAuth2 client id and
   * secret, for instance, still need the end user to complete the consent
   * flow.
   *
   * An empty string or an empty object counts as unset, and
   * {@link PENDING_USER_AUTHORIZATION} is returned instead.
   */
  responseForAuthRequired?: Record<string, unknown> | string;
}

/**
 * Picks the response for a call that is waiting on the client.
 */
function pendingAuthorizationResponse(
  configured: Record<string, unknown> | string | undefined,
): Record<string, unknown> | string {
  if (configured === undefined) {
    return PENDING_USER_AUTHORIZATION;
  }
  if (typeof configured === 'string') {
    return configured === '' ? PENDING_USER_AUTHORIZATION : configured;
  }
  return Object.keys(configured).length === 0
    ? PENDING_USER_AUTHORIZATION
    : configured;
}

/**
 * A tool that resolves an authentication credential before its own logic runs.
 *
 * A subclass implements {@link runAsyncImpl} and receives the credential ready
 * for use. When no credential is available yet, the tool asks the client for
 * one and returns a pending response instead of running the body, so the next
 * call can run it with the credential the client supplied.
 */
@experimental
export abstract class BaseAuthenticatedTool extends BaseTool {
  /**
   * Resolves the credential for each call.
   *
   * Undefined when the tool was built without an auth scheme, in which case
   * the tool runs unauthenticated.
   */
  protected credentialManager?: ToolCredentialManager;

  private readonly responseForAuthRequired?: Record<string, unknown> | string;

  constructor(params: BaseAuthenticatedToolParams) {
    super(params);

    this.responseForAuthRequired = params.responseForAuthRequired;

    // An auth config can arrive from a parsed config file, so the scheme is
    // checked at runtime even though the type declares it.
    if (params.authConfig?.authScheme) {
      this.credentialManager = new CredentialManager(params.authConfig);
    } else {
      logger.debug(
        'authConfig or authConfig.authScheme is missing, so authentication will be skipped.',
      );
    }
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    if (!this.credentialManager) {
      return this.runAsyncImpl({args, toolContext});
    }

    const credential =
      await this.credentialManager.getAuthCredential(toolContext);
    if (!credential) {
      await this.credentialManager.requestCredential(toolContext);
      return pendingAuthorizationResponse(this.responseForAuthRequired);
    }

    return this.runAsyncImpl({args, toolContext, credential});
  }

  /**
   * Runs the tool's own logic with the credential resolved for this call.
   *
   * @param request The call arguments, the tool context and the credential.
   * @return The tool response.
   */
  protected abstract runAsyncImpl(
    request: AuthenticatedRunAsyncToolRequest,
  ): Promise<unknown>;
}
