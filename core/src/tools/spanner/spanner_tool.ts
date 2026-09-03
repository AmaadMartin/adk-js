/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration} from '@google/genai';
import type {AuthClient} from 'google-auth-library';
import {z} from 'zod';
import {zodObjectToSchema} from '../../utils/simple_zod_to_json.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {SpannerToolSettings} from './settings.js';
import {
  SpannerCredentialsConfig,
  SpannerCredentialsManager,
} from './spanner_credentials.js';

/** The outcome the Spanner tools report back to the model. */
export enum SpannerToolStatus {
  SUCCESS = 'SUCCESS',
  ERROR = 'ERROR',
}

/** A failed Spanner tool call. */
export interface SpannerErrorResult {
  status: SpannerToolStatus.ERROR;
  error_details: string;
}

/** A metadata tool result. */
export interface SpannerResultsResult {
  status: SpannerToolStatus.SUCCESS;
  results: unknown;
}

/** A query or search result. */
export interface SpannerRowsResult {
  status: SpannerToolStatus.SUCCESS;
  rows: unknown[];
  /** Set when the row cap was reached and more rows may match. */
  result_is_likely_truncated?: boolean;
}

/** What a Spanner tool returns to the model. */
export type SpannerToolResult =
  | SpannerErrorResult
  | SpannerResultsResult
  | SpannerRowsResult;

/** The parameter schema shape a Spanner tool declares. */
export type SpannerToolParameters = z.ZodObject<z.ZodRawShape>;

/** One Spanner tool call: the model's arguments plus the injected context. */
export interface SpannerToolCall<TArgs> {
  /** The arguments the model supplied, validated against the schema. */
  args: TArgs;
  /** The resolved credentials, absent when no credentials are configured. */
  credentials?: AuthClient;
  /** The toolset's settings. */
  settings: SpannerToolSettings;
}

/** The body of a Spanner tool. */
export type SpannerToolExecute<TArgs> = (
  call: SpannerToolCall<TArgs>,
) => Promise<SpannerToolResult>;

/** What every Spanner tool factory needs from the toolset. */
export interface SpannerToolFactoryOptions {
  credentialsConfig?: SpannerCredentialsConfig;
  toolSettings: SpannerToolSettings;
  /** The toolset's name prefix, prepended to the tool's own name. */
  prefix?: string;
}

/** Options for {@link SpannerTool.create}. */
export interface SpannerToolOptions<
  TParameters extends SpannerToolParameters,
> extends SpannerToolFactoryOptions {
  name: string;
  description: string;
  parameters: TParameters;
  execute: SpannerToolExecute<z.output<TParameters>>;
}

/** A tool body with its argument type erased, as the class stores it. */
type ErasedExecute = (
  args: unknown,
  credentials: AuthClient | undefined,
  settings: SpannerToolSettings,
) => Promise<SpannerToolResult>;

/**
 * A Spanner tool: a function declaration the model can call, with credentials
 * and settings injected around it.
 *
 * The credentials and the settings come from the toolset, not from the model,
 * so they never appear in the declaration. Every failure — a rejected
 * argument, an unreachable database, a bad filter — comes back as
 * `{status: 'ERROR', error_details}` rather than as a thrown error, matching
 * adk-python's `GoogleTool`.
 */
export class SpannerTool extends BaseTool {
  /**
   * The tool's name without the toolset's prefix. A `toolFilter` matches
   * this, while the model sees the prefixed {@link name}.
   */
  readonly baseName: string;

  private readonly parameters: SpannerToolParameters;
  private readonly execute: ErasedExecute;
  private readonly settings: SpannerToolSettings;
  private readonly credentialsManager?: SpannerCredentialsManager;

  private constructor(
    name: string,
    baseName: string,
    description: string,
    parameters: SpannerToolParameters,
    execute: ErasedExecute,
    settings: SpannerToolSettings,
    credentialsConfig?: SpannerCredentialsConfig,
  ) {
    super({name, description});
    this.baseName = baseName;
    this.parameters = parameters;
    this.execute = execute;
    this.settings = settings;
    this.credentialsManager = credentialsConfig
      ? new SpannerCredentialsManager(credentialsConfig)
      : undefined;
  }

  /**
   * Builds a Spanner tool, binding its parameter schema to the argument type
   * its body receives.
   */
  static create<TParameters extends SpannerToolParameters>(
    options: SpannerToolOptions<TParameters>,
  ): SpannerTool {
    const {parameters, execute} = options;
    return new SpannerTool(
      options.prefix ? `${options.prefix}_${options.name}` : options.name,
      options.name,
      options.description,
      parameters,
      (args, credentials, settings) =>
        execute({args: parameters.parse(args), credentials, settings}),
      options.toolSettings,
      options.credentialsConfig,
    );
  }

  override _getDeclaration(): FunctionDeclaration {
    return {
      name: this.name,
      description: this.description,
      parameters: zodObjectToSchema(this.parameters),
    };
  }

  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<SpannerToolResult | string> {
    try {
      const credentials =
        await this.credentialsManager?.getValidCredentials(toolContext);
      if (this.credentialsManager && !credentials) {
        return (
          'User authorization is required to access Google services for ' +
          `${this.name}. Please complete the authorization flow.`
        );
      }
      return await this.execute(args, credentials, this.settings);
    } catch (err: unknown) {
      return errorResult(err);
    }
  }
}

/** Renders an error the way the Spanner tools report it to the model. */
export function toErrorDetails(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Builds the error envelope every Spanner tool failure returns. */
function errorResult(err: unknown): SpannerErrorResult {
  return {
    status: SpannerToolStatus.ERROR,
    error_details: toErrorDetails(err),
  };
}
