/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {experimental} from '../../utils/experimental.js';

/** The environments a {@link BaseComputer} can drive. */
export enum ComputerEnvironment {
  /** Defaults to browser. */
  ENVIRONMENT_UNSPECIFIED = 'ENVIRONMENT_UNSPECIFIED',
  /** Operates in a web browser. */
  ENVIRONMENT_BROWSER = 'ENVIRONMENT_BROWSER',
}

/** The direction of a scroll action. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * The state of the computer environment after an action.
 *
 * Both fields are optional: an implementation that cannot take a screenshot,
 * or that drives an environment without a URL, omits them.
 */
export interface ComputerState {
  /** The screenshot of the current screen, PNG-encoded. */
  screenshot?: Uint8Array;
  /** The current URL of the webpage being displayed. */
  url?: string;
}

/**
 * The interface an agent uses to drive a computer environment.
 *
 * An implementation supplies the screen size, the environment kind, and the
 * fourteen actions below. The three lifecycle hooks ({@link prepare},
 * {@link initialize} and {@link close}) default to no-ops, so an implementation
 * overrides only the ones it needs.
 *
 * Coordinates are absolute pixel values, already scaled to the height and width
 * of the screen. An implementation never rescales them.
 */
@experimental
export abstract class BaseComputer {
  /**
   * Prepares resources before each tool invocation.
   *
   * Override this to set up session-level resources, such as a sandbox or a
   * token, using `context.state` for persistence across invocations.
   *
   * @param _context The tool context, which gives access to session state.
   */
  async prepare(_context: Context): Promise<void> {}

  /** Initializes the computer. */
  async initialize(): Promise<void> {}

  /** Releases the resources held by the computer. */
  async close(): Promise<void> {}

  /**
   * Returns the screen size of the environment.
   *
   * @returns The width and height, in pixels.
   */
  abstract screenSize(): Promise<[number, number]>;

  /** Returns the environment the computer operates in. */
  abstract environment(): Promise<ComputerEnvironment>;

  /**
   * Opens the web browser.
   *
   * @returns The state after opening the browser.
   */
  abstract openWebBrowser(): Promise<ComputerState>;

  /**
   * Clicks at a specific coordinate on the webpage.
   *
   * @param params.x The x-coordinate to click at.
   * @param params.y The y-coordinate to click at.
   * @returns The state after clicking.
   */
  abstract clickAt(params: {x: number; y: number}): Promise<ComputerState>;

  /**
   * Hovers at a specific coordinate on the webpage.
   *
   * Use this to explore sub-menus that appear on hover.
   *
   * @param params.x The x-coordinate to hover at.
   * @param params.y The y-coordinate to hover at.
   * @returns The state after hovering.
   */
  abstract hoverAt(params: {x: number; y: number}): Promise<ComputerState>;

  /**
   * Types text at a specific coordinate.
   *
   * `pressEnter` and `clearBeforeTyping` are part of the contract an
   * implementation accepts: when either is omitted it means `true`, so an
   * implementation presses ENTER after typing and clears the existing content
   * before typing unless the caller passes `false`.
   *
   * @param params.x The x-coordinate to type at.
   * @param params.y The y-coordinate to type at.
   * @param params.text The text to type.
   * @param params.pressEnter Whether to press ENTER after typing. Omitted means
   *   `true`.
   * @param params.clearBeforeTyping Whether to clear the existing content
   *   before typing. Omitted means `true`.
   * @returns The state after typing.
   */
  abstract typeTextAt(params: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState>;

  /**
   * Scrolls the entire webpage in the given direction.
   *
   * @param params.direction The direction to scroll.
   * @returns The state after scrolling.
   */
  abstract scrollDocument(params: {
    direction: ScrollDirection;
  }): Promise<ComputerState>;

  /**
   * Scrolls at a specific coordinate by a magnitude.
   *
   * @param params.x The x-coordinate to scroll at.
   * @param params.y The y-coordinate to scroll at.
   * @param params.direction The direction to scroll.
   * @param params.magnitude The amount to scroll.
   * @returns The state after scrolling.
   */
  abstract scrollAt(params: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState>;

  /**
   * Waits for n seconds, to let unfinished webpage processes complete.
   *
   * @param params.seconds The number of seconds to wait.
   * @returns The state after waiting.
   */
  abstract wait(params: {seconds: number}): Promise<ComputerState>;

  /**
   * Navigates back to the previous webpage in the browser history.
   *
   * @returns The state after navigating back.
   */
  abstract goBack(): Promise<ComputerState>;

  /**
   * Navigates forward to the next webpage in the browser history.
   *
   * @returns The state after navigating forward.
   */
  abstract goForward(): Promise<ComputerState>;

  /**
   * Jumps directly to the home page of a search engine.
   *
   * Use this when a task must start with a search, because the current website
   * does not have the information needed or because a new task is starting.
   *
   * @returns The state after navigating to the search engine.
   */
  abstract search(): Promise<ComputerState>;

  /**
   * Navigates directly to a URL.
   *
   * @param params.url The URL to navigate to.
   * @returns The state after navigation.
   */
  abstract navigate(params: {url: string}): Promise<ComputerState>;

  /**
   * Presses a keyboard key or a combination, such as "control+c" or "enter".
   *
   * @param params.keys The keys to press in combination.
   * @returns The state after the key press.
   */
  abstract keyCombination(params: {keys: string[]}): Promise<ComputerState>;

  /**
   * Drags an element from a coordinate and drops it at a destination.
   *
   * @param params.x The x-coordinate to start dragging from.
   * @param params.y The y-coordinate to start dragging from.
   * @param params.destinationX The x-coordinate to drop at.
   * @param params.destinationY The y-coordinate to drop at.
   * @returns The state after the drag and drop.
   */
  abstract dragAndDrop(params: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState>;

  /**
   * Returns the state of the current webpage.
   *
   * @returns The current environment state.
   */
  abstract currentState(): Promise<ComputerState>;
}
