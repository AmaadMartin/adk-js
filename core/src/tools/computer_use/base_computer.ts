/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {types} from 'node:util';

import {Context} from '../../agents/context.js';
import {experimental} from '../../utils/experimental.js';

/** The environment a {@link BaseComputer} drives. */
export enum ComputerEnvironment {
  /** Defaults to browser. */
  ENVIRONMENT_UNSPECIFIED = 'ENVIRONMENT_UNSPECIFIED',
  /** Operates in a web browser. */
  ENVIRONMENT_BROWSER = 'ENVIRONMENT_BROWSER',
}

/** The direction a scroll action moves the page in. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** The size of a screen, in pixels. */
export interface ScreenSize {
  width: number;
  height: number;
}

/** The state of the computer environment after an action. */
export interface ComputerState {
  /** The screenshot of the current page, PNG encoded. */
  screenshot: Uint8Array;
  /** The URL of the page currently displayed. */
  url?: string;
}

/**
 * Whether `value` is a {@link ComputerState}, so that a computer method's
 * return value can be told apart from an already-formatted tool response.
 */
export function isComputerState(value: unknown): value is ComputerState {
  if (typeof value !== 'object' || value === null || !('screenshot' in value)) {
    return false;
  }
  if (!types.isUint8Array(value.screenshot)) {
    return false;
  }
  if (!('url' in value)) {
    return true;
  }
  return value.url === undefined || typeof value.url === 'string';
}

/**
 * The interface a computer environment implements so that
 * {@link ComputerUseToolset} can expose it to a model.
 *
 * Implement one method per action the model may take. The toolset drives the
 * lifecycle: it calls {@link initialize} once, {@link prepare} before every
 * action, and {@link close} when the toolset closes.
 */
@experimental
export abstract class BaseComputer {
  /**
   * Prepares per-invocation resources before each action.
   *
   * Override this to set up session-level resources (a sandbox, a token, ...)
   * from the state of the tool call about to run, so they survive across
   * invocations. The default does nothing.
   */
  async prepare(_toolContext: Context): Promise<void> {}

  /** Returns the size of the screen, in pixels. */
  abstract screenSize(): Promise<ScreenSize>;

  /** Opens the web browser. */
  abstract openWebBrowser(): Promise<ComputerState>;

  /**
   * Clicks at a coordinate on the page.
   *
   * @param x The x coordinate to click at.
   * @param y The y coordinate to click at.
   */
  abstract clickAt(x: number, y: number): Promise<ComputerState>;

  /**
   * Hovers at a coordinate on the page.
   *
   * @param x The x coordinate to hover at.
   * @param y The y coordinate to hover at.
   */
  abstract hoverAt(x: number, y: number): Promise<ComputerState>;

  /**
   * Types text at a coordinate on the page.
   *
   * @param x The x coordinate to type at.
   * @param y The y coordinate to type at.
   * @param text The text to type.
   * @param pressEnter Whether to press ENTER after typing.
   * @param clearBeforeTyping Whether to clear the existing content first.
   */
  abstract typeTextAt(
    x: number,
    y: number,
    text: string,
    pressEnter?: boolean,
    clearBeforeTyping?: boolean,
  ): Promise<ComputerState>;

  /**
   * Scrolls the whole page.
   *
   * @param direction The direction to scroll in.
   */
  abstract scrollDocument(direction: ScrollDirection): Promise<ComputerState>;

  /**
   * Scrolls at a coordinate on the page.
   *
   * @param x The x coordinate to scroll at.
   * @param y The y coordinate to scroll at.
   * @param direction The direction to scroll in.
   * @param magnitude The amount to scroll.
   */
  abstract scrollAt(
    x: number,
    y: number,
    direction: ScrollDirection,
    magnitude: number,
  ): Promise<ComputerState>;

  /**
   * Waits for unfinished page processes to complete.
   *
   * @param seconds The number of seconds to wait.
   */
  abstract wait(seconds: number): Promise<ComputerState>;

  /** Navigates back to the previous page in the browser history. */
  abstract goBack(): Promise<ComputerState>;

  /** Navigates forward to the next page in the browser history. */
  abstract goForward(): Promise<ComputerState>;

  /** Jumps to the home page of a search engine. */
  abstract search(): Promise<ComputerState>;

  /**
   * Navigates to a URL.
   *
   * @param url The URL to navigate to.
   */
  abstract navigate(url: string): Promise<ComputerState>;

  /**
   * Presses a keyboard combination, such as `control+c`.
   *
   * @param keys The keys to press together.
   */
  abstract keyCombination(keys: string[]): Promise<ComputerState>;

  /**
   * Drags an element from one coordinate to another.
   *
   * @param x The x coordinate to start dragging from.
   * @param y The y coordinate to start dragging from.
   * @param destinationX The x coordinate to drop at.
   * @param destinationY The y coordinate to drop at.
   */
  abstract dragAndDrop(
    x: number,
    y: number,
    destinationX: number,
    destinationY: number,
  ): Promise<ComputerState>;

  /** Returns the state of the current page. */
  abstract currentState(): Promise<ComputerState>;

  /** Initializes the computer. The default does nothing. */
  async initialize(): Promise<void> {}

  /** Releases the computer's resources. The default does nothing. */
  async close(): Promise<void> {}

  /** Returns the environment this computer drives. */
  abstract environment(): Promise<ComputerEnvironment>;
}
