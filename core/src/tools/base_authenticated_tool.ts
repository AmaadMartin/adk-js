/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthCredential} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {
  CredentialManager,
  PENDING_USER_AUTHORIZATION,
} from '../auth/credential_manager.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';

import {BaseTool, BaseToolParams, RunAsyncToolRequest} from './base_tool.js';

/** The constructor parameters for a {@link BaseAuthenticatedTool}. */
export interface BaseAuthenticatedToolParams extends BaseToolParams {
  /**
   * What the tool authenticates with. Without it the tool runs its body
   * straight away and the credential is `undefined`.
   */
  authConfig?: AuthConfig;

  /**
   * What the tool returns while it waits for the client to supply a
   * credential. Defaults to {@link PENDING_USER_AUTHORIZATION}.
   */
  responseForAuthRequired?: Record<string, unknown> | string;
}

/** The parameters a {@link BaseAuthenticatedTool} runs its body with. */
export interface RunAsyncAuthenticatedToolRequest extends RunAsyncToolRequest {
  /** The resolved credential, or `undefined` when the tool has no authConfig. */
  credential?: AuthCredential;
}

/**
 * A tool that resolves an authentication credential before it runs, and hands
 * that credential to its body.
 *
 * Subclass it and implement {@link runAsyncImpl}. When no credential is
 * available the tool asks the client for one, which pauses the invocation, and
 * returns {@link BaseAuthenticatedToolParams.responseForAuthRequired} instead
 * of running the body. The application collects consent and answers with a
 * `FunctionResponse`, and ADK re-executes the waiting call.
 *
 * {@link AuthenticatedFunctionTool} is the equivalent for a plain function.
 * Reach for this class when the tool needs its own declaration or state.
 *
 * @example
 * ```ts
 * class ListDocumentsTool extends BaseAuthenticatedTool {
 *   constructor() {
 *     super({
 *       name: 'list_documents',
 *       description: 'Lists the documents in a folder.',
 *       authConfig,
 *     });
 *   }
 *
 *   protected override async runAsyncImpl({
 *     args,
 *     credential,
 *   }: RunAsyncAuthenticatedToolRequest): Promise<unknown> {
 *     return fetchDocuments(args['folder'], credential?.oauth2?.accessToken);
 *   }
 * }
 * ```
 */
@experimental
export abstract class BaseAuthenticatedTool extends BaseTool {
  private readonly credentialManager?: CredentialManager;
  private readonly responseForAuthRequired?: Record<string, unknown> | string;

  /**
   * @param params The configuration for the tool.
   */
  constructor(params: BaseAuthenticatedToolParams) {
    super(params);
    if (params.authConfig) {
      this.credentialManager = new CredentialManager(params.authConfig);
    } else {
      logger.debug(
        `Tool '${params.name}' has no authConfig, so it skips authentication.`,
      );
    }
    this.responseForAuthRequired = params.responseForAuthRequired;
  }

  /**
   * Resolves the credential, then runs {@link runAsyncImpl} with it.
   *
   * @param request The arguments and the context of the tool call.
   * @returns What the body returns, or the pending-authorization response when
   *   the client must supply a credential first.
   */
  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    let credential: AuthCredential | undefined;
    if (this.credentialManager) {
      credential = await this.credentialManager.getAuthCredential(toolContext);
      if (!credential) {
        this.credentialManager.requestCredential(toolContext);
        return this.responseForAuthRequired ?? PENDING_USER_AUTHORIZATION;
      }
    }
    return this.runAsyncImpl({args, toolContext, credential});
  }

  /**
   * The tool's body. It runs only once a credential is available, or when the
   * tool has no `authConfig` at all.
   *
   * @param request The arguments, the context, and the resolved credential.
   * @returns The tool response.
   */
  protected abstract runAsyncImpl(
    request: RunAsyncAuthenticatedToolRequest,
  ): Promise<unknown>;
}
