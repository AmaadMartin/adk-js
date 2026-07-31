/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {CredentialManager} from '../auth/credential_manager.js';
import {logger} from '../utils/logger.js';

import {BaseTool, BaseToolParams, RunAsyncToolRequest} from './base_tool.js';

/**
 * The response returned to the model while the client collects a credential.
 */
export const PENDING_AUTH_RESPONSE = 'Pending User Authorization.';

/** The parameters for the {@link BaseAuthenticatedTool} constructor. */
export interface BaseAuthenticatedToolParams extends BaseToolParams {
  /**
   * The auth configuration of the tool. Authentication is skipped entirely
   * when it is omitted.
   */
  authConfig?: AuthConfig;

  /**
   * The response returned to the model while the client collects a credential.
   * Defaults to {@link PENDING_AUTH_RESPONSE}.
   */
  responseForAuthRequired?: string | Record<string, unknown>;
}

/** The parameters for {@link BaseAuthenticatedTool.runAsyncImpl}. */
export interface RunAsyncAuthenticatedToolRequest extends RunAsyncToolRequest {
  /** The resolved credential, or `undefined` when the tool has no auth config. */
  credential?: AuthCredential;
}

/**
 * Runs `run` with a resolved credential, or asks the client for one.
 *
 * The tool body never runs without a credential once a credential manager is
 * configured: a missing credential short-circuits to the auth-required
 * response so the framework can drive the interactive auth flow and re-invoke
 * the tool later.
 */
export async function runWithCredential(
  credentialManager: CredentialManager | undefined,
  responseForAuthRequired: string | Record<string, unknown> | undefined,
  toolContext: Context,
  run: (credential?: AuthCredential) => Promise<unknown>,
): Promise<unknown> {
  if (!credentialManager) {
    return run();
  }

  const credential = await credentialManager.getAuthCredential(toolContext);
  if (!credential) {
    await credentialManager.requestCredential(toolContext);
    return responseForAuthRequired ?? PENDING_AUTH_RESPONSE;
  }

  return run(credential);
}

/**
 * A base tool that resolves an authentication credential before the tool logic
 * runs. Subclasses implement {@link BaseAuthenticatedTool.runAsyncImpl}, which
 * receives the credential ready for use.
 *
 * @experimental  (Experimental, subject to change)
 */
export abstract class BaseAuthenticatedTool extends BaseTool {
  private readonly credentialManager?: CredentialManager;
  private readonly responseForAuthRequired?: string | Record<string, unknown>;

  constructor(params: BaseAuthenticatedToolParams) {
    super(params);

    if (params.authConfig) {
      this.credentialManager = new CredentialManager(params.authConfig);
    } else {
      logger.debug(
        `authConfig is missing for tool ${params.name}, so authentication will be skipped.`,
      );
    }
    this.responseForAuthRequired = params.responseForAuthRequired;
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    return runWithCredential(
      this.credentialManager,
      this.responseForAuthRequired,
      req.toolContext,
      (credential) => this.runAsyncImpl({...req, credential}),
    );
  }

  /**
   * Runs the tool logic with the resolved credential.
   *
   * @param req The tool request, extended with the resolved credential.
   * @returns A promise resolving to the tool response.
   */
  protected abstract runAsyncImpl(
    req: RunAsyncAuthenticatedToolRequest,
  ): Promise<unknown>;
}
