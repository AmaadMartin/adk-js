/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {experimental} from '../../utils/experimental.js';

/** The kind of environment a {@link BaseComputer} controls. */
export enum ComputerEnvironment {
  /** Defaults to browser. */
  ENVIRONMENT_UNSPECIFIED = 'ENVIRONMENT_UNSPECIFIED',
  /** Operates in a web browser. */
  ENVIRONMENT_BROWSER = 'ENVIRONMENT_BROWSER',
}

/** The direction a scroll action moves the content. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/**
 * The state of the computer environment after an action.
 *
 * Both properties are optional: an implementation that cannot produce a
 * screenshot, or that controls a non-browser environment with no URL, omits
 * the property it has no value for.
 */
export interface ComputerState {
  /** The screenshot of the current screen, in PNG format. */
  screenshot?: Uint8Array;
  /** The current URL of the webpage being displayed. */
  url?: string;
}

/**
 * Abstract base class for computer environments.
 *
 * A computer exposes a fixed set of actions — click, type, scroll, navigate —
 * that drive an interactive system such as a web browser. A toolset turns each
 * action into a tool the model can call, so the action set here is the contract
 * between the model and the backend that runs it. Concrete implementations
 * include browser drivers, sandboxed virtual machines and remote desktops.
 *
 * Every `x`, `y`, `destinationX` and `destinationY` value is an absolute pixel
 * coordinate, already scaled to the width and height of the screen. An
 * implementation uses these values as they arrive and never rescales them.
 *
 * Lifecycle:
 * 1. Construct the computer.
 * 2. Call {@link initialize} before first use.
 * 3. Call {@link prepare} before each tool invocation.
 * 4. Call the actions.
 * 5. Call {@link close} when done.
 *
 * {@link prepare}, {@link initialize} and {@link close} default to no-ops, so a
 * subclass overrides only the ones it needs.
 */
@experimental
export abstract class BaseComputer {
  /**
   * Prepares resources before each tool invocation.
   *
   * Override this to set up session-level resources, such as a sandbox or an
   * access token, using `context.state` for persistence across invocations.
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
   * @returns The width and height in pixels, as `[width, height]`.
   */
  abstract screenSize(): Promise<[number, number]>;

  /** Returns the environment of the computer. */
  abstract environment(): Promise<ComputerEnvironment>;

  /**
   * Opens the web browser.
   *
   * @returns The state after opening the browser.
   */
  abstract openWebBrowser(): Promise<ComputerState>;

  /**
   * Clicks at a coordinate on the webpage.
   *
   * @param params.x The x-coordinate to click at.
   * @param params.y The y-coordinate to click at.
   * @returns The state after clicking.
   */
  abstract clickAt(params: {x: number; y: number}): Promise<ComputerState>;

  /**
   * Hovers at a coordinate on the webpage.
   *
   * Use this to explore sub-menus that appear on hover.
   *
   * @param params.x The x-coordinate to hover at.
   * @param params.y The y-coordinate to hover at.
   * @returns The state after hovering.
   */
  abstract hoverAt(params: {x: number; y: number}): Promise<ComputerState>;

  /**
   * Types text at a coordinate on the webpage.
   *
   * @param params.x The x-coordinate to type at.
   * @param params.y The y-coordinate to type at.
   * @param params.text The text to type.
   * @param params.pressEnter Whether to press ENTER after typing. An omitted
   *   value means `true`.
   * @param params.clearBeforeTyping Whether to clear the existing content
   *   before typing. An omitted value means `true`.
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
   * Scrolls the entire webpage in a direction.
   *
   * @param params.direction The direction to scroll.
   * @returns The state after scrolling.
   */
  abstract scrollDocument(params: {
    direction: ScrollDirection;
  }): Promise<ComputerState>;

  /**
   * Scrolls at a coordinate on the webpage.
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
   * Use this when the current website does not have the information you need,
   * or when you start a new task.
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
   * Presses keyboard keys and combinations, such as `control+c` or `enter`.
   *
   * @param params.keys The keys to press in combination.
   * @returns The state after the key press.
   */
  abstract keyCombination(params: {keys: string[]}): Promise<ComputerState>;

  /**
   * Drags an element from one coordinate to another.
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

  /** Returns the current state of the current webpage. */
  abstract currentState(): Promise<ComputerState>;
}
