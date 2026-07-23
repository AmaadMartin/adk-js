/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
/* eslint-disable @typescript-eslint/no-unused-vars */

import {Context} from '../../agents/context.js';
import {experimental} from '../../utils/experimental.js';

export enum ComputerEnvironment {
  ENVIRONMENT_UNSPECIFIED = 'ENVIRONMENT_UNSPECIFIED',
  ENVIRONMENT_BROWSER = 'ENVIRONMENT_BROWSER',
}

export interface ComputerState {
  screenshot?: Uint8Array;
  url?: string;
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
  direction: 'up' | 'down' | 'left' | 'right';
}
export interface ComputerScrollAtArgs {
  x: number;
  y: number;
  direction: 'up' | 'down' | 'left' | 'right';
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
   * @param toolContext The tool context with session state access.
   */
  async prepare(toolContext: Context): Promise<void> {}

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
  abstract openWebBrowser(args?: Record<string, any>): Promise<ComputerState>;

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
  abstract goBack(args?: Record<string, any>): Promise<ComputerState>;

  /**
   * Navigates forward.
   *
   * @returns The current state.
   */
  abstract goForward(args?: Record<string, any>): Promise<ComputerState>;

  /**
   * Directly jumps to search.
   *
   * @returns The current state.
   */
  abstract search(args?: Record<string, any>): Promise<ComputerState>;

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
  abstract currentState(args?: Record<string, any>): Promise<ComputerState>;

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
  abstract environment(): Promise<ComputerEnvironment>;
}
