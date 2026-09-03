/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import {AuthClient} from 'google-auth-library';

import {formatError} from '../utils/error_utils.js';
import {experimental} from '../utils/experimental.js';
import {isZodObject} from '../utils/simple_zod_to_json.js';

import {RunAsyncToolRequest} from './base_tool.js';
import {
  FunctionTool,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';
import {
  BaseGoogleCredentialsConfig,
  GoogleCredentialsManager,
} from './google_credentials.js';

/** The parameter that carries the resolved credential into the function. */
const CREDENTIALS_PARAM = 'credentials';

/** The parameter that carries the tool settings into the function. */
const SETTINGS_PARAM = 'settings';

/** The parameters a {@link GoogleTool} injects and never shows to the model. */
const IGNORED_PARAMS: readonly string[] = [CREDENTIALS_PARAM, SETTINGS_PARAM];

/** The telemetry error type reported for a {@link GoogleToolErrorResponse}. */
const TOOL_ERROR = 'TOOL_ERROR';

/**
 * The structured error a {@link GoogleTool} returns instead of throwing.
 */
export interface GoogleToolErrorResponse {
  status: 'ERROR';
  /**
   * The failure message. The key crosses the language boundary — adk-python
   * emits the same one — so it stays snake_case.
   */
  error_details: string;
}

/**
 * The configuration options for creating a {@link GoogleTool}.
 */
export interface GoogleToolOptions<
  TParameters extends ToolInputParameters,
> extends ToolOptions<TParameters> {
  /**
   * How to obtain a Google credential. Omit it and the tool runs no credential
   * machinery: it injects nothing and it never asks for authorization.
   */
  credentialsConfig?: BaseGoogleCredentialsConfig;
  /**
   * Tool-specific settings, supplied by the toolset that builds the tool.
   * Declare a `settings` parameter to receive them.
   */
  toolSettings?: unknown;
}

/** Whether the declared parameters ask for `name`. */
function declaresParam(parameters: ToolInputParameters, name: string): boolean {
  if (parameters === undefined) {
    return false;
  }
  if (isZodObject(parameters)) {
    return name in parameters.shape;
  }
  return parameters.properties?.[name] !== undefined;
}

/**
 * A copy of the declaration without the injected parameters.
 *
 * The copy matters: for a `Schema` the base class hands back the caller's own
 * object, and removing a property in place would edit the user's schema.
 */
function withoutIgnoredParams(
  declaration: FunctionDeclaration,
): FunctionDeclaration {
  const parameters = {...declaration.parameters};
  const properties = {...parameters.properties};
  for (const name of IGNORED_PARAMS) {
    delete properties[name];
  }
  parameters.properties = properties;
  if (parameters.required) {
    parameters.required = parameters.required.filter(
      (name) => !IGNORED_PARAMS.includes(name),
    );
  }
  return {...declaration, parameters};
}

/** Whether a tool response carries an in-band error. */
function isToolErrorResponse(response: unknown): boolean {
  return (
    typeof response === 'object' &&
    response !== null &&
    'status' in response &&
    response.status === 'ERROR'
  );
}

/**
 * A {@link FunctionTool} that calls a Google API (Experimental).
 *
 * Use it to handcraft a Google API tool, rather than generating one from an
 * API spec. It resolves the credential, injects it and the tool settings into
 * the call, and returns a {@link GoogleToolErrorResponse} instead of throwing.
 *
 * Declare a `credentials` parameter to receive the resolved credential, and a
 * `settings` parameter to receive {@link GoogleToolOptions.toolSettings}. The
 * model sees neither and cannot supply either: the tool strips both from the
 * declaration and drops both from the incoming call arguments.
 *
 * When no credential is available the tool asks the end user for consent and
 * returns a message saying so, without running the function.
 *
 * Please do not use this in production, as it may be deprecated later.
 */
@experimental
export class GoogleTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  private readonly credentialsManager?: GoogleCredentialsManager;
  private readonly toolSettings?: unknown;
  private readonly declaresCredentials: boolean;
  private readonly declaresSettings: boolean;

  constructor(options: GoogleToolOptions<TParameters>) {
    const {credentialsConfig, toolSettings, ...toolOptions} = options;
    super(toolOptions);

    this.credentialsManager = credentialsConfig
      ? new GoogleCredentialsManager(credentialsConfig)
      : undefined;
    this.toolSettings = toolSettings;
    this.declaresCredentials = declaresParam(
      options.parameters,
      CREDENTIALS_PARAM,
    );
    this.declaresSettings = declaresParam(options.parameters, SETTINGS_PARAM);
  }

  /**
   * The declaration the model reads, without the injected parameters.
   */
  override _getDeclaration(): FunctionDeclaration {
    return withoutIgnoredParams(super._getDeclaration());
  }

  /**
   * Resolves the credential, then runs the function with it.
   *
   * @param req The tool request containing arguments and tool context.
   * @return The function's return value, the authorization-required message
   *     when the end user has not granted consent yet, or a
   *     {@link GoogleToolErrorResponse} when anything failed.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      let credentials: AuthClient | undefined;
      if (this.credentialsManager) {
        credentials = await this.credentialsManager.getValidCredentials(
          req.toolContext,
        );
        if (!credentials) {
          return (
            'User authorization is required to access Google services for' +
            ` ${this.name}. Please complete the authorization flow.`
          );
        }
      }

      return await super.runAsync({
        args: this.injectArgs(req.args, credentials),
        toolContext: req.toolContext,
      });
    } catch (e: unknown) {
      const response: GoogleToolErrorResponse = {
        status: 'ERROR',
        error_details: formatError(e),
      };
      return response;
    }
  }

  /**
   * Telemetry hook reporting the error type of an in-band error response, as
   * adk-python's `_detect_error_in_response` does. No caller in adk-js reads
   * it yet; a caller reaches it through the tool, so it carries no `override`.
   *
   * @param response The value {@link runAsync} returned.
   * @return `'TOOL_ERROR'` for a {@link GoogleToolErrorResponse}, otherwise
   *     `undefined`.
   */
  detectErrorInResponse(response: unknown): string | undefined {
    return isToolErrorResponse(response) ? TOOL_ERROR : undefined;
  }

  /**
   * The call arguments the function runs with: the model's arguments, minus
   * anything it sent for an injected parameter, plus each injected parameter
   * the function declared.
   */
  private injectArgs(
    args: Record<string, unknown>,
    credentials: AuthClient | undefined,
  ): Record<string, unknown> {
    const argsToCall = {...args};
    for (const name of IGNORED_PARAMS) {
      delete argsToCall[name];
    }
    if (this.declaresCredentials) {
      argsToCall[CREDENTIALS_PARAM] = credentials;
    }
    if (this.declaresSettings) {
      argsToCall[SETTINGS_PARAM] = this.toolSettings;
    }
    return argsToCall;
  }
}
