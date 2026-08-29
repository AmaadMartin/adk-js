/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Schema, Type} from '@google/genai';
import {cloneDeep} from 'lodash-es';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';

import {FeatureName, isFeatureEnabled} from '../features/feature_registry.js';
import {toJsonSchema, tryParseWithSchema} from '../utils/schema.js';
import {
  flattenNullableAnyOf,
  stripUnsupportedGeminiFormats,
} from '../utils/schema_variant_utils.js';
import {isZodObject, zodObjectToSchema} from '../utils/simple_zod_to_json.js';
import {GoogleLLMVariant} from '../utils/variant_utils.js';

import {Context} from '../agents/context.js';
import {BaseTool, RunAsyncToolRequest} from './base_tool.js';

/**
 * Input parameters of the function tool.
 */
export type ToolInputParameters =
  | z3.ZodObject<z3.ZodRawShape>
  | z4.ZodObject<z4.ZodRawShape>
  | Schema
  | undefined;

/**
 * The arguments passed to the function tool's `execute` callback, inferred
 * from the `parameters` schema type.
 */
export type ToolExecuteArgument<TParameters extends ToolInputParameters> =
  TParameters extends z3.ZodObject<infer T, infer U, infer V>
    ? z3.infer<z3.ZodObject<T, U, V>>
    : TParameters extends z4.ZodObject<infer T>
      ? z4.infer<z4.ZodObject<T>>
      : TParameters extends Schema
        ? unknown
        : string;

/**
 * The signature of the user-provided function executed by a {@link FunctionTool}.
 */
export type ToolExecuteFunction<TParameters extends ToolInputParameters> = (
  input: ToolExecuteArgument<TParameters>,
  toolContext?: Context,
) => Promise<unknown> | unknown;

/**
 * Whether a {@link FunctionTool} requires user confirmation before it runs: a
 * boolean, or a predicate over the (validated) call arguments and tool context.
 * See {@link ToolOptions.requireConfirmation}.
 */
export type RequireConfirmation<TParameters extends ToolInputParameters> =
  | boolean
  | ((
      input: ToolExecuteArgument<TParameters>,
      toolContext?: Context,
    ) => boolean | Promise<boolean>);

/**
 * The configuration options for creating a function-based tool.
 * The `name`, `description` and `parameters` fields are used to generate the
 * tool definition that is passed to the LLM prompt.
 *
 * Note: Unlike Python's ADK, JSDoc on the `execute` function is ignored
 * for tool definition generation.
 */
export type ToolOptions<TParameters extends ToolInputParameters> = {
  /**
   * The name the model is told about, which is also the name the framework
   * registers the tool under. Defaults to the `execute` function's own name.
   */
  name?: string;
  /** Defaults to an empty string, matching a Python tool with no docstring. */
  description?: string;
  parameters?: TParameters;
  execute: ToolExecuteFunction<TParameters>;
  isLongRunning?: boolean;
  /**
   * Whether this tool requires user confirmation before it runs. A boolean, or
   * a predicate over the (validated) call arguments and tool context returning
   * a boolean.
   *
   * The HITL gate is enforced when the tool is invoked through an `LlmAgent`
   * turn: `agents/functions.ts` surfaces an `adk_request_confirmation`
   * interrupt from the tool's `requestedToolConfirmations`, and the tool only
   * executes once the user approves (via the
   * `RequestConfirmationLlmRequestProcessor`).
   *
   * NOTE: a workflow `ToolNode` does not yet route through that path, so a
   * `requireConfirmation` tool used directly as a node does not pause — it
   * returns the "requires confirmation" error as its node output. Approval for
   * workflow nodes is not wired up. Mirrors Python's
   * `FunctionTool(require_confirmation=...)`.
   */
  requireConfirmation?: RequireConfirmation<TParameters>;
};

/** The `error.type` a tool reports for a response that carries an error. */
const TOOL_ERROR = 'TOOL_ERROR';

/** The schema of a tool that declares no parameters. */
function emptyObjectSchema(): Schema {
  return {type: Type.OBJECT, properties: {}};
}

function toSchema<TParameters extends ToolInputParameters>(
  parameters: TParameters,
): Schema {
  if (parameters === undefined) {
    return emptyObjectSchema();
  }

  if (isZodObject(parameters)) {
    return zodObjectToSchema(parameters);
  }

  return parameters;
}

/**
 * Renders a tool as the declaration sent to the model.
 *
 * Exactly one of `parameters` and `parametersJsonSchema` is populated: the
 * JSON-schema form is what the `JSON_SCHEMA_FOR_FUNC_DECL` feature selects,
 * and the genai `Schema` form is the default. Mirrors adk-python's
 * `build_function_declaration`.
 *
 * The result shares no object with `parameters`, so a caller that keeps its
 * own `Schema` and later edits it cannot reach a cached declaration.
 */
function buildDeclaration(
  name: string,
  description: string,
  parameters: ToolInputParameters,
  variant: GoogleLLMVariant,
  jsonSchema: boolean,
): FunctionDeclaration {
  if (jsonSchema) {
    const rendered = toJsonSchema(parameters ?? emptyObjectSchema());
    return {
      name,
      description,
      parametersJsonSchema:
        variant === GoogleLLMVariant.VERTEX_AI
          ? flattenNullableAnyOf(rendered)
          : rendered,
    };
  }
  const schema = cloneDeep(toSchema(parameters));
  return {
    name,
    description,
    parameters:
      variant === GoogleLLMVariant.GEMINI_API
        ? stripUnsupportedGeminiFormats(schema)
        : schema,
  };
}

/** The declared-required keys absent from `args`, in declaration order. */
function missingRequiredArgs(
  schema: Schema,
  args: Record<string, unknown>,
): string[] {
  return (schema.required ?? []).filter((name) => !Object.hasOwn(args, name));
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const FUNCTION_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.functionTool');

/**
 * Type guard to check if an object is an instance of BaseTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseTool, false otherwise.
 */
export function isFunctionTool(obj: unknown): obj is FunctionTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    FUNCTION_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[FUNCTION_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * A tool that wraps a user-defined function, making it callable by an LLM.
 *
 * The function's name, description, and parameter schema are exposed to the
 * model as a function declaration. When the model requests a call, the
 * framework validates the arguments and invokes the user-provided `execute`
 * callback.
 */
export class FunctionTool<
  TParameters extends ToolInputParameters = undefined,
> extends BaseTool {
  /** A unique symbol to identify ADK function tool class. */
  readonly [FUNCTION_TOOL_SIGNATURE_SYMBOL] = true;

  // User defined function.
  private readonly execute: ToolExecuteFunction<TParameters>;
  // Typed input parameters.
  private readonly parameters?: TParameters;
  // Whether the tool requires user confirmation before running.
  private readonly requireConfirmation: RequireConfirmation<TParameters>;
  // The last built declaration, and the `variant:jsonSchema` key it is for.
  private cache?: {key: string; declaration: FunctionDeclaration};

  /**
   * The constructor acts as the user-friendly factory.
   * @param options The configuration for the tool.
   */
  constructor(options: ToolOptions<TParameters>) {
    const name = options.name ?? (options.execute as {name?: string}).name;
    if (!name) {
      throw new Error(
        'Tool name cannot be empty. Either name the `execute` function or provide a `name`.',
      );
    }
    super({
      name,
      description: options.description ?? '',
      isLongRunning: options.isLongRunning,
    });
    this.execute = options.execute;
    this.parameters = options.parameters;
    this.requireConfirmation = options.requireConfirmation ?? false;
  }

  /**
   * Returns the function declaration derived from the tool's name, description,
   * and parameter schema.
   *
   * The build is cached, and rebuilds when the API variant or the
   * `JSON_SCHEMA_FOR_FUNC_DECL` feature changes. Every call returns a fresh
   * copy, so a caller that prefixes the name or annotates the schema — as
   * {@link LongRunningFunctionTool} does — never mutates the cached
   * declaration or the tool itself.
   */
  override _getDeclaration(): FunctionDeclaration {
    const variant = this.apiVariant;
    const jsonSchema = isFeatureEnabled(FeatureName.JSON_SCHEMA_FOR_FUNC_DECL);
    const key = `${variant}:${jsonSchema}`;
    let cache = this.cache;
    if (cache?.key !== key) {
      cache = {
        key,
        declaration: buildDeclaration(
          this.name,
          this.description,
          this.parameters,
          variant,
          jsonSchema,
        ),
      };
      this.cache = cache;
    }
    return cloneDeep(cache.declaration);
  }

  /**
   * The error type to record on this call's telemetry span, or `undefined`
   * when the response is not a failure.
   *
   * A tool reports a failure by returning `{error: ...}` rather than by
   * throwing, which is otherwise indistinguishable from a success in a trace.
   */
  detectErrorInResponse(response: unknown): string | undefined {
    if (
      typeof response === 'object' &&
      response !== null &&
      'error' in response &&
      response.error
    ) {
      return TOOL_ERROR;
    }
    return undefined;
  }

  /**
   * Validates the model-provided arguments against the parameter schema and
   * invokes the user-defined `execute` function.
   *
   * A call that omits a declared-required argument resolves to an error object
   * telling the model to retry with the missing arguments, matching adk-python.
   * It never reaches the confirmation gate or `execute`.
   *
   * @param req The tool request containing arguments and tool context.
   * @returns A promise resolving to the function's return value.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    try {
      const schema = toSchema(this.parameters);
      const callArgs = this.marshalArgs(schema, req.args);

      const missing = missingRequiredArgs(schema, callArgs);
      if (missing.length > 0) {
        return {
          error:
            `Invoking \`${this.name}()\` failed as the following mandatory input parameters are not present:\n` +
            `${missing.join('\n')}\n` +
            'You could retry calling this tool, but it is IMPORTANT for you to provide all the mandatory parameters.',
        };
      }

      const validatedArgs = this.validateArgs(callArgs);

      const pending = await this.checkConfirmation(
        validatedArgs,
        req.toolContext,
      );
      if (pending !== undefined) {
        return pending;
      }

      return await this.execute(validatedArgs, req.toolContext);
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      throw new Error(`Error in tool '${this.name}': ${errorMessage}`);
    }
  }

  /**
   * Whether this call is gated on human approval — the static flag, or the
   * predicate evaluated against the validated arguments.
   *
   * @param args The arguments the tool would run with.
   * @param toolContext The context of the call, when there is one.
   * @return Whether the call requires confirmation.
   */
  override async checkRequireConfirmation(
    args: Record<string, unknown>,
    toolContext?: Context,
  ): Promise<boolean> {
    // Only a predicate needs typed arguments. Validating for the static flag
    // would answer a question about the gate with a schema error.
    if (typeof this.requireConfirmation !== 'function') {
      return this.requireConfirmation;
    }
    return this.requireConfirmation(this.validateArgs(args), toolContext);
  }

  /**
   * Drops the model-supplied arguments the declaration does not mention.
   *
   * A Zod object applies its own unknown-key policy when {@link validateArgs}
   * parses, and a tool that declares no parameters accepts whatever it is
   * given, so only a raw `Schema` with declared properties filters here.
   */
  private marshalArgs(
    schema: Schema,
    args: Record<string, unknown>,
  ): Record<string, unknown> {
    const {properties} = schema;
    if (
      this.parameters === undefined ||
      isZodObject(this.parameters) ||
      !properties
    ) {
      return args;
    }
    return Object.fromEntries(
      Object.entries(args).filter(([key]) => Object.hasOwn(properties, key)),
    );
  }

  /**
   * Parses `args` against the parameter schema, when one is declared.
   *
   * A Zod object rejects arguments it disagrees with, which `runAsync` turns
   * into an error the model can retry. A raw `Schema` is best-effort instead:
   * it parses to pick up the schema's defaults, and keeps the model's own
   * arguments when they do not validate. Tools declared with a `Schema` — the
   * shape MCP and OpenAPI toolsets produce — received no validation at all
   * before, so rejecting those calls would break working tools. This is the
   * same leniency as adk-python's `_preprocess_args`.
   */
  private validateArgs(
    args: Record<string, unknown>,
  ): ToolExecuteArgument<TParameters> {
    if (isZodObject(this.parameters)) {
      return this.parameters.parse(args) as ToolExecuteArgument<TParameters>;
    }
    return tryParseWithSchema(
      this.parameters,
      args,
    ) as ToolExecuteArgument<TParameters>;
  }

  /** Resolves `requireConfirmation`, which may be a flag or a predicate. */
  private async evaluateRequireConfirmation(
    input: ToolExecuteArgument<TParameters>,
    toolContext?: Context,
  ): Promise<boolean> {
    return typeof this.requireConfirmation === 'function'
      ? this.requireConfirmation(input, toolContext)
      : this.requireConfirmation;
  }

  /**
   * Evaluates the confirmation gate. Returns `undefined` if the tool may
   * proceed; otherwise returns the function response payload to surface instead
   * of running (a request-for-confirmation on the first pass, or a rejection
   * once the user declined).
   */
  private async checkConfirmation(
    input: ToolExecuteArgument<TParameters>,
    toolContext?: Context,
  ): Promise<{error: string} | undefined> {
    const requireConfirmation = await this.evaluateRequireConfirmation(
      input,
      toolContext,
    );
    if (!requireConfirmation) {
      return undefined;
    }
    if (!toolContext) {
      throw new Error(
        `Tool '${this.name}' requires confirmation but no tool context was provided.`,
      );
    }
    if (!toolContext.toolConfirmation) {
      toolContext.requestConfirmation({
        hint:
          `Please approve or reject the tool call ${this.name}() by ` +
          'responding with a FunctionResponse with an expected ' +
          'ToolConfirmation payload.',
      });
      toolContext.actions.skipSummarization = true;
      return {
        error:
          'This tool call requires confirmation, please approve or reject.',
      };
    }
    if (!toolContext.toolConfirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }
    return undefined;
  }
}
