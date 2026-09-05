/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {formatError} from '../../utils/error_utils.js';
import {RunAsyncToolRequest} from '../base_tool.js';
import {
  FunctionTool,
  ToolExecuteArgument,
  ToolInputParameters,
} from '../function_tool.js';

import {
  BigQueryCredentials,
  BigQueryCredentialsConfig,
  BigQueryCredentialsManager,
} from './bigquery_credentials.js';

/** A unique symbol identifying the BigQuery tool class. */
const BIGQUERY_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.bigQueryTool');

/**
 * The payload a BigQuery tool returns instead of throwing.
 *
 * The keys are model-facing and stay `snake_case` so that a model prompted for
 * either SDK sees the same result shape.
 */
export interface BigQueryToolError {
  status: 'ERROR';
  error_details: string;
}

/** Describes `err` in the error payload the model receives. */
export function toBigQueryToolError(err: unknown): BigQueryToolError {
  return {status: 'ERROR', error_details: formatError(err)};
}

/**
 * The implementation behind a {@link BigQueryTool}: the model-supplied
 * arguments, plus the credential the tool resolved for this call.
 */
export type BigQueryToolExecute<TParameters extends ToolInputParameters> = (
  input: ToolExecuteArgument<TParameters>,
  credentials: BigQueryCredentials | undefined,
  toolContext?: Context,
) => Promise<unknown>;

/** The configuration for a {@link BigQueryTool}. */
export interface BigQueryToolOptions<
  TParameters extends ToolInputParameters = undefined,
> {
  name: string;
  description: string;
  parameters: TParameters;
  execute: BigQueryToolExecute<TParameters>;
  /**
   * How to obtain the OAuth credential. When absent the tool runs without one
   * and the BigQuery client falls back to application default credentials.
   */
  credentialsConfig?: BigQueryCredentialsConfig;
}

/** Whether `obj` is a {@link BigQueryTool}. */
export function isBigQueryTool(
  obj: unknown,
): obj is BigQueryTool<ToolInputParameters> {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BIGQUERY_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[BIGQUERY_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A hand-written tool that calls a Google API on the end user's behalf.
 *
 * It resolves the OAuth credential before each call, and turns any failure —
 * argument validation, authorization, or the API itself — into a
 * {@link BigQueryToolError} rather than throwing, so that the model receives a
 * result it can act on.
 */
export class BigQueryTool<
  TParameters extends ToolInputParameters = undefined,
> extends FunctionTool<TParameters> {
  /** A unique symbol identifying the ADK BigQuery tool class. */
  readonly [BIGQUERY_TOOL_SIGNATURE_SYMBOL] = true;

  constructor(options: BigQueryToolOptions<TParameters>) {
    // The adapter closes over constructor locals rather than over `this`, so
    // that concurrent calls of one shared tool instance cannot see each
    // other's credential.
    const credentialsManager = options.credentialsConfig
      ? new BigQueryCredentialsManager(options.credentialsConfig)
      : undefined;
    const {name, execute} = options;

    super({
      name,
      description: options.description,
      parameters: options.parameters,
      execute: async (input, toolContext) => {
        if (!credentialsManager) {
          return execute(input, undefined, toolContext);
        }
        if (!toolContext) {
          throw new Error(`Tool '${name}' requires a tool context.`);
        }
        const credentials =
          await credentialsManager.getValidCredentials(toolContext);
        if (!credentials) {
          return (
            'User authorization is required to access Google services for ' +
            `${name}. Please complete the authorization flow.`
          );
        }
        return execute(input, credentials, toolContext);
      },
    });
  }

  /**
   * Runs the tool, reporting any failure as a {@link BigQueryToolError}.
   *
   * @param req The model-supplied arguments and the tool context.
   * @return The tool's result, or the error payload.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      return await super.runAsync(req);
    } catch (err: unknown) {
      return toBigQueryToolError(err);
    }
  }
}
