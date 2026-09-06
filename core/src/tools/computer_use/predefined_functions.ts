/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {z} from 'zod';

import {BaseComputer, ComputerState} from './base_computer.js';

/**
 * One predefined computer-use action, as the model sees it.
 *
 * The names here are the wire names the computer-use model calls, and the same
 * names the `excludedPredefinedFunctions` request field is matched against, so
 * they stay `snake_case` rather than following the TypeScript convention.
 */
export interface PredefinedComputerFunction {
  /** The wire name the model calls, for example `click_at`. */
  readonly name: string;
  /** The model-facing description of the action. */
  readonly description: string;
  /** The schema of the action's arguments, keyed by their wire names. */
  readonly parameters: z.ZodObject<z.ZodRawShape>;
  /** Validates `args` against {@link parameters} and runs the action. */
  invoke(computer: BaseComputer, args: unknown): Promise<ComputerState>;
}

/** Ties an argument schema to the {@link BaseComputer} method it feeds. */
function definePredefinedFunction<TShape extends z.ZodRawShape>(
  name: string,
  description: string,
  parameters: z.ZodObject<TShape>,
  run: (
    computer: BaseComputer,
    args: z.infer<z.ZodObject<TShape>>,
  ) => Promise<ComputerState>,
): PredefinedComputerFunction {
  return {
    name,
    description,
    parameters,
    invoke: (computer, args) => run(computer, parameters.parse(args)),
  };
}

const NO_ARGUMENTS = z.object({});

const COORDINATE_NOTE =
  "The 'x' and 'y' values are absolute values, scaled to the height and width" +
  ' of the screen.';

const X_COORDINATE = z.number().int();
const Y_COORDINATE = z.number().int();

const SCROLL_DIRECTION = z
  .enum(['up', 'down', 'left', 'right'])
  .describe('The direction to scroll.');

/**
 * Every action a {@link BaseComputer} exposes to the model.
 *
 * The lifecycle methods (`screenSize`, `environment`, `initialize`, `prepare`
 * and `close`) are deliberately absent: the toolset drives them, and the model
 * must not.
 */
export const PREDEFINED_COMPUTER_FUNCTIONS: readonly PredefinedComputerFunction[] =
  [
    definePredefinedFunction(
      'open_web_browser',
      'Opens the web browser.',
      NO_ARGUMENTS,
      (computer) => computer.openWebBrowser(),
    ),
    definePredefinedFunction(
      'click_at',
      `Clicks at a specific x, y coordinate on the webpage. ${COORDINATE_NOTE}`,
      z.object({
        x: X_COORDINATE.describe('The x-coordinate to click at.'),
        y: Y_COORDINATE.describe('The y-coordinate to click at.'),
      }),
      (computer, {x, y}) => computer.clickAt(x, y),
    ),
    definePredefinedFunction(
      'hover_at',
      'Hovers at a specific x, y coordinate on the webpage. May be used to' +
        ` explore sub-menus that appear on hover. ${COORDINATE_NOTE}`,
      z.object({
        x: X_COORDINATE.describe('The x-coordinate to hover at.'),
        y: Y_COORDINATE.describe('The y-coordinate to hover at.'),
      }),
      (computer, {x, y}) => computer.hoverAt(x, y),
    ),
    definePredefinedFunction(
      'type_text_at',
      'Types text at a specific x, y coordinate. The system automatically' +
        ' presses ENTER after typing. To disable this, set `press_enter` to' +
        ' False. The system automatically clears any existing content before' +
        ' typing the specified `text`. To disable this, set' +
        ` \`clear_before_typing\` to False. ${COORDINATE_NOTE}`,
      z.object({
        x: X_COORDINATE.describe('The x-coordinate to type at.'),
        y: Y_COORDINATE.describe('The y-coordinate to type at.'),
        text: z.string().describe('The text to type.'),
        press_enter: z
          .boolean()
          .default(true)
          .describe('Whether to press ENTER after typing.'),
        clear_before_typing: z
          .boolean()
          .default(true)
          .describe('Whether to clear existing content before typing.'),
      }),
      (computer, {x, y, text, press_enter, clear_before_typing}) =>
        computer.typeTextAt(x, y, text, press_enter, clear_before_typing),
    ),
    definePredefinedFunction(
      'scroll_document',
      'Scrolls the entire webpage "up", "down", "left" or "right" based on' +
        ' direction.',
      z.object({direction: SCROLL_DIRECTION}),
      (computer, {direction}) => computer.scrollDocument(direction),
    ),
    definePredefinedFunction(
      'scroll_at',
      'Scrolls up, down, right, or left at a x, y coordinate by magnitude.' +
        ` ${COORDINATE_NOTE}`,
      z.object({
        x: X_COORDINATE.describe('The x-coordinate to scroll at.'),
        y: Y_COORDINATE.describe('The y-coordinate to scroll at.'),
        direction: SCROLL_DIRECTION,
        magnitude: z.number().int().describe('The amount to scroll.'),
      }),
      (computer, {x, y, direction, magnitude}) =>
        computer.scrollAt(x, y, direction, magnitude),
    ),
    definePredefinedFunction(
      'wait',
      'Waits for n seconds to allow unfinished webpage processes to complete.',
      z.object({
        seconds: z.number().int().describe('The number of seconds to wait.'),
      }),
      (computer, {seconds}) => computer.wait(seconds),
    ),
    definePredefinedFunction(
      'go_back',
      'Navigates back to the previous webpage in the browser history.',
      NO_ARGUMENTS,
      (computer) => computer.goBack(),
    ),
    definePredefinedFunction(
      'go_forward',
      'Navigates forward to the next webpage in the browser history.',
      NO_ARGUMENTS,
      (computer) => computer.goForward(),
    ),
    definePredefinedFunction(
      'search',
      'Directly jumps to a search engine home page. Used when you need to' +
        ' start with a search. For example, this is used when the current' +
        " website doesn't have the information needed or because a new task" +
        ' is being started.',
      NO_ARGUMENTS,
      (computer) => computer.search(),
    ),
    definePredefinedFunction(
      'navigate',
      'Navigates directly to a specified URL.',
      z.object({url: z.string().describe('The URL to navigate to.')}),
      (computer, {url}) => computer.navigate(url),
    ),
    definePredefinedFunction(
      'key_combination',
      'Presses keyboard keys and combinations, such as "control+c" or' +
        ' "enter".',
      z.object({
        keys: z
          .array(z.string())
          .describe('List of keys to press in combination.'),
      }),
      (computer, {keys}) => computer.keyCombination(keys),
    ),
    definePredefinedFunction(
      'drag_and_drop',
      'Drag and drop an element from a x, y coordinate to a destination' +
        " destination_y, destination_x coordinate. The 'x', 'y'," +
        " 'destination_y' and 'destination_x' values are absolute values," +
        ' scaled to the height and width of the screen.',
      z.object({
        x: X_COORDINATE.describe('The x-coordinate to start dragging from.'),
        y: Y_COORDINATE.describe('The y-coordinate to start dragging from.'),
        destination_x: X_COORDINATE.describe('The x-coordinate to drop at.'),
        destination_y: Y_COORDINATE.describe('The y-coordinate to drop at.'),
      }),
      (computer, {x, y, destination_x, destination_y}) =>
        computer.dragAndDrop(x, y, destination_x, destination_y),
    ),
    definePredefinedFunction(
      'current_state',
      'Returns the current state of the current webpage.',
      NO_ARGUMENTS,
      (computer) => computer.currentState(),
    ),
  ];

/** The wire name of the action the URL safety guard applies to. */
export const NAVIGATE_FUNCTION_NAME = 'navigate';
