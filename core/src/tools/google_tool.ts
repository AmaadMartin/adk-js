/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient} from 'google-auth-library';

import {Context} from '../agents/context.js';
import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';

import {RunAsyncToolRequest} from './base_tool.js';
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

/** Status reported to the model when a {@link GoogleTool} call fails. */
const ERROR_STATUS = 'ERROR';

/** The auth material a {@link GoogleTool} injects into its function. */
export interface GoogleToolAuth<TSettings> {
  /** The resolved auth client, or undefined when no credentials are configured. */
  credentials?: AuthClient;
  /** Toolset-specific settings supplied when the tool was constructed. */
  settings?: TSettings;
}

/** The function a {@link GoogleTool} wraps. */
export type GoogleToolExecuteFunction<
  TParameters extends ToolInputParameters,
  TSettings,
> = (
  input: ToolExecuteArgument<TParameters>,
  auth: GoogleToolAuth<TSettings>,
  toolContext?: Context,
) => Promise<unknown> | unknown;

/** The configuration options for creating a {@link GoogleTool}. */
export interface GoogleToolOptions<
  TParameters extends ToolInputParameters,
  TSettings,
> extends Omit<ToolOptions<TParameters>, 'execute'> {
  execute: GoogleToolExecuteFunction<TParameters, TSettings>;
  /**
   * How to obtain a Google credential for each call. When it is omitted the
   * tool runs unauthenticated and `auth.credentials` is `undefined`.
   */
  credentialsConfig?: BaseGoogleCredentialsConfig;
  /** Settings the owning toolset passes through to every call. */
  toolSettings?: TSettings;
}

/** The message returned while the end user has yet to authorize the tool. */
function authorizationRequiredMessage(toolName: string): string {
  return (
    'User authorization is required to access Google services for ' +
    `${toolName}. Please complete the authorization flow.`
  );
}

/**
 * Wraps the user's function so that credentials are resolved once per call and
 * passed in as an argument, never held on the tool instance — two concurrent
 * calls to one tool would otherwise cross their credentials.
 */
function withGoogleCredentials<
  TParameters extends ToolInputParameters,
  TSettings,
>(
  userExecute: GoogleToolExecuteFunction<TParameters, TSettings>,
  credentialsManager: GoogleCredentialsManager | undefined,
  toolSettings: TSettings | undefined,
  toolName: string,
): ToolExecuteFunction<TParameters> {
  return async (input, toolContext) => {
    const auth: GoogleToolAuth<TSettings> = {settings: toolSettings};
    if (credentialsManager) {
      // `RunAsyncToolRequest` always carries a context, so a tool reached
      // through `runAsync` has one; only `ToolExecuteFunction` types it
      // optional.
      auth.credentials = await credentialsManager.getValidCredentials(
        toolContext!,
      );
      if (!auth.credentials) {
        return authorizationRequiredMessage(toolName);
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
 * token-caching logic. A failure is reported to the model as an error payload
 * rather than thrown, which keeps one failing tool from ending the turn.
 */
@experimental
export class GoogleTool<
  TParameters extends ToolInputParameters = undefined,
  TSettings = unknown,
> extends FunctionTool<TParameters> {
  constructor(options: GoogleToolOptions<TParameters, TSettings>) {
    const name = options.name ?? options.execute.name;
    const credentialsManager = options.credentialsConfig
      ? new GoogleCredentialsManager(options.credentialsConfig)
      : undefined;
    super({
      name,
      description: options.description,
      parameters: options.parameters,
      isLongRunning: options.isLongRunning,
      requireConfirmation: options.requireConfirmation,
      execute: withGoogleCredentials(
        options.execute,
        credentialsManager,
        options.toolSettings,
        name,
      ),
    });
  }

  /**
   * Runs the tool, reporting any failure as `{status, error_details}` instead
   * of throwing.
   *
   * @param req The tool request containing arguments and tool context.
   * @return The wrapped function's result, the authorization-required message,
   *     or the error payload.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      return await super.runAsync(req);
    } catch (error: unknown) {
      return {status: ERROR_STATUS, error_details: formatError(error)};
    }
  }
}
