/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Tool} from '@google/genai';

import {LlmRequest} from '../models/llm_request.js';
import {getGoogleLlmVariant} from '../utils/variant_utils.js';

import {Context} from '../agents/context.js';
import {ToolArgsConfig, toBaseToolParams} from './tool_configs.js';

/**
 * The parameters for `runAsync`.
 */
export interface RunAsyncToolRequest {
  args: Record<string, unknown>;
  toolContext: Context;
}

/**
 * The parameters for `processLlmRequest`.
 */
export interface ToolProcessLlmRequest {
  toolContext: Context;
  llmRequest: LlmRequest;
}

/**
 * Parameters for the BaseTool constructor.
 */
export interface BaseToolParams {
  name: string;
  description: string;
  isLongRunning?: boolean;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const BASE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseTool');

/**
 * Marks a tool the model runs itself rather than the framework — see
 * `BuiltInTool`. Such a tool claims its name in the `toolsDict` only so a
 * function call naming it can be routed, so a genuinely callable tool of the
 * same name takes precedence over it.
 */
export const IN_MODEL_TOOL_SYMBOL = Symbol.for('google.adk.inModelTool');

/**
 * Whether `tool` is one the model runs itself.
 */
export function isInModelTool(tool: unknown): boolean {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    (tool as Record<symbol, unknown>)[IN_MODEL_TOOL_SYMBOL] === true
  );
}

/**
 * Type guard to check if an object is an instance of BaseTool.
 * @param obj The object to check.
 * @returns True if the object is an instance of BaseTool, false otherwise.
 */
export function isBaseTool(obj: unknown): obj is BaseTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    BASE_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[BASE_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * The base class for all tools.
 */
export abstract class BaseTool {
  /** A unique symbol to identify ADK base tool class. */
  readonly [BASE_TOOL_SIGNATURE_SYMBOL] = true;

  readonly name: string;
  readonly description: string;
  readonly isLongRunning: boolean;

  /**
   * Whether this tool produces its `FunctionResponse` elsewhere.
   *
   * When true, the automatic function-response event is skipped if `runAsync`
   * resolves to `null` or `undefined`; some other orchestrator supplies the
   * matching response later in the conversation. A tool that returns a real
   * value still gets its event, exactly like any other tool.
   *
   * Distinct from {@link BaseTool.isLongRunning}, which skips the same way but
   * additionally records the call in `event.longRunningToolIds`, affecting A2A
   * conversion, plugin logging and interrupt tracking.
   *
   * Internal: ADK sets this on its own tools and it is not part of the public
   * API, which is what the reference Python SDK means by naming it
   * `_defers_response`. It is public here because the function-call flow reads
   * it from outside the class, and this repository's style guide does not use
   * an underscore prefix. It is deliberately not a constructor option: a tool
   * that defers assigns it after `super(...)`.
   */
  defersResponse = false;

  /**
   * Base constructor for a tool.
   *
   * @param params The parameters for `BaseTool`.
   */
  constructor(params: BaseToolParams) {
    this.name = params.name;
    this.description = params.description;
    this.isLongRunning = params.isLongRunning ?? false;
  }

  /**
   * Creates a tool instance from a config.
   *
   * The default validates the config into {@link BaseToolParams} and calls the
   * constructor. Subclasses override it for custom initialization, such as
   * resolving a reference the config states relative to `configAbsPath`.
   *
   * `this` is typed as a concrete constructor, so a subclass whose constructor
   * demands options beyond `BaseToolParams` cannot use this default and must
   * override it. The override receives `configAbsPath` unchanged.
   *
   * Diverges from Python's synchronous `from_config`: resolving a reference in
   * TypeScript means a dynamic `import()`, so the seam has to be async for the
   * useful overrides to exist at all.
   *
   * @param config The args block of a tool config.
   * @param _configAbsPath The absolute path of the config file the config came
   *     from. Unused by the default; overrides resolve paths against it.
   * @return The tool instance.
   */
  static async fromConfig(
    this: new (params: BaseToolParams) => BaseTool,
    config: ToolArgsConfig,
    _configAbsPath: string,
  ): Promise<BaseTool> {
    return new this(toBaseToolParams(config));
  }

  /**
   * Gets the OpenAPI specification of this tool in the form of a
   * FunctionDeclaration.
   *
   * NOTE
   * - Required if subclass uses the default implementation of
   *   `processLlmRequest` to add function declaration to LLM request.
   * - Otherwise, can be skipped, e.g. for a built-in GoogleSearch tool for
   *   Gemini.
   *
   * @return The FunctionDeclaration of this tool, or undefined if it doesn't
   *     need to be added to LlmRequest.config.
   */
  _getDeclaration(): FunctionDeclaration | undefined {
    return undefined;
  }

  /**
   * Runs the tool with the given arguments and context.
   *
   * NOTE
   * - Required if this tool needs to run at the client side.
   * - Otherwise, can be skipped, e.g. for a built-in GoogleSearch tool for
   *   Gemini.
   *
   * @param _request The request to run the tool.
   * @return A promise that resolves to the tool response.
   * @throws Error When the tool does not implement it. A server-side tool
   *     never reaches this, so it does not have to write a stub.
   */
  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    throw new Error(`Tool ${this.name} does not implement runAsync().`);
  }

  /**
   * Whether this tool needs a human to approve `args` before it runs.
   *
   * The gate itself lives in the tool that owns it (see `FunctionTool`), but
   * the resume path has to ask the same question a turn later, to check that an
   * approval it is about to honour belongs to a tool that gates at all. A tool
   * that never gates returns false here, which is the safe default: an approval
   * naming it is meaningless and gets rejected rather than executed. Mirrors
   * Python's `BaseTool.check_require_confirmation`.
   *
   * @param _args The arguments the tool would run with.
   * @param _toolContext The context of the call, when there is one.
   * @return Whether the call requires confirmation.
   */
  async checkRequireConfirmation(
    _args: Record<string, unknown>,
    _toolContext?: Context,
  ): Promise<boolean> {
    return false;
  }

  /**
   * Processes the outgoing LLM request for this tool.
   *
   * Use cases:
   * - Most common use case is adding this tool to the LLM request.
   * - Some tools may just preprocess the LLM request before it's sent out.
   *
   * @param request The request to process the LLM request.
   */
  async processLlmRequest({llmRequest}: ToolProcessLlmRequest): Promise<void> {
    const functionDeclaration = this._getDeclaration();
    if (!functionDeclaration) {
      return;
    }

    // An in-model tool holds the name only so a call naming it can be routed;
    // a callable tool of the same name displaces it rather than colliding.
    // `Object.hasOwn` rather than a plain lookup, so a tool named after an
    // `Object.prototype` member does not collide with the inherited value.
    const registered = Object.hasOwn(llmRequest.toolsDict, this.name)
      ? llmRequest.toolsDict[this.name]
      : undefined;
    if (registered && !isInModelTool(registered)) {
      throw new Error(`Duplicate tool name: ${this.name}`);
    }

    llmRequest.toolsDict[this.name] = this;

    const tool = findToolWithFunctionDeclarations(llmRequest);
    if (tool) {
      if (!tool.functionDeclarations) {
        tool.functionDeclarations = [];
      }

      tool.functionDeclarations.push(functionDeclaration);
    } else {
      llmRequest.config = llmRequest.config || {};
      llmRequest.config.tools = llmRequest.config.tools || [];
      llmRequest.config.tools.push({
        functionDeclarations: [functionDeclaration],
      });
    }
  }

  /**
   * The Google API LLM variant to use.
   */
  get apiVariant() {
    return getGoogleLlmVariant();
  }
}

function findToolWithFunctionDeclarations(
  llmRequest: LlmRequest,
): Tool | undefined {
  return (llmRequest.config?.tools || []).find(
    (tool) => 'functionDeclarations' in tool,
  ) as Tool | undefined;
}
