/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AuthClient} from 'google-auth-library';

import {Context} from '../agents/context.js';
import {experimental} from '../utils/experimental.js';

import {RunAsyncToolRequest} from './base_tool.js';
import {
  FunctionTool,
  ToolExecuteArgument,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';
import {
  BaseGoogleCredentialsConfig,
  GoogleCredentialsManager,
} from './google_credentials.js';

/**
 * The extra context handed to a {@link GoogleTool} function beyond the
 * model-supplied arguments.
 */
export interface GoogleToolExecuteContext<TSettings> {
  /**
   * The resolved Google credential; `undefined` when the tool was built
   * without a credentials config.
   */
  credentials?: AuthClient;
  /** The settings the owning toolset configured the tool with. */
  settings?: TSettings;
}

/**
 * The signature of the function a {@link GoogleTool} wraps.
 *
 * The credential and the settings arrive as a third argument rather than as
 * schema fields, so they can never leak into the declaration the model sees.
 */
export type GoogleToolExecuteFunction<
  TParameters extends ToolInputParameters,
  TSettings,
> = (
  input: ToolExecuteArgument<TParameters>,
  toolContext?: Context,
  google?: GoogleToolExecuteContext<TSettings>,
) => Promise<unknown> | unknown;

/** The configuration options for creating a {@link GoogleTool}. */
export interface GoogleToolOptions<
  TParameters extends ToolInputParameters,
  TSettings,
> extends Omit<ToolOptions<TParameters>, 'execute'> {
  /** The function implementing the tool's logic. */
  execute: GoogleToolExecuteFunction<TParameters, TSettings>;
  /**
   * The credentials config used to call the Google API. When omitted, no
   * credential machinery runs at all.
   */
  credentialsConfig?: BaseGoogleCredentialsConfig;
  /** Tool-specific settings, supplied by the toolset that creates the tool. */
  toolSettings?: TSettings;
}

/** The structured error a {@link GoogleTool} returns instead of throwing. */
export interface GoogleToolErrorResponse {
  status: 'ERROR';
  error_details: string;
}

/**
 * Builds the message returned to the model while an OAuth flow is in flight.
 */
function authorizationRequiredMessage(toolName: string): string {
  return `User authorization is required to access Google services for ${toolName}. Please complete the authorization flow.`;
}

/**
 * A tool that calls a Google API on behalf of the end user.
 *
 * This class is for handcrafting customized Google API tools rather than
 * auto-generating them from API specs. It owns the OAuth handshake and
 * credential lifecycle so the wrapped function can focus on the API call.
 *
 * While an authorization flow is in flight the wrapped function is not called;
 * the tool returns an authorization-required message instead. Any error —
 * raised by credential resolution or by the wrapped function — is returned as
 * a {@link GoogleToolErrorResponse} rather than thrown.
 */
@experimental
export class GoogleTool<
  TParameters extends ToolInputParameters = undefined,
  TSettings = unknown,
> extends FunctionTool<TParameters> {
  /**
   * @param options The configuration for the tool.
   */
  constructor(options: GoogleToolOptions<TParameters, TSettings>) {
    const {credentialsConfig, toolSettings, execute, ...toolOptions} = options;
    // The base class infers a missing name from the callback it is given,
    // which below is the adapter rather than `execute`.
    const name = options.name ?? execute.name;
    const credentialsManager = credentialsConfig
      ? new GoogleCredentialsManager(credentialsConfig)
      : undefined;

    super({
      ...toolOptions,
      name,
      // `FunctionTool.runAsync` always supplies the tool context; the
      // parameter is optional only so a wrapped function may omit it.
      execute: async (input, toolContext) => {
        if (!credentialsManager) {
          return execute(input, toolContext, {settings: toolSettings});
        }
        const credentials = await credentialsManager.getValidCredentials(
          toolContext!,
        );
        if (!credentials) {
          return authorizationRequiredMessage(name);
        }
        return execute(input, toolContext, {
          credentials,
          settings: toolSettings,
        });
      },
    });
  }

  /**
   * Runs the tool, converting any failure into a structured error response.
   *
   * @param req The tool request containing arguments and tool context.
   * @returns The wrapped function's return value, or a
   *     {@link GoogleToolErrorResponse}.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      return await super.runAsync(req);
    } catch (error) {
      const errorResponse: GoogleToolErrorResponse = {
        status: 'ERROR',
        error_details: error instanceof Error ? error.message : String(error),
      };
      return errorResponse;
    }
  }
}
