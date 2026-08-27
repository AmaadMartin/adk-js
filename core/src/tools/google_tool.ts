/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient} from 'google-auth-library';

import {Context} from '../agents/context.js';
import {experimental} from '../utils/experimental.js';

import {
  FunctionTool,
  ToolExecuteArgument,
  ToolExecuteFunction,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';
import {
  BaseGoogleCredentialsConfig,
  GoogleCredentialsManager,
} from './google_credentials.js';

/** The auth material a {@link GoogleTool} injects into its function. */
export interface GoogleToolAuth {
  /** The resolved auth client, or undefined when no credentials are configured. */
  credentials?: AuthClient;
}

/** The function a {@link GoogleTool} wraps. */
export type GoogleToolExecuteFunction<TParameters extends ToolInputParameters> =
  (
    input: ToolExecuteArgument<TParameters>,
    auth: GoogleToolAuth,
    toolContext?: Context,
  ) => Promise<unknown> | unknown;

/** The configuration options for creating a {@link GoogleTool}. */
export interface GoogleToolOptions<
  TParameters extends ToolInputParameters,
> extends Omit<ToolOptions<TParameters>, 'execute'> {
  execute: GoogleToolExecuteFunction<TParameters>;
  /**
   * How to obtain a Google credential for each call. When it is omitted the
   * tool runs unauthenticated and `auth.credentials` is `undefined`.
   */
  credentialsConfig?: BaseGoogleCredentialsConfig;
}

/**
 * Wraps a function so that credentials are resolved once per call and passed
 * in as an argument, never held on the tool instance — two concurrent calls to
 * one tool would otherwise cross their credentials.
 *
 * Exported so a unit test can drive it directly; {@link GoogleTool} is the
 * public surface and this is not part of the package barrel.
 */
export function withGoogleCredentials<TParameters extends ToolInputParameters>(
  userExecute: GoogleToolExecuteFunction<TParameters>,
  credentialsManager: GoogleCredentialsManager | undefined,
  toolName: string,
): ToolExecuteFunction<TParameters> {
  return async (input, toolContext) => {
    const auth: GoogleToolAuth = {};
    if (credentialsManager) {
      if (!toolContext) {
        throw new Error(
          `Tool '${toolName}' needs a tool context to resolve credentials.`,
        );
      }
      auth.credentials =
        await credentialsManager.getValidCredentials(toolContext);
      if (!auth.credentials) {
        return (
          'User authorization is required to access Google services for ' +
          `${toolName}. Please complete the authorization flow.`
        );
      }
    }
    return userExecute(input, auth, toolContext);
  };
}

/**
 * A {@link FunctionTool} for handcrafted tools that call Google APIs
 * (experimental).
 *
 * The tool resolves a Google credential before each call and hands it to the
 * wrapped function, so the function carries none of the OAuth, refresh or
 * token-caching logic.
 */
@experimental
export class GoogleTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  constructor(options: GoogleToolOptions<TParameters>) {
    const name = options.name ?? options.execute.name;
    super({
      name,
      description: options.description,
      parameters: options.parameters,
      isLongRunning: options.isLongRunning,
      requireConfirmation: options.requireConfirmation,
      execute: withGoogleCredentials(
        options.execute,
        options.credentialsConfig
          ? new GoogleCredentialsManager(options.credentialsConfig)
          : undefined,
        name,
      ),
    });
  }
}
