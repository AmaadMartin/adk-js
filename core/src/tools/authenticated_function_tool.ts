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

import {PENDING_USER_AUTHORIZATION} from './base_authenticated_tool.js';
import {
  FunctionTool,
  ToolExecuteArgument,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';

/**
 * The signature of the function an {@link AuthenticatedFunctionTool} runs. It
 * is {@link ToolExecuteFunction} with the resolved credential appended.
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
    /** The credential this tool needs, and the scheme that provides it. */
    authConfig?: AuthConfig;
    /**
     * The response to return while the tool asks the client for a credential.
     * Defaults to {@link PENDING_USER_AUTHORIZATION}.
     */
    responseForAuthRequired?: Record<string, unknown> | string;
  };

/**
 * A {@link FunctionTool} that resolves its credential before the function runs.
 *
 * The function receives the ready-to-use credential as its third argument. When
 * no credential is available the tool asks the client for one and returns the
 * pending response instead of running the function. The credential never
 * appears in the function declaration, so the model does not see it.
 *
 * This class is experimental and its API may change without a major release.
 */
@experimental
export class AuthenticatedFunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  /**
   * @param options The configuration for the tool.
   */
  constructor(options: AuthenticatedToolOptions<TParameters>) {
    const {authConfig, responseForAuthRequired, execute, ...toolOptions} =
      options;

    // The credential is resolved into a local of this closure rather than an
    // instance field: one tool instance serves concurrent calls, and a field
    // would leak one call's credential into another.
    const credentialManager = authConfig?.authScheme
      ? new CredentialManager(authConfig)
      : undefined;
    if (!credentialManager) {
      logger.debug(
        'authConfig or authConfig.authScheme is missing, so authentication will be skipped.',
      );
    }

    super({
      ...toolOptions,
      // The wrapper below would otherwise supply the tool name, because an
      // arrow in an object literal is named after its property.
      name: toolOptions.name ?? execute.name,
      execute: async (input, toolContext) => {
        if (!credentialManager) {
          return execute(input, toolContext);
        }
        if (!toolContext) {
          throw new Error(
            'AuthenticatedFunctionTool requires a tool context to authenticate.',
          );
        }

        const credential =
          await credentialManager.getAuthCredential(toolContext);
        if (!credential) {
          await credentialManager.requestCredential(toolContext);
          return responseForAuthRequired ?? PENDING_USER_AUTHORIZATION;
        }

        return execute(input, toolContext, credential);
      },
    });
  }
}
