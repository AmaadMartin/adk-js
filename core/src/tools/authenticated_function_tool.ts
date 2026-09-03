/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';

import {AuthCredential} from '../auth/auth_credential.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {CredentialManager} from '../auth/credential_manager.js';
import {experimental} from '../utils/experimental.js';
import {logger} from '../utils/logger.js';
import {isZodObject} from '../utils/simple_zod_to_json.js';

import {RunAsyncToolRequest} from './base_tool.js';
import {
  FunctionTool,
  ToolInputParameters,
  ToolOptions,
} from './function_tool.js';

/** The parameter that carries the resolved credential into the function. */
const CREDENTIAL_PARAM = 'credential';

/**
 * What an {@link AuthenticatedFunctionTool} returns while it waits for the
 * client to supply a credential.
 */
export const PENDING_USER_AUTHORIZATION = 'Pending User Authorization.';

/**
 * The configuration options for an {@link AuthenticatedFunctionTool}.
 */
export interface AuthenticatedFunctionToolOptions<
  TParameters extends ToolInputParameters,
> extends ToolOptions<TParameters> {
  /**
   * What the tool authenticates with. Without it, or without its `authScheme`,
   * the tool skips authentication and runs the function.
   */
  authConfig?: AuthConfig;

  /**
   * What to return while the client supplies a credential. Defaults to
   * {@link PENDING_USER_AUTHORIZATION}.
   */
  responseForAuthRequired?: Record<string, unknown> | string;
}

/**
 * Whether the declared parameters ask for the credential.
 */
function declaresCredentialParam(parameters: ToolInputParameters): boolean {
  if (parameters === undefined) {
    return false;
  }
  if (isZodObject(parameters)) {
    return CREDENTIAL_PARAM in parameters.shape;
  }
  return parameters.properties?.[CREDENTIAL_PARAM] !== undefined;
}

/**
 * A copy of the declaration without the credential parameter.
 *
 * The copy matters: for a `Schema` the base class hands back the caller's own
 * object, and removing a property in place would edit the user's schema.
 */
function withoutCredentialParam(
  declaration: FunctionDeclaration,
): FunctionDeclaration {
  const parameters = declaration.parameters;
  if (!parameters?.properties) {
    return declaration;
  }
  const properties = {...parameters.properties};
  delete properties[CREDENTIAL_PARAM];
  return {
    ...declaration,
    parameters: {
      ...parameters,
      properties,
      ...(parameters.required
        ? {
            required: parameters.required.filter(
              (name) => name !== CREDENTIAL_PARAM,
            ),
          }
        : {}),
    },
  };
}

/**
 * A {@link FunctionTool} that resolves an authentication credential before it
 * runs the function.
 *
 * Declare a `credential` parameter to receive the resolved
 * {@link AuthCredential}. The model never sees that parameter and cannot supply
 * it: the tool strips it from the declaration and overwrites any value that
 * arrives in the call arguments.
 *
 * When no credential is available the tool asks the client for one and returns
 * {@link AuthenticatedFunctionToolOptions.responseForAuthRequired} without
 * running the function. The invocation pauses, and the client resumes it once
 * the user has granted consent.
 */
@experimental
export class AuthenticatedFunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  private readonly credentialManager?: CredentialManager;
  private readonly declaresCredential: boolean;
  private readonly responseForAuthRequired: Record<string, unknown> | string;

  constructor(options: AuthenticatedFunctionToolOptions<TParameters>) {
    const {authConfig, responseForAuthRequired, ...toolOptions} = options;
    super(toolOptions);

    if (authConfig?.authScheme) {
      this.credentialManager = new CredentialManager(authConfig);
    } else {
      logger.warn(
        `Tool '${this.name}' has no authConfig.authScheme, so it will skip ` +
          'authentication. Use FunctionTool when no credential is required.',
      );
    }
    this.declaresCredential = declaresCredentialParam(options.parameters);
    this.responseForAuthRequired =
      responseForAuthRequired ?? PENDING_USER_AUTHORIZATION;
  }

  /**
   * The declaration the model reads, without the credential parameter.
   */
  override _getDeclaration(): FunctionDeclaration {
    const declaration = super._getDeclaration();
    return this.declaresCredential
      ? withoutCredentialParam(declaration)
      : declaration;
  }

  /**
   * Resolves the credential, then runs the function with it.
   *
   * @param req The tool request containing arguments and tool context.
   * @return The function's return value, or the pending-authorization response
   *     when no credential is available yet.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    let credential: AuthCredential | undefined;
    if (this.credentialManager) {
      credential = await this.credentialManager.getAuthCredential(
        req.toolContext,
      );
      if (!credential) {
        this.credentialManager.requestCredential(req.toolContext);
        return this.responseForAuthRequired;
      }
    }

    // Auth runs before the base class validates the arguments, matching
    // Python's run_async -> _run_async_impl -> super().run_async() chain: a
    // call that cannot authenticate never reaches the confirmation gate.
    return super.runAsync({
      args: this.declaresCredential
        ? {...req.args, [CREDENTIAL_PARAM]: credential}
        : req.args,
      toolContext: req.toolContext,
    });
  }
}
