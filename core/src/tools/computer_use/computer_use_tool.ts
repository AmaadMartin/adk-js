/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {Context} from '../../agents/context.js';
import {base64Encode} from '../../utils/env_aware_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';
import {isComputerState} from './base_computer.js';

/** A unique symbol identifying an ADK computer-use tool. */
const COMPUTER_USE_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.computerUseTool',
);

/**
 * Type guard for {@link ComputerUseTool}.
 *
 * Structural rather than `instanceof`, so it stays correct when two copies of
 * adk-js share one runtime.
 */
export function isComputerUseTool(obj: unknown): obj is ComputerUseTool {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    COMPUTER_USE_TOOL_SIGNATURE_SYMBOL in obj &&
    obj[COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] === true
  );
}

/** The virtual coordinate space the model addresses by default. */
const DEFAULT_VIRTUAL_SCREEN_SIZE: readonly [number, number] = [1000, 1000];

/** The hint used when the model requests confirmation without an explanation. */
const DEFAULT_CONFIRMATION_HINT =
  'This computer use action requires safety confirmation.';

/** Returned when the model must confirm an action before it runs. */
const CONFIRMATION_REQUIRED_ERROR =
  'This tool call requires confirmation, please approve or reject.';

/** Returned when a human rejected the action. */
const CONFIRMATION_REJECTED_ERROR = 'This tool call is rejected.';

/** The coordinate arguments, and the screen axis each is scaled against. */
const COORDINATE_ARGUMENTS = [
  ['x', 0],
  ['y', 1],
  ['destination_x', 0],
  ['destination_y', 1],
] as const;

/**
 * The safety verdict the computer-use model attaches to an action. It is not
 * part of any action's declared schema; the model adds it out of band.
 */
const safetyDecisionSchema = z.object({
  decision: z.string().optional(),
  explanation: z.string().optional(),
});

/** Options for {@link ComputerUseTool}. */
export interface ComputerUseToolOptions {
  /** The wire name of the predefined computer-use function. */
  name: string;
  /** The description the model reads. */
  description: string;
  /** Performs the action. Receives coordinates already normalized. */
  invoke(args: Record<string, unknown>, toolContext: Context): Promise<unknown>;
  /** The real screen size as `[width, height]` in pixels. */
  screenSize: readonly [number, number];
  /** The coordinate space the model addresses. Defaults to `[1000, 1000]`. */
  virtualScreenSize?: readonly [number, number];
}

/**
 * Scales one coordinate from the model's virtual space onto the real screen
 * and clamps it into `[0, real - 1]`.
 */
function normalizeCoordinate(
  value: number,
  virtual: number,
  real: number,
): number {
  return Math.max(0, Math.min(Math.floor((value / virtual) * real), real - 1));
}

/** Throws when a screen size is not a pair of positive, finite numbers. */
function assertScreenSize(
  size: readonly [number, number],
  label: string,
): void {
  if (!size.every((dimension) => Number.isFinite(dimension) && dimension > 0)) {
    throw new Error(`${label} dimensions must be positive`);
  }
}

/**
 * Normalizes every coordinate argument in place, leaving the other arguments
 * untouched. A coordinate the model sent as a non-number is left alone so the
 * action's own schema reports it.
 */
function normalizeCoordinates(
  args: Record<string, unknown>,
  screenSize: readonly [number, number],
  virtualScreenSize: readonly [number, number],
): Record<string, unknown> {
  const normalized = {...args};
  for (const [key, axis] of COORDINATE_ARGUMENTS) {
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

/**
 * Converts an action result into the payload the model expects. A
 * {@link ComputerState} becomes a screenshot part; anything else is returned
 * unchanged.
 */
function toModelResponse(result: unknown): unknown {
  if (!isComputerState(result)) {
    return result;
  }
  return {
    // `mimetype` is lowercase because that is the key the model reads.
    // `base64Encode` picks btoa or Buffer per environment: core is published
    // for the browser too, where Buffer is undefined.
    ...(result.screenshot
      ? {image: {mimetype: 'image/png', data: base64Encode(result.screenshot)}}
      : {}),
    url: result.url,
  };
}

/**
 * One predefined Gemini computer-use function, bound to a user's environment
 * driver.
 *
 * The model addresses a fixed virtual screen — 1000x1000 by default — so its
 * output does not depend on the real display. This tool scales those
 * coordinates onto the real screen before the action runs, and enforces the
 * confirmation gate the model asks for through `safety_decision`.
 */
@experimental
export class ComputerUseTool extends BaseTool {
  readonly [COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] = true;

  /** The real screen size the coordinates are scaled onto. */
  readonly screenSize: readonly [number, number];

  /** The coordinate space the model addresses. */
  readonly virtualScreenSize: readonly [number, number];

  private readonly invoke: ComputerUseToolOptions['invoke'];

  constructor(options: ComputerUseToolOptions) {
    super({name: options.name, description: options.description});
    this.screenSize = options.screenSize;
    this.virtualScreenSize =
      options.virtualScreenSize ?? DEFAULT_VIRTUAL_SCREEN_SIZE;
    this.invoke = options.invoke;

    assertScreenSize(this.screenSize, 'screenSize');
    assertScreenSize(this.virtualScreenSize, 'virtualScreenSize');
  }

  /**
   * A no-op: `ComputerUseToolset` registers this tool and attaches the
   * `computerUse` config, and the API populates the predefined function
   * declarations from that config. Sending our own would duplicate them.
   *
   * `_getDeclaration` is deliberately left returning `undefined` from the base
   * class for the same reason: a caller that built declarations from these
   * tools would send the duplicates this override exists to avoid.
   */
  override async processLlmRequest(): Promise<void> {}

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    const {args, toolContext} = request;
    const {toolConfirmation} = toolContext;

    if (!toolConfirmation) {
      const decision = safetyDecisionSchema.safeParse(args['safety_decision']);
      if (
        decision.success &&
        decision.data.decision === 'require_confirmation'
      ) {
        toolContext.requestConfirmation({
          hint: decision.data.explanation || DEFAULT_CONFIRMATION_HINT,
        });
        toolContext.actions.skipSummarization = true;
        return {error: CONFIRMATION_REQUIRED_ERROR};
      }
    } else if (!toolConfirmation.confirmed) {
      return {error: CONFIRMATION_REJECTED_ERROR};
    }

    let result: unknown;
    try {
      result = await this.invoke(
        normalizeCoordinates(args, this.screenSize, this.virtualScreenSize),
        toolContext,
      );
    } catch (e: unknown) {
      logger.error(`Error in ComputerUseTool '${this.name}': ${e}`);
      throw e;
    }

    const response = toModelResponse(result);
    if (!toolConfirmation?.confirmed) {
      return response;
    }
    return {
      ...(typeof response === 'object' && response !== null
        ? response
        : {result: response}),
      safety_acknowledgement: 'true',
    };
  }
}
