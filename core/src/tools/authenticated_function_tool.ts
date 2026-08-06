/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../agents/context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {experimental} from '../utils/experimental.js';

import {AuthRequiredResponse, ToolAuthGate} from './base_authenticated_tool.js';
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
     * credential. Defaults to {@link PENDING_AUTH_RESPONSE}.
     */
    responseForAuthRequired?: AuthRequiredResponse;
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
  private readonly authGate: ToolAuthGate;

  constructor(options: AuthenticatedToolOptions<TParameters>) {
    const {authConfig, responseForAuthRequired, ...toolOptions} = options;
    super(toolOptions);

    this.authGate = new ToolAuthGate(
      this.name,
      authConfig,
      responseForAuthRequired,
    );
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    return this.authGate.run(req.toolContext, (credential) =>
      this.callExecute(req, credential),
    );
  }
}
