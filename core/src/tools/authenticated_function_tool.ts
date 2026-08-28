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

import {
  FunctionTool,
  ToolExecuteArgument,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';

/** The result of a call that asked the client for a credential. */
export const PENDING_USER_AUTHORIZATION = 'Pending User Authorization.';

/**
 * The signature of the function an {@link AuthenticatedFunctionTool} runs. It
 * is the {@link ToolExecuteFunction} signature plus the resolved credential.
 */
export type AuthenticatedToolExecuteFunction<
  TParameters extends ToolInputParameters,
> = (
  input: ToolExecuteArgument<TParameters>,
  toolContext: Context | undefined,
  credential: AuthCredential | undefined,
) => Promise<unknown> | unknown;

/** The configuration options for creating an {@link AuthenticatedFunctionTool}. */
export interface AuthenticatedFunctionToolOptions<
  TParameters extends ToolInputParameters,
> extends Omit<ToolOptions<TParameters>, 'execute'> {
  /** The function to run once a credential is available. */
  execute: AuthenticatedToolExecuteFunction<TParameters>;

  /**
   * What the tool authenticates with. Without it the tool runs the function
   * straight away and the credential argument is `undefined`.
   */
  authConfig?: AuthConfig;

  /**
   * What the tool returns while it waits for the client to supply a
   * credential. Defaults to {@link PENDING_USER_AUTHORIZATION}.
   */
  responseForAuthRequired?: Record<string, unknown> | string;
}

/**
 * A {@link FunctionTool} that resolves an authentication credential before it
 * runs the function, and passes that credential to it.
 *
 * When no credential is available the tool asks the client for one, which
 * pauses the invocation, and returns
 * {@link AuthenticatedFunctionToolOptions.responseForAuthRequired} instead of
 * running the function. The application collects consent and answers with a
 * `FunctionResponse`, and ADK re-executes the waiting call.
 *
 * The model never sees the credential: the declaration the model reads comes
 * from the `parameters` schema, which the credential is not part of.
 *
 * @example
 * ```ts
 * const listDocuments = new AuthenticatedFunctionTool({
 *   name: 'list_documents',
 *   description: 'Lists the documents in a folder.',
 *   parameters: z.object({folder: z.string()}),
 *   authConfig,
 *   execute: async ({folder}, toolContext, credential) => {
 *     const accessToken = credential?.oauth2?.accessToken;
 *     return fetchDocuments(folder, accessToken);
 *   },
 * });
 * ```
 */
@experimental
export class AuthenticatedFunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  /**
   * @param options The configuration for the tool.
   */
  constructor(options: AuthenticatedFunctionToolOptions<TParameters>) {
    const {authConfig, responseForAuthRequired, execute, ...toolOptions} =
      options;
    // `FunctionTool` names an unnamed tool after its `execute` property, which
    // is the wrapper below rather than the user's function. Resolve the name
    // from the user's function here instead.
    const name = options.name ?? execute.name;
    const credentialManager = authConfig
      ? new CredentialManager(authConfig)
      : undefined;
    super({
      ...toolOptions,
      name,
      // Resolving here rather than in `runAsync` keeps the credential lookup
      // behind argument validation and the confirmation gate, so a rejected
      // call never starts a consent flow.
      execute: async (input, toolContext) => {
        if (!credentialManager) {
          return execute(input, toolContext, undefined);
        }
        // `RunAsyncToolRequest.toolContext` is required, so a tool the
        // framework runs always has one.
        const context = toolContext!;
        const credential = await credentialManager.getAuthCredential(context);
        if (!credential) {
          credentialManager.requestCredential(context);
          return responseForAuthRequired ?? PENDING_USER_AUTHORIZATION;
        }
        return execute(input, context, credential);
      },
    });
    if (!authConfig) {
      logger.warn(
        `Tool '${name}' has no authConfig, so it skips authentication. ` +
          'Use FunctionTool instead when the tool needs no credential.',
      );
    }
  }
}
