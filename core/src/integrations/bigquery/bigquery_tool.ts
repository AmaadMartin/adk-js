/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {OAuth2Client} from 'google-auth-library';

import {Context} from '../../agents/context.js';
import {RunAsyncToolRequest} from '../../tools/base_tool.js';
import {
  FunctionTool,
  ToolExecuteArgument,
  ToolInputParameters,
  ToolOptions,
} from '../../tools/function_tool.js';
import {formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';

import {BigQueryCredentialsConfig} from './bigquery_credentials.js';
import {BigQueryCredentialsManager} from './bigquery_credentials_manager.js';

/**
 * The signature of the function a {@link BigQueryTool} runs: the tool's
 * validated arguments, plus the credential resolved for the current end user.
 */
export type BigQueryToolExecuteFunction<
  TParameters extends ToolInputParameters,
> = (
  input: ToolExecuteArgument<TParameters>,
  credentials: OAuth2Client | undefined,
  toolContext?: Context,
) => Promise<unknown> | unknown;

/** The options accepted by {@link BigQueryTool}. */
export interface BigQueryToolOptions<
  TParameters extends ToolInputParameters,
> extends Omit<ToolOptions<TParameters>, 'execute'> {
  execute: BigQueryToolExecuteFunction<TParameters>;
  /**
   * How to obtain a credential. Omit it to run the function with no credential,
   * as adk-python's `credentials=None` does.
   */
  credentials?: BigQueryCredentialsConfig;
}

/**
 * What a {@link BigQueryTool} returns to the model when its function throws.
 *
 * Field names use snake_case to match the model-facing payload adk-python
 * emits, as `ToolFailureResponse` does.
 */
export interface BigQueryToolErrorResponse {
  status: 'ERROR';
  error_details: string;
}

/**
 * A hand-crafted BigQuery API tool that resolves a Google OAuth credential
 * before it runs (experimental).
 *
 * Reach for it when you write the BigQuery call yourself and do not want to
 * write the OAuth dance too. The tool resolves a credential for the current end
 * user, hands it to your function, and asks the end user to authorize when
 * there is nothing to hand over. The credential is not part of the declaration
 * the model sees.
 *
 * The BigQuery tools are hand-crafted rather than generated from the API
 * definition because the generated shape serves a model poorly: the BigQuery
 * API's functions overlap, so a model cannot tell which one to call, and they
 * carry many rarely-used parameters. Hand-crafting also allows higher-level
 * tools and access guardrails.
 */
@experimental
export class BigQueryTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  /** Resolves the credential, or `undefined` when the tool needs none. */
  readonly credentialsManager?: BigQueryCredentialsManager;

  /**
   * @param options The tool declaration, the function to run, and how to
   *     obtain a credential for it.
   */
  constructor(options: BigQueryToolOptions<TParameters>) {
    const {credentials, execute, ...toolOptions} = options;
    const credentialsManager = credentials
      ? new BigQueryCredentialsManager(credentials)
      : undefined;
    // `FunctionTool` derives a missing name from the callback it is given, so
    // the developer's function has to supply it before the wrapper hides it.
    const name = options.name ?? execute.name;

    super({
      ...toolOptions,
      name,
      execute: async (input, toolContext) => {
        const resolved =
          credentialsManager && toolContext
            ? await credentialsManager.getValidCredentials(toolContext)
            : undefined;
        if (credentialsManager && !resolved) {
          return (
            `User authorization is required to access Google services for ` +
            `${name}. Please complete the authorization flow.`
          );
        }
        return execute(input, resolved, toolContext);
      },
    });

    this.credentialsManager = credentialsManager;
  }

  /**
   * Runs the tool, reporting any failure to the model as a structured payload
   * rather than throwing.
   *
   * @param req The validated arguments and the context of the call.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      return await super.runAsync(req);
    } catch (error: unknown) {
      return {
        status: 'ERROR',
        error_details: formatError(error),
      } satisfies BigQueryToolErrorResponse;
    }
  }
}
