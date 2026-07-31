/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Environment} from '@google/genai';

import {Context} from '../../agents/context.js';
import {experimental} from '../../utils/experimental.js';

/**
 * The direction of a scroll action.
 */
export type ComputerScrollDirection = 'up' | 'down' | 'left' | 'right';

export interface ComputerState {
  screenshot?: Uint8Array;
  url?: string;
}

/** Every key a {@link ComputerState} is allowed to carry. */
const COMPUTER_STATE_KEYS: ReadonlySet<string> = new Set(['screenshot', 'url']);

/**
 * Whether a value is a {@link ComputerState}.
 *
 * The check is exact: the keys must be a non-empty subset of `screenshot` and
 * `url`, and each present key must hold the declared type. A value carrying
 * any other key is an ordinary tool result, so {@link ComputerUseTool} returns
 * it to the model untouched rather than reinterpreting it as a screenshot.
 *
 * `ArrayBuffer.isView` rather than `instanceof Uint8Array`, so a state built
 * by a second copy of this package in the same runtime is still recognized.
 */
export function isComputerState(value: unknown): value is ComputerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const keys = Object.keys(value);
  if (keys.length === 0 || !keys.every((key) => COMPUTER_STATE_KEYS.has(key))) {
    return false;
  }
  const screenshot = 'screenshot' in value ? value.screenshot : undefined;
  const url = 'url' in value ? value.url : undefined;
  return (
    (screenshot === undefined || ArrayBuffer.isView(screenshot)) &&
    (url === undefined || typeof url === 'string')
  );
}

export interface ComputerClickArgs {
  x: number;
  y: number;
}
export interface ComputerTypeArgs {
  x: number;
  y: number;
  text: string;
  press_enter?: boolean;
  clear_before_typing?: boolean;
}
export interface ComputerScrollDocumentArgs {
  direction: ComputerScrollDirection;
}
export interface ComputerScrollAtArgs {
  x: number;
  y: number;
  direction: ComputerScrollDirection;
  magnitude: number;
}
export interface ComputerWaitArgs {
  seconds: number;
}
export interface ComputerNavigateArgs {
  url: string;
}
export interface ComputerKeyArgs {
  keys: string[];
}
export interface ComputerDragArgs {
  x: number;
  y: number;
  destination_x: number;
  destination_y: number;
}

@experimental
export abstract class BaseComputer {
  /**
   * Called before each tool invocation to prepare resources.
   *
   * Override this to set up session-level resources (sandbox, tokens, etc.)
   * using toolContext.state for persistence across invocations.
   *
   * @param _toolContext The tool context with session state access.
   */
  async prepare(_toolContext: Context): Promise<void> {}

  /**
   * Returns the screen size of the environment.
   *
   * @returns A tuple of (width, height) in pixels.
   */
  abstract screenSize(): Promise<[number, number]>;

  /**
   * Opens the web browser.
   *
   * @returns The current state after opening the browser.
   */
  abstract openWebBrowser(): Promise<ComputerState>;

  /**
   * Clicks at a specific x, y coordinate on the webpage.
   *
   * @returns The current state after clicking.
   */
  abstract clickAt(args: ComputerClickArgs): Promise<ComputerState>;

  /**
   * Hovers at a specific x, y coordinate on the webpage.
   *
   * @returns The current state after hovering.
   */
  abstract hoverAt(args: ComputerClickArgs): Promise<ComputerState>;

  /**
   * Types text at a specific x, y coordinate.
   *
   * @returns The current state after typing.
   */
  abstract typeTextAt(args: ComputerTypeArgs): Promise<ComputerState>;

  /**
   * Scrolls the entire webpage "up", "down", "left" or "right".
   *
   * @returns The current state after scrolling.
   */
  abstract scrollDocument(
    args: ComputerScrollDocumentArgs,
  ): Promise<ComputerState>;

  /**
   * Scrolls up, down, right, or left at a x, y coordinate.
   *
   * @returns The current state after scrolling.
   */
  abstract scrollAt(args: ComputerScrollAtArgs): Promise<ComputerState>;

  /**
   * Waits for n seconds.
   *
   * @returns The current state after waiting.
   */
  abstract wait(args: ComputerWaitArgs): Promise<ComputerState>;

  /**
   * Navigates back.
   *
   * @returns The current state.
   */
  abstract goBack(): Promise<ComputerState>;

  /**
   * Navigates forward.
   *
   * @returns The current state.
   */
  abstract goForward(): Promise<ComputerState>;

  /**
   * Directly jumps to search.
   *
   * @returns The current state.
   */
  abstract search(): Promise<ComputerState>;

  /**
   * Navigates directly to a URL.
   *
   * @returns The current state.
   */
  abstract navigate(args: ComputerNavigateArgs): Promise<ComputerState>;

  /**
   * Presses keyboard keys.
   *
   * @returns The current state.
   */
  abstract keyCombination(args: ComputerKeyArgs): Promise<ComputerState>;

  /**
   * Drag and drop an element.
   *
   * @returns The current state.
   */
  abstract dragAndDrop(args: ComputerDragArgs): Promise<ComputerState>;

  /**
   * Returns the current state of the current webpage.
   *
   * @returns The current environment state.
   */
  abstract currentState(): Promise<ComputerState>;

  /**
   * Initialize the computer.
   */
  async initialize(): Promise<void> {}

  /**
   * Cleanup resource of the computer.
   */
  async close(): Promise<void> {}

  /**
   * Returns the environment of the computer.
   */
  abstract environment(): Promise<Environment>;
}

/**
 * The names of the predefined computer-use actions declared by
 * {@link BaseComputer}, i.e. every member except the lifecycle hooks, which
 * are part of the toolset contract rather than the model-facing action space.
 *
 * `ComputerUseToolset` keys its action table by this type, so adding an
 * abstract action to `BaseComputer` is a compile error until the toolset knows
 * how to invoke it.
 */
export type ComputerActionName = Exclude<
  keyof BaseComputer,
  'prepare' | 'initialize' | 'close' | 'screenSize' | 'environment'
>;
