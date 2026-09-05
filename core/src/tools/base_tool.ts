/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {FunctionDeclaration, Tool} from '@google/genai';

import {
  ToolErrorType,
  ToolExecutionError,
} from '../errors/tool_execution_error.js';
import {LlmRequest} from '../models/llm_request.js';
import {getGoogleLlmVariant} from '../utils/variant_utils.js';

import {Context} from '../agents/context.js';

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
 * The declared args of one tool in a configuration file.
 *
 * Structural (`object`) rather than an index signature on purpose: a subclass
 * that narrows {@link BaseTool.fromConfig} to its own config interface must
 * stay assignable to this type, and a TypeScript interface is not assignable
 * to an index-signature type.
 */
export type ToolArgsConfig = object;

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
   * Internal and unstable — framework code sets this, external code must not.
   *
   * When true, the framework skips the automatic `FunctionResponse` build for
   * a call whose `runAsync` resolves to nothing, because another orchestrator
   * emits the matching response later in the conversation. A `runAsync` that
   * resolves to a value is handled normally.
   *
   * Unlike {@link isLongRunning}, which shares the skip-on-empty behaviour,
   * this does not add the call id to `event.longRunningToolIds`.
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
   * Builds a tool from its declared args in a configuration file.
   *
   * The returned tool is an instance of the class this was called on, so
   * `MyTool.fromConfig(...)` resolves to a `MyTool`. The default
   * implementation forwards every config entry to the constructor after
   * checking the entries `BaseTool` itself reads. A subclass whose
   * constructor needs more than a plain forward overrides this method.
   *
   * @param config The tool's declared args. A config file is a trust
   *   boundary, so the declared shape is checked rather than assumed.
   * @param _configAbsPath The absolute path of the config file the
   *   declaration came from. Unused here — no entry `BaseTool` reads names a
   *   file — and accepted so one loader can call every tool's `fromConfig`
   *   the same way.
   * @return The tool instance.
   * @throws {ToolExecutionError} If the config does not declare a non-empty
   *   `name` and a `description`.
   */
  static async fromConfig(
    config: ToolArgsConfig,
    _configAbsPath?: string,
  ): Promise<BaseTool> {
    // Constructing the receiving class from a config bag is unsound by
    // nature, so the assertion cannot be typed away. Annotating `this`
    // instead rejects any subclass whose constructor takes extra required
    // params (TS2684), and returning a generic `T` breaks every subclass that
    // narrows this signature (TS2417).
    const ctor = this as unknown as new (params: BaseToolParams) => BaseTool;
    return new ctor(toBaseToolParams(config));
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
   * @param request The request to run the tool.
   * @return A promise that resolves to the tool response.
   */
  abstract runAsync(request: RunAsyncToolRequest): Promise<unknown>;

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

/**
 * The config is rejected without echoing it back: a tool's declared args can
 * carry credentials.
 */
function invalidToolConfig(requirement: string): ToolExecutionError {
  return new ToolExecutionError(
    `Invalid tool config: ${requirement}.`,
    ToolErrorType.BAD_REQUEST,
  );
}

/**
 * Checks the config entries `BaseTool` reads and returns the constructor
 * params. Unrecognized entries pass through untouched, so a subclass whose
 * params object carries extra fields still receives them.
 *
 * The runtime checks are not redundant with the declared type: a loader
 * parses a config file, so what arrives is whatever the file held.
 */
function toBaseToolParams(config: ToolArgsConfig): BaseToolParams {
  if (typeof config !== 'object' || config === null) {
    throw invalidToolConfig('the config must be a non-null object');
  }
  const entries: Record<string, unknown> = {...config};
  const {name, description, isLongRunning} = entries;
  if (typeof name !== 'string' || name === '') {
    throw invalidToolConfig('`name` must be a non-empty string');
  }
  if (typeof description !== 'string') {
    throw invalidToolConfig('`description` must be a string');
  }
  if (isLongRunning !== undefined && typeof isLongRunning !== 'boolean') {
    throw invalidToolConfig('`isLongRunning` must be a boolean');
  }
  return {...entries, name, description, isLongRunning};
}

function findToolWithFunctionDeclarations(
  llmRequest: LlmRequest,
): Tool | undefined {
  return (llmRequest.config?.tools || []).find(
    (tool) => 'functionDeclarations' in tool,
  ) as Tool | undefined;
}
