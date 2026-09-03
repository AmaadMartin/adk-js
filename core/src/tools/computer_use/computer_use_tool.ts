/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {base64Encode} from '../../utils/env_aware_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

import {isComputerState} from './base_computer.js';

/** The model-facing coordinate space, used when the caller names no other. */
const DEFAULT_VIRTUAL_SCREEN_SIZE: readonly [number, number] = [1000, 1000];

/** The `safety_decision.decision` value that gates a call on confirmation. */
const REQUIRE_CONFIRMATION_DECISION = 'require_confirmation';

/** The hint shown when the model asks for confirmation but explains nothing. */
const DEFAULT_CONFIRMATION_HINT =
  'This computer use action requires safety confirmation.';

/** Which screen axis each coordinate argument is scaled against. */
const COORDINATE_AXES: ReadonlyMap<string, 0 | 1> = new Map([
  ['x', 0],
  ['destination_x', 0],
  ['y', 1],
  ['destination_y', 1],
]);

/** A unique symbol identifying a computer-use tool across package copies. */
const COMPUTER_USE_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.computerUseTool',
);

/** The configuration of a {@link ComputerUseTool}. */
export interface ComputerUseToolOptions {
  /** The wire name of the predefined function, e.g. `click_at`. */
  name: string;
  /** What the action does, shown to the model. */
  description: string;
  /**
   * Runs the action. Receives the model's arguments with the coordinates
   * already scaled to `screenSize`.
   */
  invoke(args: Record<string, unknown>, toolContext: Context): Promise<unknown>;
  /** The real screen size as `[width, height]` in pixels. */
  screenSize: readonly [number, number];
  /**
   * The coordinate space the model works in. Defaults to `[1000, 1000]`, so
   * the model produces coordinates that do not depend on the real screen.
   */
  virtualScreenSize?: readonly [number, number];
}

/**
 * Whether `obj` is a {@link ComputerUseTool}.
 *
 * @param obj The value to check.
 * @return Whether the value is a computer-use tool.
 */
export function isComputerUseTool(obj: unknown): obj is ComputerUseTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    COMPUTER_USE_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/**
 * One predefined computer-use action, wrapping a call into a
 * {@link BaseComputer}.
 *
 * The tool scales the model's coordinates from a virtual space onto the real
 * screen, applies the computer-use safety handshake, and turns the state the
 * driver returns into the screenshot payload the model expects.
 *
 * It contributes no function declaration: the Gemini API populates the
 * computer-use declarations itself from the `Tool.computerUse` config that
 * `ComputerUseToolset` attaches. `_getDeclaration()` therefore returns
 * `undefined`, which leaves the inherited `processLlmRequest` inert.
 */
@experimental
export class ComputerUseTool extends BaseTool {
  /** A unique symbol to identify a computer-use tool. */
  readonly [COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] = true;

  /** The real screen size as `[width, height]` in pixels. */
  readonly screenSize: readonly [number, number];

  /** The coordinate space the model works in. */
  readonly virtualScreenSize: readonly [number, number];

  private readonly invoke: ComputerUseToolOptions['invoke'];

  /**
   * @param options The configuration of the tool.
   * @throws If either screen size holds a dimension that is not positive and
   *     finite.
   */
  constructor(options: ComputerUseToolOptions) {
    super({name: options.name, description: options.description});
    assertPositiveDimensions('screenSize', options.screenSize);
    this.screenSize = options.screenSize;
    this.virtualScreenSize =
      options.virtualScreenSize ?? DEFAULT_VIRTUAL_SCREEN_SIZE;
    assertPositiveDimensions('virtualScreenSize', this.virtualScreenSize);
    this.invoke = options.invoke;
  }

  /**
   * Runs the action, with the model's coordinates scaled to the real screen.
   *
   * @param request The arguments the model produced, and the tool context.
   * @return The payload to report back to the model.
   */
  override async runAsync({
    args,
    toolContext,
  }: RunAsyncToolRequest): Promise<unknown> {
    const gate = gateOnSafetyDecision(args, toolContext);
    if (gate) {
      return gate;
    }
    try {
      const result = await this.invoke(
        normalizeCoordinates(args, this.screenSize, this.virtualScreenSize),
        toolContext,
      );
      return acknowledgeConfirmation(toModelResponse(result), toolContext);
    } catch (error) {
      logger.error(`Error in ComputerUseTool.runAsync: ${String(error)}`);
      throw error;
    }
  }
}

/**
 * Applies the computer-use safety handshake.
 *
 * @param args The arguments the model produced.
 * @param toolContext The context of the call.
 * @return The payload to return instead of running the action, or `undefined`
 *     when the action may run.
 */
function gateOnSafetyDecision(
  args: Record<string, unknown>,
  toolContext: Context,
): {error: string} | undefined {
  if (toolContext.toolConfirmation) {
    return toolContext.toolConfirmation.confirmed
      ? undefined
      : {error: 'This tool call is rejected.'};
  }
  const hint = safetyConfirmationHint(args);
  if (!hint) {
    return undefined;
  }
  toolContext.requestConfirmation({hint});
  toolContext.actions.skipSummarization = true;
  return {
    error: 'This tool call requires confirmation, please approve or reject.',
  };
}

/**
 * The hint to confirm this call with, or `undefined` when the model did not
 * ask for confirmation. `safety_decision` belongs to no action's schema: the
 * model adds it out of band.
 */
function safetyConfirmationHint(
  args: Record<string, unknown>,
): string | undefined {
  const decision = args['safety_decision'];
  if (typeof decision !== 'object' || decision === null) {
    return undefined;
  }
  const fields = decision as Record<string, unknown>;
  if (fields['decision'] !== REQUIRE_CONFIRMATION_DECISION) {
    return undefined;
  }
  const explanation = fields['explanation'];
  return typeof explanation === 'string' && explanation
    ? explanation
    : DEFAULT_CONFIRMATION_HINT;
}

/**
 * Scales the coordinate arguments from the virtual space onto the real screen.
 * A coordinate that is not a number is left as it is, for the action's schema
 * to report.
 *
 * @param args The arguments the model produced.
 * @param screenSize The real screen size.
 * @param virtualScreenSize The coordinate space the model works in.
 * @return A copy of the arguments with the coordinates scaled.
 */
function normalizeCoordinates(
  args: Record<string, unknown>,
  screenSize: readonly [number, number],
  virtualScreenSize: readonly [number, number],
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {...args};
  for (const [key, axis] of COORDINATE_AXES) {
    const value = normalized[key];
    if (typeof value === 'number') {
      normalized[key] = normalizeCoordinate(
        value,
        virtualScreenSize[axis],
        screenSize[axis],
      );
    }
  }
  return normalized;
}

/** Maps one coordinate onto `real` pixels and clamps it to the screen. */
function normalizeCoordinate(
  value: number,
  virtual: number,
  real: number,
): number {
  return Math.max(0, Math.min(Math.trunc((value / virtual) * real), real - 1));
}

/**
 * Turns the driver's return value into the payload the model expects. A value
 * that is not a {@link ComputerState} passes through untouched.
 */
function toModelResponse(result: unknown): unknown {
  if (!isComputerState(result)) {
    return result;
  }
  return {
    image: {
      mimetype: 'image/png',
      data: base64Encode(result.screenshot ?? new Uint8Array()),
    },
    url: result.url,
  };
}

/**
 * Marks a response as produced by a confirmed call, so the model can tell it
 * apart from one that ran without the handshake.
 */
function acknowledgeConfirmation(
  response: unknown,
  toolContext: Context,
): unknown {
  if (!toolContext.toolConfirmation?.confirmed) {
    return response;
  }
  const fields = isRecord(response) ? response : {result: response};
  return {...fields, safety_acknowledgement: 'true'};
}

/** Whether `value` is an object the response fields can be merged into. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Throws unless both dimensions of `size` are positive and finite. */
function assertPositiveDimensions(
  name: string,
  size: readonly [number, number],
): void {
  if (!size.every((dimension) => Number.isFinite(dimension) && dimension > 0)) {
    throw new Error(`${name} dimensions must be positive`);
  }
}
