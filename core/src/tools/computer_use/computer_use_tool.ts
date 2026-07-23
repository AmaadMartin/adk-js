/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any */

import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseTool, RunAsyncToolRequest} from '../base_tool.js';

@experimental
export class ComputerUseTool extends BaseTool {
  private readonly screenSize: [number, number];
  private readonly coordinateSpace: [number, number];
  private readonly computerFunc: (...args: any[]) => any;

  constructor(options: {
    func: (...args: any[]) => any;
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
    this.coordinateSpace = options.virtualScreenSize ?? [1000, 1000];

    for (const [n, size] of [
      ['screenSize', this.screenSize],
      ['virtualScreenSize', this.coordinateSpace],
    ] as const) {
      if (!Array.isArray(size) || size.length !== 2)
        throw new Error(`${n} must be a tuple of [width, height]`);
      if (size[0] <= 0 || size[1] <= 0)
        throw new Error(`${n} dimensions must be positive`);
    }
  }

  private normalize(val: unknown, axis: 'x' | 'y', idx: 0 | 1): number {
    if (typeof val !== 'number')
      throw new Error(`${axis} coordinate must be numeric, got ${typeof val}`);
    const norm = Math.floor(
      (val / this.coordinateSpace[idx]) * this.screenSize[idx],
    );
    return Math.max(0, Math.min(norm, this.screenSize[idx] - 1));
  }

  override async runAsync(req: RunAsyncToolRequest): Promise<unknown> {
    const {args, toolContext} = req;

    if (!toolContext.toolConfirmation) {
      const safetyDecision = (args['safetyDecision'] ||
        args['safety_decision']) as Record<string, string> | undefined;
      if (safetyDecision) {
        const decision = safetyDecision['decision'];
        const explanation = safetyDecision['explanation'];

        if (decision === 'require_confirmation') {
          const hint =
            explanation ||
            'This computer use action requires safety confirmation.';
          toolContext.requestConfirmation({hint});
          toolContext.actions.skipSummarization = true;
          return {
            error:
              'This tool call requires confirmation, please approve or reject.',
          };
        }
      }
    } else if (!toolContext.toolConfirmation.confirmed) {
      return {error: 'This tool call is rejected.'};
    }

    try {
      const callArgs = {...args};

      for (const [key, axis, idx, alias] of [
        ['x', 'x', 0, 'x'],
        ['y', 'y', 1, 'y'],
        ['destination_x', 'x', 0, 'destination_x'],
        ['destination_y', 'y', 1, 'destination_y'],
        ['destinationX', 'x', 0, 'destination_x'],
        ['destinationY', 'y', 1, 'destination_y'],
      ] as const) {
        if (key in callArgs) {
          const orig = callArgs[key];
          const norm = (callArgs[key] = this.normalize(
            orig,
            axis as 'x' | 'y',
            idx as 0 | 1,
          ));
          if (alias !== key) callArgs[alias] = norm;
          logger.debug(`Normalized ${key}: ${orig} -> ${norm}`);
        }
      }

      // We have arguments mapped. Because JS doesn't have kwargs unpacking natively,
      // and we adapt the base computer methods using wrappers anyway, we can pass callArgs object directly
      // OR we can rely on the wrapper to unpack them if we generate wrappers in ComputerUseToolset.
      // Python's `super().run_async()` unrolls args dict if the schema mapping works.
      // Since we omitted parameters schema validation, we will just call computerFunc directly
      // with the unrolled parameters (by checking parameter names in the wrapper).
      // A common pattern is passing `callArgs, toolContext`.
      const result = await this.computerFunc(callArgs, toolContext);

      let response: any = result;

      // Handle duck typing of ComputerState structure
      if (
        result &&
        typeof result === 'object' &&
        ('screenshot' in result || 'url' in result)
      ) {
        response = {};
        if (result.screenshot) {
          try {
            const buf = Buffer.from(result.screenshot);
            response['image'] = {
              mimetype: 'image/png',
              data: buf.toString('base64'),
            };
          } catch (err) {
            logger.warn(`Could not base64 encode screenshot. ${err}`);
          }
        }
        if (result.url) {
          response['url'] = result.url;
        }
      }

      if (
        toolContext.toolConfirmation &&
        toolContext.toolConfirmation.confirmed
      ) {
        if (typeof response !== 'object' || response === null) {
          response = {result: response};
        }
        response['safety_acknowledgement'] = 'true';
      }

      return response;
    } catch (e) {
      logger.error(`Error in ComputerUseTool.runAsync: ${e}`);
      throw e;
    }
  }
}
