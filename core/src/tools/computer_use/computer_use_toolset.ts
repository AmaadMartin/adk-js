/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Tool} from '@google/genai';

import {Context} from '../../agents/context.js';
import {ReadonlyContext} from '../../agents/readonly_context.js';
import {LlmRequest} from '../../models/llm_request.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {BaseToolset} from '../base_toolset.js';
import {
  BaseComputer,
  ComputerActionName,
  ComputerScrollDirection,
  ComputerState,
} from './base_computer.js';
import {ComputerUseTool} from './computer_use_tool.js';

const SCROLL_DIRECTIONS: readonly ComputerScrollDirection[] = [
  'up',
  'down',
  'left',
  'right',
];

/**
 * Reads a required number off the model-provided arguments.
 */
function numberArg(args: Record<string, unknown>, key: string): number {
  const value = args[key];
  if (typeof value !== 'number') {
    throw new Error(
      `Computer use argument "${key}" must be a number, got ${typeof value}.`,
    );
  }
  return value;
}

/**
 * Reads a required string off the model-provided arguments.
 */
function stringArg(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') {
    throw new Error(
      `Computer use argument "${key}" must be a string, got ${typeof value}.`,
    );
  }
  return value;
}

/**
 * Reads an optional boolean off the model-provided arguments.
 */
function optionalBooleanArg(
  args: Record<string, unknown>,
  key: string,
): boolean | undefined {
  const value = args[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'boolean') {
    throw new Error(
      `Computer use argument "${key}" must be a boolean, got ${typeof value}.`,
    );
  }
  return value;
}

/**
 * Reads a required array of strings off the model-provided arguments.
 */
function stringArrayArg(args: Record<string, unknown>, key: string): string[] {
  const value = args[key];
  if (!Array.isArray(value)) {
    throw new Error(`Computer use argument "${key}" must be a string array.`);
  }
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new Error(
        `Computer use argument "${key}[${index}]" must be a string, got ${typeof entry}.`,
      );
    }
    return entry;
  });
}

/**
 * Reads the required scroll direction off the model-provided arguments.
 */
function directionArg(args: Record<string, unknown>): ComputerScrollDirection {
  const value = args['direction'];
  const direction = SCROLL_DIRECTIONS.find((candidate) => candidate === value);
  if (!direction) {
    throw new Error(
      `Computer use argument "direction" must be one of ${SCROLL_DIRECTIONS.join(', ')}.`,
    );
  }
  return direction;
}

/**
 * Invokes one predefined computer-use action with the model-provided
 * arguments.
 */
type ComputerActionInvoker = (
  computer: BaseComputer,
  args: Record<string, unknown>,
) => Promise<ComputerState>;

/**
 * The model-facing action space, mirroring the Gemini predefined computer-use
 * functions that `BaseComputer` declares.
 *
 * Keying this table by `ComputerActionName` makes it exhaustive: an abstract
 * action added to `BaseComputer` fails to compile until it is listed here, and
 * a helper method a `BaseComputer` subclass happens to define is never exposed
 * to the model.
 */
const COMPUTER_ACTIONS: Readonly<
  Record<ComputerActionName, ComputerActionInvoker>
> = {
  openWebBrowser: (computer) => computer.openWebBrowser(),
  clickAt: (computer, args) =>
    computer.clickAt({x: numberArg(args, 'x'), y: numberArg(args, 'y')}),
  hoverAt: (computer, args) =>
    computer.hoverAt({x: numberArg(args, 'x'), y: numberArg(args, 'y')}),
  typeTextAt: (computer, args) =>
    computer.typeTextAt({
      x: numberArg(args, 'x'),
      y: numberArg(args, 'y'),
      text: stringArg(args, 'text'),
      press_enter: optionalBooleanArg(args, 'press_enter'),
      clear_before_typing: optionalBooleanArg(args, 'clear_before_typing'),
    }),
  scrollDocument: (computer, args) =>
    computer.scrollDocument({direction: directionArg(args)}),
  scrollAt: (computer, args) =>
    computer.scrollAt({
      x: numberArg(args, 'x'),
      y: numberArg(args, 'y'),
      direction: directionArg(args),
      magnitude: numberArg(args, 'magnitude'),
    }),
  wait: (computer, args) =>
    computer.wait({seconds: numberArg(args, 'seconds')}),
  goBack: (computer) => computer.goBack(),
  goForward: (computer) => computer.goForward(),
  search: (computer) => computer.search(),
  navigate: (computer, args) =>
    computer.navigate({url: stringArg(args, 'url')}),
  keyCombination: (computer, args) =>
    computer.keyCombination({keys: stringArrayArg(args, 'keys')}),
  dragAndDrop: (computer, args) =>
    computer.dragAndDrop({
      x: numberArg(args, 'x'),
      y: numberArg(args, 'y'),
      destination_x: numberArg(args, 'destination_x'),
      destination_y: numberArg(args, 'destination_y'),
    }),
  currentState: (computer) => computer.currentState(),
};

/**
 * Converts a computer method name to the snake_case tool name the model uses.
 */
function toSnakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

@experimental
export class ComputerUseToolset extends BaseToolset {
  private readonly computer: BaseComputer;
  private readonly excludedPredefinedFunctions?: string[];
  private tools: ComputerUseTool[] | null = null;

  constructor(options: {
    computer: BaseComputer;
    excludedPredefinedFunctions?: string[];
  }) {
    super([]);
    this.computer = options.computer;
    this.excludedPredefinedFunctions = options.excludedPredefinedFunctions;
  }

  override async getTools(
    _readonlyContext?: ReadonlyContext,
  ): Promise<ComputerUseTool[]> {
    if (this.tools) {
      return this.tools;
    }

    await this.computer.initialize();
    const screenSize = await this.computer.screenSize();

    const tools: ComputerUseTool[] = [];
    for (const [methodName, invokeAction] of Object.entries(COMPUTER_ACTIONS)) {
      const snakeCaseName = toSnakeCase(methodName);

      if (
        this.excludedPredefinedFunctions?.includes(methodName) ||
        this.excludedPredefinedFunctions?.includes(snakeCaseName)
      ) {
        continue;
      }

      tools.push(
        new ComputerUseTool({
          name: snakeCaseName,
          func: async (args, toolContext) => {
            await this.computer.prepare(toolContext);
            return invokeAction(this.computer, args);
          },
          screenSize,
        }),
      );
    }

    this.tools = tools;
    return tools;
  }

  override async close(): Promise<void> {
    await this.computer.close();
  }

  override async processLlmRequest(
    toolContext: Context,
    llmRequest: LlmRequest,
  ): Promise<void> {
    try {
      for (const tool of await this.getTools()) {
        llmRequest.toolsDict[tool.name] = tool;
      }

      llmRequest.config = llmRequest.config ?? {};
      llmRequest.config.tools = llmRequest.config.tools ?? [];

      for (const tool of llmRequest.config.tools) {
        if ('computerUse' in tool && tool.computerUse) {
          logger.debug('Computer use already configured in LLM request');
          return;
        }
      }

      const environment = await this.computer.environment();
      const computerUseTool: Tool = {
        computerUse: {
          environment,
          excludedPredefinedFunctions: this.excludedPredefinedFunctions,
        },
      };
      llmRequest.config.tools.push(computerUseTool);

      logger.debug(
        `Added computer use tool with environment: ${environment}, excluded_functions: ${this.excludedPredefinedFunctions}`,
      );
    } catch (e) {
      logger.error(`Error in ComputerUseToolset.processLlmRequest: ${e}`);
      throw e;
    }
  }
}
