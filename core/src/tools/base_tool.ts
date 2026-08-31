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
import {getGoogleLlmVariant} from '../utils/variant_utils.js';

import {Context} from '../agents/context.js';
import {toBaseToolParams, ToolArgsConfig} from './tool_configs.js';

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
  customMetadata?: Record<string, unknown>;

  /**
   * Controls when the model reacts to the tool's response (Live API only).
   *
   * Applied to the emitted `FunctionResponse` for asynchronous function
   * calling:
   * - `SILENT`: feeds the response back without triggering a model turn.
   * - `WHEN_IDLE`: defers the reaction until the model is idle.
   * - `INTERRUPT`: reacts immediately.
   *
   * Ignored by models that don't support asynchronous function calling.
   * Leaving it unset preserves the default behavior.
   */
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

  /** See {@link BaseToolParams.responseScheduling}. */
  readonly responseScheduling?: FunctionResponseScheduling;

  /**
   * Optional key-value metadata for this tool, e.g. tool manifests or
   * telemetry identifiers attached by the toolset that produced the tool.
   *
   * Unlike the other `BaseTool` members this is intentionally mutable: a
   * toolset frequently has to stamp metadata onto tool instances it does not
   * construct itself (see `AgentRegistrySingleMCPToolset`). The reference
   * Python SDK exposes the same field with the same mutability.
   *
   * The entire value must be JSON-serializable. It is intended to reach
   * telemetry spans, so it must never carry credentials, tokens or user
   * content.
   */
  customMetadata?: Record<string, unknown>;

  /**
   * Whether this tool produces its `FunctionResponse` elsewhere.
   *
   * When true, the automatic function-response event is skipped if `runAsync`
   * resolves to `null` or `undefined`; some other orchestrator (a wrapper
   * agent, or an external system for webhook-style callbacks) supplies the
   * matching response later in the conversation. A present-but-falsy return
   * (`''`, `0`, `false`) is a real result and emits an event as usual.
   *
   * Distinct from {@link BaseTool.isLongRunning}, which skips the same way but
   * also records the call in `event.longRunningToolIds`, affecting A2A task
   * state, plugin logging and session metadata.
   *
   * Internal. ADK sets this on its own tools and it is not part of the public
   * API, which is what the reference Python SDK means by naming it
   * `_defers_response`. It is public here because the function-call flow reads
   * it from outside the class, and this repository's style guide does not use
   * an underscore prefix. It is not a constructor option, matching Python: a
   * tool that defers assigns it after `super(...)`.
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
   * The default rejects, so a tool the model runs on its own side can omit it
   * and still fail with a message naming the tool. Mirrors Python's
   * `BaseTool.run_async`, which raises `NotImplementedError`. The rejection is
   * a plain `Error`, not a `ToolExecutionError`: a missing implementation is a
   * programming error, and `ToolExecutionError` carries an `errorType` that
   * reports an HTTP outcome on the tool's span.
   *
   * @param _request The request to run the tool.
   * @return A promise that resolves to the tool response.
   * @throws {Error} When the subclass does not implement it.
   */
  async runAsync(_request: RunAsyncToolRequest): Promise<unknown> {
    throw new Error(`Tool ${this.name} does not implement runAsync.`);
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
   * Builds a tool from a config bag.
   *
   * Every ADK tool constructor takes a single options object, so a validated
   * config bag is that options object. The base implementation therefore
   * validates the keys of {@link BaseToolParams} and ignores the rest. A
   * subclass whose constructor takes further options overrides this method,
   * and uses `configAbsPath` to resolve paths the config states relative to
   * the config file.
   *
   * `customMetadata` is checked for shape only. This method rejects an array
   * and a non-object, and does not walk the value to confirm that it is JSON
   * serializable, which stays the caller's obligation.
   *
   * The declared return type is `BaseTool`, not the class this was called on:
   * a static typed to return the caller's concrete class rejects every
   * subclass override that returns its own class (TS2417), and overriding is
   * the point of the seam.
   *
   * @param config The args of the tool config.
   * @param _configAbsPath The absolute path of the config file the config came
   *     from.
   * @return The tool instance.
   * @throws {InputValidationError} If a recognized key is missing or holds a
   *     value of the wrong type.
   */
  static async fromConfig(
    this: new (params: BaseToolParams) => BaseTool,
    config: ToolArgsConfig,
    _configAbsPath: string,
  ): Promise<BaseTool> {
    return new this(toBaseToolParams(config));
  }
}

function findToolWithFunctionDeclarations(
  llmRequest: LlmRequest,
): Tool | undefined {
  return (llmRequest.config?.tools || []).find(
    (tool) => 'functionDeclarations' in tool,
  ) as Tool | undefined;
}
