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
  ToolInputParameters,
} from './function_tool.js';
import {
  BaseGoogleCredentialsConfig,
  GoogleCredentialsManager,
} from './google_credentials.js';

/** The `status` field of every {@link GoogleTool} result. */
export enum GoogleToolStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
}

/** What a Google API tool returns when it fails. */
export interface GoogleToolError {
  status: GoogleToolStatus.ERROR;
  errorDetails: string;
}

/**
 * Everything a Google API tool's implementation receives besides the
 * arguments the model supplied.
 */
export interface GoogleToolCall<TSettings> {
  /**
   * The resolved credentials, or `undefined` when the tool was built without
   * a credentials config and the Google client falls back to application
   * default credentials.
   */
  credentials?: AuthClient;
  /** The toolset-supplied settings, such as a result-row cap. */
  settings?: TSettings;
  /** The context of this tool call. */
  toolContext: Context;
}

/** The implementation a {@link GoogleTool} runs once credentials resolve. */
export type GoogleToolExecuteFunction<
  TParameters extends ToolInputParameters,
  TSettings,
> = (
  input: ToolExecuteArgument<TParameters>,
  call: GoogleToolCall<TSettings>,
) => Promise<unknown> | unknown;

/** The configuration for creating a {@link GoogleTool}. */
export interface GoogleToolOptions<
  TParameters extends ToolInputParameters,
  TSettings,
> {
  name: string;
  description: string;
  /**
   * The schema of the arguments the model supplies. Credentials and settings
   * are never part of it: they reach {@link execute} through its
   * {@link GoogleToolCall}, so the model can neither see nor set them.
   */
  parameters?: TParameters;
  execute: GoogleToolExecuteFunction<TParameters, TSettings>;
  /**
   * How to obtain Google credentials. Leave it unset and the tool runs
   * without credentials, letting the Google client find its own.
   */
  credentialsConfig?: BaseGoogleCredentialsConfig;
  /** Tool-specific settings, supplied by the toolset that builds the tool. */
  toolSettings?: TSettings;
}

/**
 * The message a tool returns while the end user has yet to grant consent.
 * The model relays it, and the host drives the OAuth2 flow the tool started.
 */
export function authorizationRequiredMessage(toolName: string): string {
  return (
    `User authorization is required to access Google services for ` +
    `${toolName}. Please complete the authorization flow.`
  );
}

/**
 * A hand-crafted tool that calls a Google API (Experimental).
 *
 * It owns the credential handling that every Google API tool repeats:
 * resolving credentials, starting an OAuth2 consent flow when there are none,
 * and reporting a failure to the model as a result rather than as a thrown
 * error. Subclasses and callers supply only the API call itself.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class GoogleTool<
  TParameters extends ToolInputParameters = undefined,
  TSettings = unknown,
> extends FunctionTool<TParameters> {
  private readonly credentialsManager?: GoogleCredentialsManager;
  private readonly toolSettings?: TSettings;
  private readonly googleExecute: GoogleToolExecuteFunction<
    TParameters,
    TSettings
  >;

  constructor(options: GoogleToolOptions<TParameters, TSettings>) {
    super({
      name: options.name,
      description: options.description,
      parameters: options.parameters,
      // A plain function tool's callback takes an optional context, but
      // `RunAsyncToolRequest` requires one, so every call carries it.
      execute: (input, toolContext) =>
        this.executeWithCredentials(input, toolContext!),
    });
    this.googleExecute = options.execute;
    this.credentialsManager = options.credentialsConfig
      ? new GoogleCredentialsManager(options.credentialsConfig)
      : undefined;
    this.toolSettings = options.toolSettings;
  }

  /**
   * Runs the tool, reporting any failure to the model as an error result.
   *
   * A Google API tool never throws at the model: an exception would abort the
   * turn, where an error result lets the model explain the failure or try
   * something else.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      return await super.runAsync(req);
    } catch (e: unknown) {
      return {
        status: GoogleToolStatus.ERROR,
        errorDetails: formatError(e),
      } satisfies GoogleToolError;
    }
  }

  /** Resolves credentials, then runs the API call. */
  private async executeWithCredentials(
    input: ToolExecuteArgument<TParameters>,
    toolContext: Context,
  ): Promise<unknown> {
    const call: GoogleToolCall<TSettings> = {
      settings: this.toolSettings,
      toolContext,
    };
    if (!this.credentialsManager) {
      return this.googleExecute(input, call);
    }
    const credentials =
      await this.credentialsManager.getValidCredentials(toolContext);
    if (!credentials) {
      return authorizationRequiredMessage(this.name);
    }
    return this.googleExecute(input, {...call, credentials});
  }
}
