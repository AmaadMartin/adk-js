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

import {runWithCredential} from './base_authenticated_tool.js';
import {RunAsyncToolRequest} from './base_tool.js';
import {
  FunctionTool,
  ToolExecuteArgument,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';

/**
 * The signature of the user-provided function executed by an
 * {@link AuthenticatedFunctionTool}. It receives the resolved credential as a
 * third argument; a function that does not need it can declare fewer
 * parameters.
 */
export type AuthenticatedToolExecuteFunction<
  TParameters extends ToolInputParameters,
> = (
  input: ToolExecuteArgument<TParameters>,
  toolContext?: Context,
  credential?: AuthCredential,
) => Promise<unknown> | unknown;

/**
 * The configuration options for creating an {@link AuthenticatedFunctionTool}.
 */
export type AuthenticatedToolOptions<TParameters extends ToolInputParameters> =
  Omit<ToolOptions<TParameters>, 'execute'> & {
    execute: AuthenticatedToolExecuteFunction<TParameters>;

    /**
     * The auth configuration of the tool. Authentication is skipped entirely
     * when it is omitted.
     */
    authConfig?: AuthConfig;

    /**
     * The response returned to the model while the client collects a
     * credential. Defaults to `'Pending User Authorization.'`.
     */
    responseForAuthRequired?: string | Record<string, unknown>;
  };

/**
 * A {@link FunctionTool} that resolves an authentication credential before the
 * wrapped function runs, and passes it to that function.
 *
 * @experimental  (Experimental, subject to change)
 */
@experimental
export class AuthenticatedFunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  private readonly credentialManager?: CredentialManager;
  private readonly responseForAuthRequired?: string | Record<string, unknown>;

  constructor(options: AuthenticatedToolOptions<TParameters>) {
    const {authConfig, responseForAuthRequired, ...toolOptions} = options;
    super(toolOptions);

    if (authConfig) {
      this.credentialManager = new CredentialManager(authConfig);
    } else {
      logger.debug(
        `authConfig is missing for tool ${this.name}, so authentication will be skipped. Use FunctionTool instead if authentication is not required.`,
      );
    }
    this.responseForAuthRequired = responseForAuthRequired;
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    return runWithCredential(
      this.credentialManager,
      this.responseForAuthRequired,
      req.toolContext,
      (credential) => this.callExecute(req, [credential]),
    );
  }
}
