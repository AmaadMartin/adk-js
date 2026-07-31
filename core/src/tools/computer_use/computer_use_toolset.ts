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
import {
  ComputerFunc,
  ComputerUseTool,
  isComputerUseTool,
} from './computer_use_tool.js';

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

/**
 * The model-facing tool name of every predefined computer-use action.
 */
const COMPUTER_ACTION_TOOL_NAMES: ReadonlySet<string> = new Set(
  Object.keys(COMPUTER_ACTIONS).map(toSnakeCase),
);

/**
 * Produces a replacement for a registered computer-use function.
 *
 * The name of the returned function becomes the name of the replacement tool,
 * so it must be a named function. May be sync or async.
 */
export type ComputerUseToolAdapter = (
  func: ComputerFunc,
) => ComputerFunc | Promise<ComputerFunc>;

@experimental
export class ComputerUseToolset extends BaseToolset {
  private readonly computer: BaseComputer;
  private readonly excludedPredefinedFunctions?: string[];
  private tools?: Promise<ComputerUseTool[]>;

  constructor(options: {
    computer: BaseComputer;
    excludedPredefinedFunctions?: string[];
  }) {
    super([]);
    this.computer = options.computer;
    this.excludedPredefinedFunctions = options.excludedPredefinedFunctions;
  }

  /**
   * Replaces a registered computer-use tool with an adapted variant.
   *
   * A model preprocessor uses this to reshape a predefined action for a
   * specific model -- turning `wait(seconds)` into a zero-argument
   * `wait_5_seconds`, for example. Anything it cannot act on is a warning
   * rather than an error, so a preprocessor never breaks a request by asking
   * to adapt a tool the toolset did not register.
   *
   * @param toolName The model-facing tool name to adapt, e.g. `wait`.
   * @param adapter Produces the replacement function; its name becomes the
   *     name of the replacement tool.
   * @param llmRequest The request whose `toolsDict` is rewritten in place.
   */
  static async adaptComputerUseTool(
    toolName: string,
    adapter: ComputerUseToolAdapter,
    llmRequest: LlmRequest,
  ): Promise<void> {
    if (!COMPUTER_ACTION_TOOL_NAMES.has(toolName)) {
      logger.warn(`${toolName} is not a predefined computer use action`);
      return;
    }

    const originalTool = llmRequest.toolsDict[toolName];
    if (!isComputerUseTool(originalTool)) {
      logger.warn(`Computer use tool ${toolName} is not in tools_dict`);
      return;
    }

    const adaptedFunc = await adapter(originalTool.func);
    const adaptedName = adaptedFunc.name;
    if (!adaptedName) {
      logger.warn(
        `Adapter for ${toolName} returned an anonymous function, which cannot be registered as a tool`,
      );
      return;
    }

    llmRequest.toolsDict[adaptedName] = new ComputerUseTool({
      name: adaptedName,
      func: adaptedFunc,
      screenSize: originalTool.screenSize,
      virtualScreenSize: originalTool.virtualScreenSize,
    });
    delete llmRequest.toolsDict[toolName];

    logger.debug(`Adapted computer use tool ${toolName} to ${adaptedName}`);
  }

  override getTools(
    _readonlyContext?: ReadonlyContext,
  ): Promise<ComputerUseTool[]> {
    // Memoizing the promise rather than the resolved array keeps
    // `computer.initialize()` to one call even when callers race.
    this.tools ??= this.buildTools();
    return this.tools;
  }

  private async buildTools(): Promise<ComputerUseTool[]> {
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
