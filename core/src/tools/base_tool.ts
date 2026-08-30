/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  FunctionDeclaration,
  FunctionResponseScheduling,
  Tool,
} from '@google/genai';

import {LlmRequest} from '../models/llm_request.js';
import {logger} from '../utils/logger.js';
import {getGoogleLlmVariant} from '../utils/variant_utils.js';

import {Context} from '../agents/context.js';
import {ToolArgsConfig} from './tool_configs.js';

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
  /** Tool-specific metadata. The whole object must be JSON serializable. */
  customMetadata?: Record<string, unknown>;
  /** Tool-wide default for when the model reacts to this tool's response. */
  responseScheduling?: FunctionResponseScheduling;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all BaseTool instances.
 */
const BASE_TOOL_SIGNATURE_SYMBOL = Symbol.for('google.adk.baseTool');

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
   * Tool-specific metadata, such as a tool manifest or a deployment
   * identifier. ADK stores it and never interprets it.
   *
   * The whole object must be JSON serializable. Assignable after construction,
   * which is how a tool whose constructor does not forward it (`FunctionTool`,
   * for one) gets one.
   */
  customMetadata?: Record<string, unknown>;

  /**
   * Controls when the model reacts to this tool's response (Live API only).
   *
   * The value is stamped onto the emitted `FunctionResponse`:
   * `SILENT` feeds the response back without starting a model turn,
   * `WHEN_IDLE` defers the reaction until the model is idle, and `INTERRUPT`
   * reacts immediately. A model that does not support asynchronous function
   * calling ignores it, and `undefined` keeps the default behaviour.
   */
  responseScheduling?: FunctionResponseScheduling;

  /**
   * Whether this tool answers its own call later instead of returning a
   * response now.
   *
   * When true and `runAsync` returns nothing, ADK builds no
   * `FunctionResponse`, because another orchestrator produces the matching
   * response later in the conversation. A non-nullish return still emits a
   * response event, exactly like any other tool.
   *
   * `isLongRunning` has the same skip-on-empty behaviour, but it also lists
   * the call in `event.longRunningToolIds`; this flag does not.
   *
   * @internal Not part of the public API. Only ADK-internal tools set it, and
   * it may change without notice.
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
    this.customMetadata = params.customMetadata;
    this.responseScheduling = params.responseScheduling;
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

    if (this.name in llmRequest.toolsDict) {
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

  /**
   * Creates a tool instance from a declarative config.
   *
   * The base implementation reads the parameters `BaseTool` itself accepts and
   * warns about any other key. A subclass that takes more parameters overrides
   * this method and builds itself from them.
   *
   * The `this` parameter constrains the base implementation to a class whose
   * constructor takes `BaseToolParams`; a class that takes more must override.
   * Calling it on `BaseTool` itself does not compile, since `BaseTool` is
   * abstract.
   *
   * @param config The args of the tool, as read from a config file.
   * @param configAbsPath The absolute path of that config file. Reported in
   *     validation errors, and used by an override to resolve a relative path.
   * @return The tool instance.
   */
  static fromConfig(
    this: new (params: BaseToolParams) => BaseTool,
    config: ToolArgsConfig,
    configAbsPath: string,
  ): BaseTool {
    return new this(toBaseToolParams(config, configAbsPath));
  }
}

function findToolWithFunctionDeclarations(
  llmRequest: LlmRequest,
): Tool | undefined {
  return (llmRequest.config?.tools || []).find(
    (tool) => 'functionDeclarations' in tool,
  ) as Tool | undefined;
}

/** The config keys `BaseTool.fromConfig` knows how to read. */
const BASE_TOOL_CONFIG_KEYS: ReadonlySet<string> = new Set([
  'name',
  'description',
  'isLongRunning',
  'customMetadata',
  'responseScheduling',
]);

const RESPONSE_SCHEDULING_VALUES: readonly string[] = Object.values(
  FunctionResponseScheduling,
);

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isResponseScheduling(
  value: unknown,
): value is FunctionResponseScheduling {
  return (
    typeof value === 'string' && RESPONSE_SCHEDULING_VALUES.includes(value)
  );
}

function toolConfigError(
  key: string,
  expected: string,
  configAbsPath: string,
): Error {
  return new Error(
    `Invalid tool config: '${key}' must be ${expected}, in ${configAbsPath}.`,
  );
}

/**
 * Reads an optional config value, throwing when it is present but invalid.
 */
function readOptional<T>(
  config: ToolArgsConfig,
  key: string,
  isValid: (value: unknown) => value is T,
  expected: string,
  configAbsPath: string,
): T | undefined {
  const value = config[key];
  if (value === undefined || isValid(value)) {
    return value;
  }
  throw toolConfigError(key, expected, configAbsPath);
}

/**
 * Validates a declarative tool config and maps it onto constructor parameters.
 *
 * adk-python maps config keys onto constructor arguments by inspecting the
 * runtime type hints of `__init__`. TypeScript erases those types, so the
 * recognized keys are listed here instead and every other key is reported.
 */
function toBaseToolParams(
  config: ToolArgsConfig,
  configAbsPath: string,
): BaseToolParams {
  for (const key of Object.keys(config)) {
    if (!BASE_TOOL_CONFIG_KEYS.has(key)) {
      logger.warn(`Unsupported parsing for argument: ${key}.`);
    }
  }

  const {name, description} = config;
  if (typeof name !== 'string' || name === '') {
    throw toolConfigError('name', 'a non-empty string', configAbsPath);
  }
  if (typeof description !== 'string') {
    throw toolConfigError('description', 'a string', configAbsPath);
  }

  return {
    name,
    description,
    isLongRunning: readOptional(
      config,
      'isLongRunning',
      isBoolean,
      'a boolean',
      configAbsPath,
    ),
    customMetadata: readOptional(
      config,
      'customMetadata',
      isPlainObject,
      'an object',
      configAbsPath,
    ),
    responseScheduling: readOptional(
      config,
      'responseScheduling',
      isResponseScheduling,
      `one of ${RESPONSE_SCHEDULING_VALUES.join(', ')}`,
      configAbsPath,
    ),
  };
}
