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

import {
  FunctionTool,
  ToolExecuteArgument,
  ToolExecuteFunction,
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
  toolContext: Context,
  credential: AuthCredential,
) => Promise<unknown> | unknown;

/** The configuration options for creating an {@link AuthenticatedFunctionTool}. */
export interface AuthenticatedFunctionToolOptions<
  TParameters extends ToolInputParameters,
> extends Omit<ToolOptions<TParameters>, 'execute'> {
  /** The function to run once a credential is available. */
  execute: AuthenticatedToolExecuteFunction<TParameters>;

  /** What the tool authenticates with. */
  authConfig: AuthConfig;

  /**
   * What the tool returns while it waits for the client to supply a
   * credential. Defaults to {@link PENDING_USER_AUTHORIZATION}.
   */
  responseForAuthRequired?: Record<string, unknown> | string;
}

/**
 * Wraps `execute` so a call resolves its credential first, and returns
 * {@link AuthenticatedFunctionToolOptions.responseForAuthRequired} instead of
 * running the function when the client must supply one.
 *
 * `FunctionTool` calls this after it validates the arguments and after the
 * confirmation gate, so a rejected call never starts a consent flow.
 *
 * @param name The tool's name, for the error a context-free call raises.
 * @param credentialManager The credential lifecycle for this tool.
 * @param execute The function to run once a credential is available.
 * @param responseForAuthRequired What to return while the client supplies one.
 * @returns The function `FunctionTool` runs.
 */
export function withCredential<TParameters extends ToolInputParameters>(
  name: string,
  credentialManager: CredentialManager,
  execute: AuthenticatedToolExecuteFunction<TParameters>,
  responseForAuthRequired?: Record<string, unknown> | string,
): ToolExecuteFunction<TParameters> {
  return async (input, toolContext) => {
    if (!toolContext) {
      throw new Error(
        `Tool '${name}' requires authentication but no tool context was provided.`,
      );
    }
    const credential = await credentialManager.getAuthCredential(toolContext);
    if (!credential) {
      credentialManager.requestCredential(toolContext);
      return responseForAuthRequired ?? PENDING_USER_AUTHORIZATION;
    }
    return execute(input, toolContext, credential);
  };
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
 *     const accessToken = credential.oauth2?.accessToken;
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
    const {authConfig, execute, responseForAuthRequired, ...toolOptions} =
      options;
    // `FunctionTool` names an unnamed tool after its `execute` property, which
    // is a wrapper rather than the user's function. Resolve the name from the
    // user's function here instead.
    const name = options.name ?? execute.name;
    super({
      ...toolOptions,
      name,
      execute: withCredential(
        name,
        new CredentialManager(authConfig),
        execute,
        responseForAuthRequired,
      ),
    });
  }
}
