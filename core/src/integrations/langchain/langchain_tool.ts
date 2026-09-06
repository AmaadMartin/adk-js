/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

import {
  ToolErrorType,
  ToolExecutionError,
} from '../../errors/tool_execution_error.js';
import {RunAsyncToolRequest} from '../../tools/base_tool.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {formatError} from '../../utils/error_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {resolveFullyQualifiedName} from '../../utils/module_utils.js';
import {toJsonSchema} from '../../utils/schema.js';
import {
  isZodObject,
  isZodSchema,
  zodObjectToSchema,
} from '../../utils/simple_zod_to_json.js';

/**
 * The shape of a LangChain JS tool that {@link LangchainTool} can wrap.
 *
 * Declared structurally rather than against `@langchain/core` so that
 * `@google/adk` carries no type dependency on an optional peer, and so a tool
 * built by a second copy of `@langchain/core` in the same runtime is still
 * accepted.
 */
export interface LangchainToolLike {
  /** The tool's own name, used unless the caller overrides it. */
  name?: string;
  /** The tool's own description, used unless the caller overrides it. */
  description?: string;
  /** Whether the tool's result should reach the user unsummarized. */
  returnDirect?: boolean;
  /** A Zod schema (v3 or v4), or a plain JSON Schema object. */
  schema?: unknown;
  /** The tool's entry point, inherited from LangChain's `Runnable`. */
  invoke?(input: unknown): unknown;
}

/** Options for {@link LangchainTool}. */
export interface LangchainToolOptions {
  /** The LangChain tool to wrap. */
  tool: LangchainToolLike;
  /** Overrides the wrapped tool's name in the model-facing declaration. */
  name?: string;
  /** Overrides the wrapped tool's description. */
  description?: string;
}

/**
 * The declarative configuration of a {@link LangchainTool}, as an agent config
 * file supplies it.
 *
 * It differs from {@link LangchainToolOptions} because a config file cannot
 * hold a tool object. It names one instead.
 */
export interface LangchainToolConfig {
  /**
   * A fully-qualified name of the form `<module specifier>#<export>` that
   * resolves to the LangChain tool instance to wrap.
   */
  tool: string;
  /** Overrides the wrapped tool's name in the model-facing declaration. */
  name?: string;
  /** Overrides the wrapped tool's description. */
  description?: string;
}

/**
 * Whether a value has the shape {@link LangchainTool} can wrap.
 *
 * A structural check rather than an `instanceof`, so a tool built by a second
 * copy of `@langchain/core` in the same runtime is still accepted.
 */
export function isLangchainToolLike(
  value: unknown,
): value is LangchainToolLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'invoke' in value &&
    typeof (value as LangchainToolLike).invoke === 'function'
  );
}

/** Returns `invoke` bound to the tool, because LangChain's methods use `this`. */
function resolveEntryPoint(
  tool: LangchainToolLike,
): (input: unknown) => unknown {
  if (typeof tool.invoke !== 'function') {
    throw new Error("Tool must be a LangChain tool with an 'invoke' method.");
  }
  return tool.invoke.bind(tool);
}

/** Resolves the model-facing name, which the declaration cannot go without. */
function resolveName(options: LangchainToolOptions): string {
  const name = options.name ?? options.tool.name;
  if (!name) {
    throw new Error(
      'LangchainTool requires a name: the wrapped tool has none, so pass `name`.',
    );
  }
  return name;
}

/** Whether a value is a plain JSON Schema object the converter can walk. */
function isJsonSchemaObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts the tool's schema to the parameters of the model-facing
 * declaration, or `undefined` when the tool declares no schema.
 *
 * Zod is read from its input side, because the declaration tells the model
 * what to send rather than what it gets back. A field built with `.default()`
 * is therefore optional, and a field built with `.transform()` is declared as
 * the value the transform accepts. Reading the output side instead would
 * declare a defaulted field as required, and would fail outright on a
 * transform, whose result JSON Schema often cannot express.
 *
 * A Zod object goes through the same converter as `FunctionTool`'s own
 * parameters. Any other Zod schema is rendered as JSON Schema first, which
 * covers LangChain's string-input `Tool`: its schema is a transformed
 * `z.object({input})`, and the input side of that is `{input: string}`.
 */
function resolveParameters(tool: LangchainToolLike): Schema | undefined {
  const {schema} = tool;
  if (schema === undefined) {
    return undefined;
  }
  try {
    if (isZodObject(schema)) {
      return zodObjectToSchema(schema);
    }
    if (isZodSchema(schema)) {
      return toGeminiSchema(toJsonSchema(schema, 'input'));
    }
    if (!isJsonSchemaObject(schema)) {
      throw new Error(`unsupported schema of type ${typeof schema}`);
    }
    return toGeminiSchema(schema);
  } catch (error: unknown) {
    throw new Error(
      `Failed to build function declaration for Langchain tool: ${formatError(error)}`,
    );
  }
}

/** Whether a result is an error payload: an object with a truthy `error`. */
function isErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    Boolean(result.error)
  );
}

/**
 * Adapter that lets an ADK agent call a LangChain JS tool.
 *
 * The wrapped tool keeps its own name, description and argument schema, and
 * runs through its own entry point, so LangChain still owns argument
 * validation and its callback plumbing never reaches the model.
 *
 * The adapter calls the tool with the model's arguments alone. The ADK
 * `Context` stays on the ADK side, so a wrapped tool cannot read the session
 * state or write the event actions.
 *
 * `@langchain/core` is an optional peer dependency. This module never imports
 * it, so an install that does not use LangChain pays nothing for this class.
 *
 * @example
 * ```ts
 * import {LangchainTool, LlmAgent} from '@google/adk';
 * import {tool} from '@langchain/core/tools';
 * import {z} from 'zod';
 *
 * const add = tool(({x, y}: {x: number; y: number}) => x + y, {
 *   name: 'add',
 *   description: 'Adds two numbers',
 *   schema: z.object({x: z.number(), y: z.number()}),
 * });
 *
 * const agent = new LlmAgent({
 *   name: 'calculator',
 *   model: 'gemini-2.5-flash',
 *   tools: [new LangchainTool({tool: add})],
 * });
 * ```
 */
export class LangchainTool extends FunctionTool<Schema> {
  /** Whether the tool's result reaches the user unsummarized. */
  private readonly returnDirect: boolean;

  constructor(options: LangchainToolOptions) {
    // Resolved before the other options so that a value which is not a
    // LangChain tool reports the missing `invoke` rather than a missing name.
    const entryPoint = resolveEntryPoint(options.tool);
    super({
      // Called with one argument. `FunctionTool` passes the ADK `Context`
      // second, and LangChain reads a second argument as a `RunnableConfig`,
      // which would hand the wrapped tool the session state and the actions.
      execute: (input) => entryPoint(input),
      name: resolveName(options),
      description: options.description ?? options.tool.description ?? '',
      parameters: resolveParameters(options.tool),
    });
    this.returnDirect = options.tool.returnDirect ?? false;
  }

  /**
   * Builds a tool from the declarative configuration of an agent config file.
   *
   * An empty `name` or `description` counts as absent, so the wrapped tool
   * keeps its own. adk-python defaults both to `''` and lets that blank the
   * wrapped tool's name; a declaration cannot go without a name, so the port
   * does not reproduce it.
   *
   * @param config The tool configuration read from an agent config file.
   * @param configAbsPath Absolute path of that config file. A relative module
   *   specifier in `config.tool` resolves against its directory.
   * @return The configured tool.
   * @throws {ToolExecutionError} When the config does not yield a LangChain
   *   tool, for any reason. A name that fails to resolve carries the
   *   resolver's error as `cause`.
   */
  static async fromConfig(
    config: LangchainToolConfig,
    configAbsPath: string,
  ): Promise<LangchainTool> {
    // An agent config file is a trust boundary, so the declared `string` type
    // is checked rather than assumed.
    if (typeof config.tool !== 'string' || !config.tool) {
      throw new ToolExecutionError(
        'Langchain tool config must name a Langchain tool instance with a ' +
          'fully-qualified name.',
        ToolErrorType.BAD_REQUEST,
      );
    }
    const tool = await resolveFullyQualifiedName(
      config.tool,
      configAbsPath,
    ).catch((error: unknown) => {
      throw new ToolExecutionError(
        `Langchain tool config names a tool that does not resolve: ${config.tool}`,
        ToolErrorType.BAD_REQUEST,
        {cause: error},
      );
    });
    if (!isLangchainToolLike(tool)) {
      throw new ToolExecutionError(
        'Langchain tool config must name a Langchain tool instance.',
        ToolErrorType.BAD_REQUEST,
      );
    }
    return new LangchainTool({
      tool,
      name: config.name || undefined,
      description: config.description || undefined,
    });
  }

  /**
   * Runs the wrapped tool and, for a `returnDirect` tool, asks the framework to
   * skip summarization.
   *
   * An error payload stays summarizable, because the model has to see the
   * error to retry. A payload whose `error` is falsy is a real result and does
   * skip summarization, which matches adk-python.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    const result = await super.runAsync(req);
    if (this.returnDirect && !isErrorResult(result)) {
      req.toolContext.actions.skipSummarization = true;
    }
    return result;
  }
}
