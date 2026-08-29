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

/**
 * Converts the tool's schema to the parameters of the model-facing
 * declaration, or `undefined` when the tool declares no schema.
 *
 * A Zod schema is rendered as JSON Schema first. That step matters for
 * LangChain's string-input `Tool`, whose schema is a transformed
 * `z.object({input})` rather than a plain object: rendering it yields the
 * transform's input side, `{input: string}`, which is what the model must send.
 */
function resolveParameters(tool: LangchainToolLike): Schema | undefined {
  const {schema} = tool;
  if (schema === undefined) {
    return undefined;
  }
  try {
    if (isZodSchema(schema)) {
      return toGeminiSchema(toJsonSchema(schema));
    }
    if (
      typeof schema !== 'object' ||
      schema === null ||
      Array.isArray(schema)
    ) {
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
