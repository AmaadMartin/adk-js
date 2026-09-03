/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema} from '@google/genai';

import {Context} from '../../agents/context.js';
import {base64Encode} from '../../utils/env_aware_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {RunAsyncToolRequest, ToolProcessLlmRequest} from '../base_tool.js';
import {FunctionTool} from '../function_tool.js';
import {ComputerState, isComputerState} from './base_computer.js';

/** The coordinate space the model addresses when none is configured. */
const DEFAULT_VIRTUAL_SCREEN_SIZE: readonly [number, number] = [1000, 1000];

/** The hint shown to the user when the model supplies no explanation. */
const DEFAULT_CONFIRMATION_HINT =
  'This computer use action requires safety confirmation.';

/** The payload returned while the call waits for a human decision. */
const CONFIRMATION_REQUIRED_ERROR =
  'This tool call requires confirmation, please approve or reject.';

/** The payload returned once the human declined the call. */
const CONFIRMATION_REJECTED_ERROR = 'This tool call is rejected.';

/** The `safety_decision.decision` value that opens the confirmation gate. */
const REQUIRE_CONFIRMATION_DECISION = 'require_confirmation';

/** The encoding of the screenshot a {@link ComputerState} carries. */
const SCREENSHOT_MIME_TYPE = 'image/png';

/** The screen axis each label names: 0 is the width, 1 is the height. */
const AXIS_LABELS = ['x', 'y'] as const;

/** The coordinate arguments the model sends, and the axis each scales on. */
const COORDINATE_AXES: ReadonlyArray<readonly [string, 0 | 1]> = [
  ['x', 0],
  ['y', 1],
  ['destination_x', 0],
  ['destination_y', 1],
];

/**
 * The configuration of a {@link ComputerUseTool}.
 */
export interface ComputerUseToolOptions {
  /**
   * The wire name of the predefined computer-use function. Defaults to the
   * name of `execute`, as {@link FunctionTool} does.
   */
  name?: string;

  /** The description the model reads. */
  description: string;

  /** Performs the action. Receives coordinates already normalized. */
  execute: (
    args: Record<string, unknown>,
    toolContext?: Context,
  ) => Promise<unknown> | unknown;

  /** The real screen size as `[width, height]` in pixels. */
  screenSize: readonly [number, number];

  /**
   * The coordinate space the model addresses. Defaults to `[1000, 1000]`, so
   * the model's output does not depend on the real display.
   */
  virtualScreenSize?: readonly [number, number];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Reads the argument record out of the value the base class hands to `execute`.
 *
 * {@link FunctionTool} widens that value to `unknown` for a tool that declares
 * no parameter schema. Every call through `runAsync` supplies a record; a
 * caller that bypasses the compiler and supplies something else gets an empty
 * record, rather than a property read on a non-object.
 */
export function toExecuteArguments(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/** Rejects a screen size the tool cannot scale onto. */
export function validateScreenSize(
  label: string,
  size: readonly [number, number],
): void {
  if (size.some((dimension) => !Number.isFinite(dimension) || dimension <= 0)) {
    throw new Error(`${label} dimensions must be positive`);
  }
}

/**
 * Scales one coordinate from the virtual space onto the real screen.
 *
 * @param value The coordinate the model sent.
 * @param virtual The size of the virtual space along this axis.
 * @param real The size of the real screen along this axis.
 * @return An integer inside `[0, real - 1]`.
 */
export function normalizeCoordinate(
  value: number,
  virtual: number,
  real: number,
): number {
  // `Math.trunc` rather than `Math.floor`, to match Python's `int()` on the
  // negative values the clamp below then discards.
  const scaled = Math.trunc((value / virtual) * real);
  return Math.max(0, Math.min(scaled, real - 1));
}

/**
 * Returns a copy of `args` whose coordinate arguments address the real screen.
 *
 * Python normalizes the caller's dictionary in place. Copying leaves the
 * arguments recorded on the function-call event as the model sent them.
 *
 * @throws Error if a coordinate argument is present but is not a number.
 */
export function normalizeCoordinates(
  args: Record<string, unknown>,
  screenSize: readonly [number, number],
  virtualScreenSize: readonly [number, number],
): Record<string, unknown> {
  const normalized = {...args};
  for (const [key, axis] of COORDINATE_AXES) {
    if (!(key in normalized)) {
      continue;
    }
    const original = normalized[key];
    if (typeof original !== 'number') {
      throw new Error(
        `${AXIS_LABELS[axis]} coordinate must be numeric, got ${typeof original}`,
      );
    }
    const scaled = normalizeCoordinate(
      original,
      virtualScreenSize[axis],
      screenSize[axis],
    );
    normalized[key] = scaled;
    logger.debug(`Normalized ${key}: ${original} -> ${scaled}`);
  }
  return normalized;
}

/**
 * Applies the safety gate the computer-use model asks for out of band.
 *
 * @param args The raw arguments of the call.
 * @param toolContext The context of the call.
 * @return The payload to return instead of acting, or `undefined` to act.
 */
export function evaluateSafetyGate(
  args: Record<string, unknown>,
  toolContext: Context,
): {error: string} | undefined {
  if (toolContext.toolConfirmation) {
    return toolContext.toolConfirmation.confirmed
      ? undefined
      : {error: CONFIRMATION_REJECTED_ERROR};
  }

  const safetyDecision = args['safety_decision'];
  if (
    !isRecord(safetyDecision) ||
    safetyDecision['decision'] !== REQUIRE_CONFIRMATION_DECISION
  ) {
    return undefined;
  }

  const explanation = safetyDecision['explanation'];
  toolContext.requestConfirmation({
    hint:
      typeof explanation === 'string' && explanation.length > 0
        ? explanation
        : DEFAULT_CONFIRMATION_HINT,
  });
  toolContext.actions.skipSummarization = true;
  return {error: CONFIRMATION_REQUIRED_ERROR};
}

function toScreenshotPayload(state: ComputerState): Record<string, unknown> {
  return {
    image: {
      mimetype: SCREENSHOT_MIME_TYPE,
      data: base64Encode(state.screenshot),
    },
    url: state.url,
  };
}

function withSafetyAcknowledgement(response: unknown): Record<string, unknown> {
  const payload = isRecord(response) ? response : {result: response};
  return {...payload, safety_acknowledgement: 'true'};
}

/**
 * A tool that drives a computer through one of the Gemini computer-use
 * predefined functions.
 *
 * The model addresses a fixed virtual screen, 1000x1000 by default, so its
 * output does not depend on the real display. The tool scales those
 * coordinates onto `screenSize` before the action runs. It also holds back an
 * action the model flagged as unsafe until a human approves it.
 *
 * Ported from `src/google/adk/tools/computer_use/computer_use_tool.py` in
 * `google/adk-python`.
 */
@experimental
export class ComputerUseTool extends FunctionTool<Schema> {
  /** The real screen size as `[width, height]` in pixels. */
  readonly screenSize: readonly [number, number];

  /** The coordinate space the model addresses. */
  readonly virtualScreenSize: readonly [number, number];

  constructor(options: ComputerUseToolOptions) {
    super({
      name: options.name ?? options.execute.name,
      description: options.description,
      execute: (args, toolContext) =>
        options.execute(toExecuteArguments(args), toolContext),
    });
    this.screenSize = options.screenSize;
    this.virtualScreenSize =
      options.virtualScreenSize ?? DEFAULT_VIRTUAL_SCREEN_SIZE;
    validateScreenSize('screenSize', this.screenSize);
    validateScreenSize('virtualScreenSize', this.virtualScreenSize);
  }

  /**
   * Runs the computer control function with normalized coordinates.
   *
   * @param request The arguments the model sent, and the context of the call.
   * @return The image payload of the resulting {@link ComputerState}, the
   *     driver's own result when it returned something else, or the error
   *     payload of the safety gate.
   */
  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const {args, toolContext} = request;
    const gated = evaluateSafetyGate(args, toolContext);
    if (gated) {
      return gated;
    }

    try {
      const result = await super.runAsync({
        args: normalizeCoordinates(
          args,
          this.screenSize,
          this.virtualScreenSize,
        ),
        toolContext,
      });
      const response = isComputerState(result)
        ? toScreenshotPayload(result)
        : result;
      return toolContext.toolConfirmation?.confirmed
        ? withSafetyAcknowledgement(response)
        : response;
    } catch (error: unknown) {
      logger.error(`Error in ComputerUseTool.runAsync: ${String(error)}`);
      throw error;
    }
  }

  /**
   * Declares nothing to the model.
   *
   * `ComputerUseToolset` attaches the computer-use configuration to the
   * request, and the API supplies the declarations of the predefined
   * functions. Sending our own would duplicate them.
   */
  override async processLlmRequest(
    _request: ToolProcessLlmRequest,
  ): Promise<void> {}
}
