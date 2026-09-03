/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema} from '@google/genai';
import {AuthClient} from 'google-auth-library';

import {Context} from '../agents/context.js';
import {formatError} from '../utils/error_utils.js';
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
 * The arguments a {@link GoogleTool} injects itself, and therefore never
 * advertises to the model nor accepts from it.
 */
const IGNORED_PARAMS: readonly string[] = ['credentials', 'settings'];

/** The telemetry error type reported for an in-band tool error. */
const TOOL_ERROR = 'TOOL_ERROR';

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
  status: 'ERROR';
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
      execute: async (input, toolContext) => {
        if (!credentialsManager) {
          return execute(input, toolContext, {settings: toolSettings});
        }
        // `FunctionTool.runAsync` always supplies the tool context; the
        // parameter is optional only so a wrapped function may omit it.
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
   * The declaration the model sees, with the injected parameters removed.
   *
   * @return The function declaration, carrying neither `credentials` nor
   *     `settings`.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = super._getDeclaration();
    // `FunctionTool` always builds a parameters schema, even when the tool
    // declares no parameters.
    const {properties, required, ...schema} = declaration.parameters!;
    return {
      ...declaration,
      parameters: {
        ...schema,
        properties: withoutIgnoredProperties(properties),
        required: required?.filter((name) => !IGNORED_PARAMS.includes(name)),
      },
    };
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
      return await super.runAsync({
        ...req,
        args: withoutIgnoredArgs(req.args),
      });
    } catch (error: unknown) {
      const response: GoogleToolErrorResponse = {
        status: 'ERROR',
        error_details: formatError(error),
      };
      return response;
    }
  }

  /**
   * Telemetry hook: the error type carried by an in-band error response.
   *
   * @param response A value the tool returned.
   * @return `'TOOL_ERROR'` when the response reports a failure, otherwise
   *     `undefined`. It never throws, whatever it is given.
   */
  detectErrorInResponse(response: unknown): string | undefined {
    const reportsError =
      typeof response === 'object' &&
      response !== null &&
      'status' in response &&
      response.status === 'ERROR';
    return reportsError ? TOOL_ERROR : undefined;
  }
}

/** The message returned while the end user completes an OAuth flow. */
function authorizationRequiredMessage(toolName: string): string {
  return `User authorization is required to access Google services for ${toolName}. Please complete the authorization flow.`;
}

/**
 * Drops the injected parameters from the model-supplied arguments, so a model
 * that hallucinates a `credentials` argument cannot reach the function with it.
 */
function withoutIgnoredArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(args).filter(([name]) => !IGNORED_PARAMS.includes(name)),
  );
}

/** Drops the injected parameters from a declared property map. */
function withoutIgnoredProperties(
  properties: Record<string, Schema> | undefined,
): Record<string, Schema> | undefined {
  return properties
    ? Object.fromEntries(
        Object.entries(properties).filter(
          ([name]) => !IGNORED_PARAMS.includes(name),
        ),
      )
    : properties;
}
