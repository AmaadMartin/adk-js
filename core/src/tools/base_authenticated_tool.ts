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

/**
 * The response a tool returns to the model while the client collects a
 * credential.
 */
export type AuthRequiredResponse = string | Record<string, unknown>;

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
  responseForAuthRequired?: AuthRequiredResponse;
}

/** The parameters for {@link BaseAuthenticatedTool.runAsyncImpl}. */
export interface RunAsyncAuthenticatedToolRequest extends RunAsyncToolRequest {
  /** The resolved credential, or `undefined` when the tool has no auth config. */
  credential?: AuthCredential;
}

/**
 * The credential handshake shared by the authenticated tools: it decides what
 * "no auth config" means, resolves the credential, and asks the client for one
 * when the tool cannot run yet.
 */
export class ToolAuthGate {
  private readonly credentialManager?: CredentialManager;

  constructor(
    toolName: string,
    authConfig: AuthConfig | undefined,
    private readonly responseForAuthRequired?: AuthRequiredResponse,
  ) {
    if (authConfig) {
      this.credentialManager = new CredentialManager(authConfig);
    } else {
      logger.debug(
        `authConfig is missing for tool ${toolName}, so authentication will be skipped.`,
      );
    }
  }

  /**
   * Runs `body` with a resolved credential, or asks the client for one.
   *
   * The tool body never runs without a credential once an auth config is
   * configured: a missing credential short-circuits to the auth-required
   * response so the framework can drive the interactive auth flow and
   * re-invoke the tool later.
   *
   * @param toolContext The context of the current tool call.
   * @param body Runs the tool logic with the resolved credential.
   * @returns The tool response, or the auth-required response.
   */
  async run(
    toolContext: Context,
    body: (credential?: AuthCredential) => Promise<unknown>,
  ): Promise<unknown> {
    if (!this.credentialManager) {
      return body();
    }

    const credential =
      await this.credentialManager.getAuthCredential(toolContext);
    if (!credential) {
      this.credentialManager.requestCredential(toolContext);
      return this.responseForAuthRequired ?? PENDING_AUTH_RESPONSE;
    }

    return body(credential);
  }
}

/**
 * A base tool that resolves an authentication credential before the tool logic
 * runs. Subclasses implement {@link BaseAuthenticatedTool.runAsyncImpl}, which
 * receives the credential ready for use.
 *
 * @experimental  (Experimental, subject to change)
 */
export abstract class BaseAuthenticatedTool extends BaseTool {
  private readonly authGate: ToolAuthGate;

  constructor(params: BaseAuthenticatedToolParams) {
    super(params);

    this.authGate = new ToolAuthGate(
      params.name,
      params.authConfig,
      params.responseForAuthRequired,
    );
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    return this.authGate.run(req.toolContext, (credential) =>
      this.runAsyncImpl({...req, credential}),
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
