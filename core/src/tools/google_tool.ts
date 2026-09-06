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
// This module and `google_tool_credentials.js` are two ports of one adk-python
// module. The config declared here is the weaker of the two: it has no
// `credentialKey`, so a config built on either module satisfies it. That is
// what lets the BigQuery, Bigtable and Cloud Storage toolsets, which ported
// their credentials against different copies, all build a `GoogleTool`.
import {
  BaseGoogleCredentialsConfig,
  GoogleCredentialsManager,
} from './google_credentials.js';

/**
 * The `status` field a {@link GoogleTool} result carries.
 *
 * adk-python writes the two strings by hand. The members hold the same
 * strings, so a tool that reports its own success shares one spelling with the
 * failure {@link GoogleTool} reports for it.
 */
export enum GoogleToolStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
}

/** The Google-specific context handed to a {@link GoogleTool} function. */
export interface GoogleToolExecuteContext<TSettings> {
  /** The resolved credential; `undefined` when no credentials config was set. */
  credentials?: AuthClient;
  /** The settings the owning toolset configured the tool with. */
  settings?: TSettings;
}

/**
 * The signature of the function a {@link GoogleTool} wraps.
 *
 * The credential and the settings arrive as a third argument rather than as
 * schema fields, so the model can neither see them nor supply them.
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
   * How to obtain a Google credential. When it is omitted, the tool runs no
   * credential machinery and `google.credentials` is `undefined`.
   */
  credentialsConfig?: BaseGoogleCredentialsConfig;
  /** Tool-specific settings, supplied by the toolset that builds the tool. */
  toolSettings?: TSettings;
}

/** The structured error a {@link GoogleTool} returns instead of throwing. */
export interface GoogleToolErrorResponse {
  status: GoogleToolStatus.ERROR;
  /**
   * The failure message. The key crosses the language boundary — adk-python
   * emits the same one — so it stays snake_case.
   */
  error_details: string;
}

/**
 * A tool that calls a Google API on behalf of the end user (experimental).
 *
 * Use it to handcraft a Google API tool, rather than generating one from an
 * API spec. The tool owns the OAuth handshake and the credential lifecycle, so
 * the wrapped function only makes the API call.
 *
 * While an authorization flow is in flight the wrapped function does not run;
 * the tool returns an authorization-required message. Any failure — from
 * resolving the credential, from validating the arguments, or from the
 * function itself — comes back as a {@link GoogleToolErrorResponse} rather
 * than as a thrown error.
 *
 * @example
 * ```ts
 * const listDatasets = new GoogleTool({
 *   name: 'list_datasets',
 *   description: 'Lists the BigQuery datasets in a project.',
 *   parameters: z.object({projectId: z.string()}),
 *   credentialsConfig,
 *   toolSettings: {maxRows: 50},
 *   execute: (input, _toolContext, google) =>
 *     listDatasetsWith(input.projectId, google?.credentials),
 * });
 * ```
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
    // The base class infers a missing name from the callback it is handed,
    // which below is the adapter rather than the caller's function.
    const name = options.name ?? execute.name;
    const credentialsManager = credentialsConfig
      ? new GoogleCredentialsManager(credentialsConfig)
      : undefined;

    super({
      ...toolOptions,
      name,
      execute: withGoogleCredentials(execute, {
        name,
        credentialsManager,
        toolSettings,
      }),
    });
  }

  /**
   * Runs the tool, converting any failure into a structured error response.
   *
   * @param req The tool request containing arguments and tool context.
   * @return The wrapped function's return value, the authorization-required
   *     message, or a {@link GoogleToolErrorResponse}.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      return await super.runAsync(req);
    } catch (error: unknown) {
      const response: GoogleToolErrorResponse = {
        status: GoogleToolStatus.ERROR,
        error_details: formatError(error),
      };
      return response;
    }
  }
}

/** What {@link withGoogleCredentials} needs besides the caller's function. */
interface GoogleCredentialsAdapterOptions<TSettings> {
  /** The tool's name, used in the authorization prompt. */
  name: string;
  /** Resolves the credential, or `undefined` to run unauthenticated. */
  credentialsManager?: GoogleCredentialsManager;
  /** The settings handed to the caller's function. */
  toolSettings?: TSettings;
}

/**
 * Wraps the caller's function so a credential is resolved once per call and
 * passed in as an argument, rather than held on the tool: two concurrent calls
 * to one tool would otherwise cross their credentials.
 *
 * Exported so a test can drive it directly. {@link GoogleTool} is the public
 * surface and this is not part of the package barrel.
 */
export function withGoogleCredentials<
  TParameters extends ToolInputParameters,
  TSettings,
>(
  execute: GoogleToolExecuteFunction<TParameters, TSettings>,
  options: GoogleCredentialsAdapterOptions<TSettings>,
): ToolExecuteFunction<TParameters> {
  const {name, credentialsManager, toolSettings} = options;
  return async (input, toolContext) => {
    if (!credentialsManager) {
      return execute(input, toolContext, {settings: toolSettings});
    }
    if (!toolContext) {
      throw new Error(
        `Tool '${name}' needs a tool context to resolve credentials.`,
      );
    }
    const credentials =
      await credentialsManager.getValidCredentials(toolContext);
    if (!credentials) {
      return authorizationRequiredMessage(name);
    }
    return execute(input, toolContext, {credentials, settings: toolSettings});
  };
}

/**
 * The message returned while the end user completes an OAuth flow.
 *
 * The model relays it, and the host drives the flow the tool started.
 */
export function authorizationRequiredMessage(toolName: string): string {
  return `User authorization is required to access Google services for ${toolName}. Please complete the authorization flow.`;
}
