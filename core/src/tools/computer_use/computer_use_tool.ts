/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
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
) => Promise<unknown>;

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
 * Whether a computer method returned a {@link ComputerState}.
 */
function isComputerState(value: unknown): value is ComputerState {
  return (
    typeof value === 'object' &&
    value !== null &&
    ('screenshot' in value || 'url' in value)
  );
}

/**
 * Whether a value is a plain keyed object that extra keys can be added to.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * The safety decision the model attaches to a computer use action.
 */
interface SafetyDecision {
  decision?: string;
  explanation?: string;
}

/**
 * Reads the safety decision out of the model-provided tool arguments.
 */
function readSafetyDecision(
  args: Record<string, unknown>,
): SafetyDecision | undefined {
  const value = args['safetyDecision'] ?? args['safety_decision'];
  if (!isRecord(value)) {
    return undefined;
  }
  const {decision, explanation} = value;
  return {
    decision: typeof decision === 'string' ? decision : undefined,
    explanation: typeof explanation === 'string' ? explanation : undefined,
  };
}

/**
 * Converts a {@link ComputerState} into the response returned to the model.
 */
function toToolResponse(state: ComputerState): Record<string, unknown> {
  const response: Record<string, unknown> = {};

  if (state.screenshot) {
    try {
      response['image'] = {
        mimetype: 'image/png',
        data: Buffer.from(state.screenshot).toString('base64'),
      };
    } catch (e) {
      // Surface the failure instead of returning a success with no screenshot,
      // which the model cannot distinguish from a blank screen.
      logger.warn(`Could not base64 encode screenshot. ${e}`);
      response['error'] = `Could not base64 encode screenshot: ${e}`;
    }
  }

  if (state.url) {
    response['url'] = state.url;
  }

  return response;
}

@experimental
export class ComputerUseTool extends BaseTool {
  private readonly screenSize: [number, number];
  private readonly coordinateSpace: [number, number];
  private readonly computerFunc: ComputerFunc;

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

    this.computerFunc = options.func;
    this.screenSize = options.screenSize;
    this.coordinateSpace =
      options.virtualScreenSize ?? DEFAULT_VIRTUAL_SCREEN_SIZE;

    // The tuple arity is enforced by the type; only the values need checking.
    for (const [sizeName, size] of [
      ['screenSize', this.screenSize],
      ['virtualScreenSize', this.coordinateSpace],
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
      (value / this.coordinateSpace[axis]) * this.screenSize[axis],
    );
    return Math.max(0, Math.min(norm, this.screenSize[axis] - 1));
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    const {args, toolContext} = req;

    if (!toolContext.toolConfirmation) {
      const safetyDecision = readSafetyDecision(args);
      if (safetyDecision?.decision === 'require_confirmation') {
        const hint =
          safetyDecision.explanation ||
          'This computer use action requires safety confirmation.';
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

    try {
      const callArgs = {...args};

      for (const [argName, axis] of Object.entries(COORDINATE_AXIS_BY_ARG)) {
        if (argName in callArgs) {
          const original = callArgs[argName];
          const normalized = this.normalize(original, argName, axis);
          callArgs[argName] = normalized;
          logger.debug(`Normalized ${argName}: ${original} -> ${normalized}`);
        }
      }

      // The toolset wraps each computer method to accept the argument object,
      // so it is passed through unchanged.
      const result = await this.computerFunc(callArgs, toolContext);

      let response: unknown = isComputerState(result)
        ? toToolResponse(result)
        : result;

      if (toolContext.toolConfirmation?.confirmed) {
        const acknowledged: Record<string, unknown> = isRecord(response)
          ? {...response}
          : {result: response};
        acknowledged['safety_acknowledgement'] = 'true';
        response = acknowledged;
      }

      return response;
    } catch (e) {
      logger.error(`Error in ComputerUseTool.runAsync: ${e}`);
      throw e;
    }
  }
}
