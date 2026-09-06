/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {ComputerUse, ToolUnion} from '@google/genai';

import {Context} from '../../agents/context.js';
import {LlmRequest} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {isRecord} from '../../utils/object_notation_utils.js';
import {
  isInModelTool,
  RunAsyncToolRequest,
  ToolProcessLlmRequest,
} from '../base_tool.js';
import {
  FunctionTool,
  ToolExecuteFunction,
  ToolInputParameters,
} from '../function_tool.js';

import {ComputerState, isComputerState, ScreenSize} from './base_computer.js';

/**
 * The signature of the function a {@link ComputerUseTool} wraps.
 *
 * The model supplies the arguments, so they arrive as `unknown` and the
 * function narrows them itself.
 */
export type ComputerUseFunction = ToolExecuteFunction<ToolInputParameters>;

/** The coordinate space the model works in unless the caller overrides it. */
const DEFAULT_VIRTUAL_SCREEN_SIZE: ScreenSize = {width: 1000, height: 1000};

/** Argument names carrying a horizontal coordinate. */
const X_ARGUMENT_NAMES = ['x', 'destination_x'];

/** Argument names carrying a vertical coordinate. */
const Y_ARGUMENT_NAMES = ['y', 'destination_y'];

/** The `safety_decision.decision` value that pauses the call for approval. */
const REQUIRE_CONFIRMATION_DECISION = 'require_confirmation';

/** The hint shown when the model gives no explanation for its safety call. */
const DEFAULT_CONFIRMATION_HINT =
  'This computer use action requires safety confirmation.';

/** The response returned while the call waits for the user's approval. */
const CONFIRMATION_REQUIRED_ERROR =
  'This tool call requires confirmation, please approve or reject.';

/** The response returned once the user has declined the call. */
const TOOL_CALL_REJECTED_ERROR = 'This tool call is rejected.';

/** A unique symbol to identify ADK computer-use tool classes. */
const COMPUTER_USE_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.computerUseTool',
);

/**
 * Type guard to check if an object is an instance of {@link ComputerUseTool}.
 *
 * @param obj The object to check.
 * @returns True if the object is a computer-use tool, false otherwise.
 */
export function isComputerUseTool(obj: unknown): obj is ComputerUseTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    COMPUTER_USE_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/** The options for creating a {@link ComputerUseTool}. */
export interface ComputerUseToolOptions {
  /** The wire name the model calls the action by. */
  name: string;
  /** The model-facing description of the action. */
  description: string;
  /** The schema of the action's arguments. */
  parameters?: ToolInputParameters;
  /** The function that performs the action. */
  execute: ComputerUseFunction;
  /** The real size of the screen, in pixels. */
  screenSize: ScreenSize;
  /**
   * The coordinate space the model works in. Coordinates the model supplies
   * are scaled from this space to {@link ComputerUseToolOptions.screenSize}.
   * Defaults to 1000x1000.
   */
  virtualScreenSize?: ScreenSize;
  /**
   * The computer-use configuration to attach to the outgoing request. Supplied
   * by {@link ComputerUseToolset}; a tool built without one registers itself
   * but puts the model into no particular mode.
   */
  computerUse?: ComputerUse;
}

/** Whether both dimensions are usable as a screen size. */
function isPositiveSize(size: ScreenSize): boolean {
  return (
    Number.isFinite(size.width) &&
    Number.isFinite(size.height) &&
    size.width > 0 &&
    size.height > 0
  );
}

/**
 * Scales one coordinate from the virtual space to the real screen and clamps
 * it to the screen, truncating toward zero as the reference implementation
 * does.
 *
 * @param value The coordinate the model supplied.
 * @param axis The axis the coordinate belongs to, used in the error message.
 * @param virtual The size of the virtual space along that axis.
 * @param actual The size of the real screen along that axis.
 */
function normalizeCoordinate(
  value: unknown,
  axis: string,
  virtual: number,
  actual: number,
): number {
  if (typeof value !== 'number') {
    throw new Error(`${axis} coordinate must be numeric, got ${typeof value}`);
  }
  const scaled = Math.trunc((value / virtual) * actual);
  return Math.max(0, Math.min(scaled, actual - 1));
}

/** Returns `args` with every coordinate scaled to the real screen. */
function normalizeCoordinates(
  args: Record<string, unknown>,
  screenSize: ScreenSize,
  virtualScreenSize: ScreenSize,
): Record<string, unknown> {
  const normalized = {...args};
  for (const name of X_ARGUMENT_NAMES) {
    if (name in normalized) {
      normalized[name] = normalizeCoordinate(
        normalized[name],
        'x',
        virtualScreenSize.width,
        screenSize.width,
      );
    }
  }
  for (const name of Y_ARGUMENT_NAMES) {
    if (name in normalized) {
      normalized[name] = normalizeCoordinate(
        normalized[name],
        'y',
        virtualScreenSize.height,
        screenSize.height,
      );
    }
  }
  return normalized;
}

/** Reads the model's safety verdict out of the call arguments. */
function readSafetyDecision(
  args: Record<string, unknown>,
): {decision?: string; explanation?: string} | undefined {
  const value = args['safety_decision'];
  if (!isRecord(value)) {
    return undefined;
  }
  return {
    decision:
      typeof value['decision'] === 'string' ? value['decision'] : undefined,
    explanation:
      typeof value['explanation'] === 'string'
        ? value['explanation']
        : undefined,
  };
}

/**
 * Applies the human-in-the-loop gate the computer-use model asks for.
 *
 * Returns the response to send back instead of running the action, or
 * `undefined` when the action may proceed.
 */
function evaluateSafetyDecision(
  req: RunAsyncToolRequest,
): {error: string} | undefined {
  const confirmation = req.toolContext.toolConfirmation;
  if (confirmation) {
    return confirmation.confirmed
      ? undefined
      : {error: TOOL_CALL_REJECTED_ERROR};
  }
  const safetyDecision = readSafetyDecision(req.args);
  if (safetyDecision?.decision !== REQUIRE_CONFIRMATION_DECISION) {
    return undefined;
  }
  req.toolContext.requestConfirmation({
    hint: safetyDecision.explanation ?? DEFAULT_CONFIRMATION_HINT,
  });
  req.toolContext.actions.skipSummarization = true;
  return {error: CONFIRMATION_REQUIRED_ERROR};
}

/** Renders a computer state as the function response the model expects. */
function toStateResponse(state: ComputerState): Record<string, unknown> {
  return {
    image: {
      mimetype: 'image/png',
      data: Buffer.from(state.screenshot).toString('base64'),
    },
    url: state.url,
  };
}

/**
 * Claims `tool`'s name on the request.
 *
 * A computer-use tool is callable, so it follows the rule
 * `BaseTool.processLlmRequest` applies: a name another callable tool already
 * holds is a conflict to report, not an entry to overwrite. The predefined
 * names are generic enough (`wait`, `search`, `navigate`) that a user tool can
 * plausibly collide with one.
 */
function registerTool(llmRequest: LlmRequest, tool: ComputerUseTool): void {
  // `Object.hasOwn` rather than `in`, so a tool named after an
  // `Object.prototype` member is not read as already registered.
  const registered = Object.hasOwn(llmRequest.toolsDict, tool.name)
    ? llmRequest.toolsDict[tool.name]
    : undefined;
  if (registered && registered !== tool && !isInModelTool(registered)) {
    throw new Error(`Duplicate tool name: ${tool.name}`);
  }
  llmRequest.toolsDict[tool.name] = tool;
}

/** Whether a tool already on the request configures computer use. */
function hasComputerUse(tool: ToolUnion): boolean {
  return 'computerUse' in tool && !!tool.computerUse;
}

/**
 * Converts the action's return value into a function response, and records the
 * user's approval on it when there was one.
 */
function buildResponse(result: unknown, toolContext: Context): unknown {
  const response = isComputerState(result) ? toStateResponse(result) : result;
  if (!toolContext.toolConfirmation?.confirmed) {
    return response;
  }
  const payload = isRecord(response) ? response : {result: response};
  return {...payload, safety_acknowledgement: 'true'};
}

/**
 * A tool that exposes one computer action to a model.
 *
 * The model works in a fixed virtual coordinate space (1000x1000 by default)
 * whatever the real screen measures, so this tool scales the coordinates it
 * receives onto the real screen before running the action. It also applies the
 * safety confirmation the computer-use model asks for, and renders a
 * {@link ComputerState} return value as an image function response.
 */
@experimental
export class ComputerUseTool extends FunctionTool<ToolInputParameters> {
  /** A unique symbol to identify ADK computer-use tool class. */
  readonly [COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] = true;

  /** The real size of the screen, in pixels. */
  readonly screenSize: ScreenSize;

  /** The coordinate space the model works in. */
  readonly virtualScreenSize: ScreenSize;

  /** The wrapped function, so that an adapter can compose over it. */
  readonly func: ComputerUseFunction;

  /** The computer-use configuration this tool attaches to the request. */
  readonly computerUse?: ComputerUse;

  constructor(options: ComputerUseToolOptions) {
    super({
      name: options.name,
      description: options.description,
      parameters: options.parameters,
      execute: options.execute,
    });
    this.screenSize = options.screenSize;
    this.virtualScreenSize =
      options.virtualScreenSize ?? DEFAULT_VIRTUAL_SCREEN_SIZE;
    this.func = options.execute;
    this.computerUse = options.computerUse;

    if (!isPositiveSize(this.screenSize)) {
      throw new Error('screenSize dimensions must be positive');
    }
    if (!isPositiveSize(this.virtualScreenSize)) {
      throw new Error('virtualScreenSize dimensions must be positive');
    }
  }

  /** Runs the computer action with the coordinates scaled to the screen. */
  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    const gated = evaluateSafetyDecision(req);
    if (gated) {
      return gated;
    }
    const args = normalizeCoordinates(
      req.args,
      this.screenSize,
      this.virtualScreenSize,
    );
    const result = await super.runAsync({args, toolContext: req.toolContext});
    return buildResponse(result, req.toolContext);
  }

  /**
   * Registers this tool and puts the model into computer-use mode.
   *
   * No function declaration is emitted, because the model already knows the
   * predefined computer-use functions. Where adk-python registers the whole
   * set from `ComputerUseToolset.process_llm_request`, adk-js reaches only
   * `BaseTool.processLlmRequest` when an agent runs, so each tool registers
   * itself and the first one to run attaches the shared configuration.
   */
  override async processLlmRequest({
    llmRequest,
  }: ToolProcessLlmRequest): Promise<void> {
    registerTool(llmRequest, this);
    if (!this.computerUse) {
      return;
    }
    llmRequest.config = llmRequest.config ?? {};
    llmRequest.config.tools = llmRequest.config.tools ?? [];
    if (llmRequest.config.tools.some(hasComputerUse)) {
      logger.debug('Computer use already configured in LLM request');
      return;
    }
    llmRequest.config.tools.push({computerUse: this.computerUse});
  }
}
