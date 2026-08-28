/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

import {RunAsyncToolRequest} from '../../tools/base_tool.js';
import {FunctionTool} from '../../tools/function_tool.js';
import {formatError} from '../../utils/error_utils.js';
import {toGeminiSchema} from '../../utils/gemini_schema_util.js';
import {toJsonSchema} from '../../utils/schema.js';
import {isZodSchema} from '../../utils/simple_zod_to_json.js';

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
  /** The current public entry point (`Runnable.invoke`). */
  invoke?(input: unknown): unknown;
  /** The deprecated entry point kept by `StructuredTool`. */
  call?(input: unknown): unknown;
  /** The bare function held by a `DynamicTool` / `DynamicStructuredTool`. */
  func?(input: unknown): unknown;
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
 * Returns the tool's entry point, bound to the tool because LangChain's
 * methods use `this`.
 *
 * `invoke` wins over `call` (deprecated in LangChain) and over `func` (the raw
 * function, which skips the tool's own argument validation and callbacks).
 */
function resolveEntryPoint(
  tool: LangchainToolLike,
): (input: unknown) => unknown {
  const entryPoint = tool.invoke ?? tool.call ?? tool.func;
  if (typeof entryPoint !== 'function') {
    throw new Error(
      "Tool must be a LangChain tool with an 'invoke', 'call' or 'func' method.",
    );
  }
  return entryPoint.bind(tool);
}

/** Returns true when `value` is a plain JSON Schema object. */
function isJsonSchemaObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Converts a LangChain tool's schema to the parameters of the model-facing
 * declaration, or `undefined` when the tool declares no schema.
 *
 * A Zod schema is rendered as JSON Schema first. That step matters for
 * LangChain's string-input `Tool`, whose schema is a transformed
 * `z.object({input})` rather than a plain object: rendering it yields the
 * transform's input side, `{input: string}`, which is what the model must send.
 */
function toDeclarationParameters(schema: unknown): Schema | undefined {
  if (schema === undefined) {
    return undefined;
  }
  if (isZodSchema(schema)) {
    return toGeminiSchema(toJsonSchema(schema));
  }
  if (isJsonSchemaObject(schema)) {
    return toGeminiSchema(schema);
  }
  throw new Error(`unsupported schema of type ${typeof schema}`);
}

/**
 * Returns true when the tool reported a failure rather than a result.
 *
 * The check is on truthiness, not presence: a tool that returns
 * `{error: null, ...}` produced a real result.
 */
function isErrorResult(result: unknown): boolean {
  return (
    typeof result === 'object' &&
    result !== null &&
    'error' in result &&
    Boolean(result.error)
  );
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

/** Resolves the declaration parameters, reporting a schema it cannot convert. */
function resolveParameters(tool: LangchainToolLike): Schema | undefined {
  try {
    return toDeclarationParameters(tool.schema);
  } catch (error: unknown) {
    throw new Error(
      `Failed to build function declaration for Langchain tool: ${formatError(error)}`,
    );
  }
}

/**
 * Adapter that lets an ADK agent call a LangChain JS tool.
 *
 * The wrapped tool keeps its own name, description and argument schema, and
 * runs through its own entry point, so LangChain still owns argument
 * validation and its callback plumbing never reaches the model.
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
    const entryPoint = resolveEntryPoint(options.tool);
    super({
      name: resolveName(options),
      description: options.description ?? options.tool.description ?? '',
      parameters: resolveParameters(options.tool),
      execute: (input) => entryPoint(input),
    });
    this.returnDirect = options.tool.returnDirect ?? false;
  }

  /**
   * Runs the wrapped tool and, for a `returnDirect` tool, asks the framework to
   * skip summarization.
   *
   * An error result stays summarizable so the model sees the failure and can
   * retry, which is why it does not set the flag.
   */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    const result = await super.runAsync(req);
    if (this.returnDirect && !isErrorResult(result)) {
      req.toolContext.actions.skipSummarization = true;
    }
    return result;
  }
}
