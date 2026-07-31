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
import {ComputerState} from './base_computer.js';

/**
 * The wrapped computer method a {@link ComputerUseTool} invokes.
 *
 * `ComputerUseToolset` produces these; the arguments are the model-provided
 * tool arguments after coordinate normalization.
 */
export type ComputerFunc = (
  args: Record<string, unknown>,
  toolContext: Context,
) => Promise<ComputerState>;

/**
 * The virtual coordinate space the model reports coordinates in.
 */
const DEFAULT_VIRTUAL_SCREEN_SIZE: [number, number] = [1000, 1000];

/**
 * The coordinate arguments that are normalized from the virtual coordinate
 * space to the real screen, mapped to the screen axis they belong to.
 */
const COORDINATE_AXIS_BY_ARG = {
  x: 0,
  y: 1,
  destination_x: 0,
  destination_y: 1,
} as const;

/**
 * A unique symbol to identify ADK computer use tools.
 */
const COMPUTER_USE_TOOL_SIGNATURE_SYMBOL = Symbol.for(
  'google.adk.computerUseTool',
);

/**
 * Type guard to check if an object is a {@link ComputerUseTool}.
 *
 * @param obj The object to check.
 * @returns True if the object is a `ComputerUseTool`, false otherwise.
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
 * The confirmation hint for a call the model flagged as needing one, or
 * undefined when it did not flag the call.
 */
function safetyConfirmationHint(
  args: Record<string, unknown>,
): string | undefined {
  const decision = args['safetyDecision'] ?? args['safety_decision'];
  if (
    typeof decision !== 'object' ||
    decision === null ||
    !('decision' in decision) ||
    decision.decision !== 'require_confirmation'
  ) {
    return undefined;
  }
  const explanation = 'explanation' in decision ? decision.explanation : '';
  return typeof explanation === 'string' && explanation
    ? explanation
    : 'This computer use action requires safety confirmation.';
}

/**
 * Converts a {@link ComputerState} into the response returned to the model.
 */
function toToolResponse(state: ComputerState): Record<string, unknown> {
  const response: Record<string, unknown> = {};

  if (state.screenshot) {
    // base64Encode, not Buffer: core is also published for the browser via
    // index_web.ts, where Buffer is not defined.
    response['image'] = {
      mimetype: 'image/png',
      data: base64Encode(state.screenshot),
    };
  }

  if (state.url) {
    response['url'] = state.url;
  }

  return response;
}

@experimental
export class ComputerUseTool extends BaseTool {
  /** A unique symbol to identify ADK computer use tools. */
  readonly [COMPUTER_USE_TOOL_SIGNATURE_SYMBOL] = true;

  /** Real screen size in pixels, as `[width, height]`. */
  readonly screenSize: [number, number];
  /** Virtual coordinate space the model reports coordinates in. */
  readonly virtualScreenSize: [number, number];
  private readonly func: ComputerFunc;

  constructor(options: {
    func: ComputerFunc;
    screenSize: [number, number];
    virtualScreenSize?: [number, number];
    name?: string;
  }) {
    const name = options.name ?? options.func.name;
    if (!name) {
      throw new Error('Tool name cannot be empty.');
    }

    super({
      name,
      description: `Computer control function: ${name}`,
    });

    this.func = options.func;
    this.screenSize = options.screenSize;
    this.virtualScreenSize =
      options.virtualScreenSize ?? DEFAULT_VIRTUAL_SCREEN_SIZE;

    // The tuple arity is enforced by the type; only the values need checking.
    for (const [sizeName, size] of [
      ['screenSize', this.screenSize],
      ['virtualScreenSize', this.virtualScreenSize],
    ] as const) {
      if (size[0] <= 0 || size[1] <= 0) {
        throw new Error(`${sizeName} dimensions must be positive`);
      }
    }
  }

  private normalize(value: unknown, argName: string, axis: 0 | 1): number {
    if (typeof value !== 'number')
      throw new Error(
        `${argName} coordinate must be numeric, got ${typeof value}`,
      );
    const norm = Math.floor(
      (value / this.virtualScreenSize[axis]) * this.screenSize[axis],
    );
    return Math.max(0, Math.min(norm, this.screenSize[axis] - 1));
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    const {args, toolContext} = req;

    if (!toolContext.toolConfirmation) {
      const hint = safetyConfirmationHint(args);
      if (hint) {
        toolContext.requestConfirmation({hint});
        toolContext.actions.skipSummarization = true;
        return {
          error:
            'This tool call requires confirmation, please approve or reject.',
        };
      }
    } else if (!toolContext.toolConfirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }

    const callArgs = {...args};

    for (const [argName, axis] of Object.entries(COORDINATE_AXIS_BY_ARG)) {
      if (argName in callArgs) {
        const original = callArgs[argName];
        const normalized = this.normalize(original, argName, axis);
        callArgs[argName] = normalized;
        logger.debug(`Normalized ${argName}: ${original} -> ${normalized}`);
      }
    }

    const response = toToolResponse(await this.func(callArgs, toolContext));

    if (toolContext.toolConfirmation?.confirmed) {
      response['safety_acknowledgement'] = 'true';
    }

    return response;
  }
}
