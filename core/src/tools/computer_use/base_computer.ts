/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {experimental} from '../../utils/experimental.js';

/** The environment a {@link BaseComputer} drives. */
export enum ComputerEnvironment {
  /** Defaults to browser. */
  ENVIRONMENT_UNSPECIFIED = 'ENVIRONMENT_UNSPECIFIED',
  /** Operates in a web browser. */
  ENVIRONMENT_BROWSER = 'ENVIRONMENT_BROWSER',
}

/** The direction a scroll action moves the page. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** The state of the computer environment after an action. */
export interface ComputerState {
  /** The screenshot, PNG-encoded. */
  screenshot?: Uint8Array;
  /** The current url of the page being displayed. */
  url?: string;
}

/** The only keys a {@link ComputerState} may carry. */
const COMPUTER_STATE_KEYS: ReadonlySet<string> = new Set(['screenshot', 'url']);

/**
 * Type guard for {@link ComputerState}.
 *
 * Structural rather than `instanceof`, so it stays correct when the value
 * crosses a package boundary — two copies of adk-js in one runtime would fail
 * an `instanceof` check between them.
 *
 * The match is exact: an object carrying any other key is not a state. Python
 * gets this from `isinstance`, and a tool result relies on it — `navigate`
 * refuses a url with `{error, url}`, which a looser guard would read as a
 * state and rewrite into a screenshot payload, dropping the error.
 */
export function isComputerState(value: unknown): value is ComputerState {
  if (typeof value !== 'object' || value === null) {
    return false;
  }
  if (!Object.keys(value).every((key) => COMPUTER_STATE_KEYS.has(key))) {
    return false;
  }
  const {screenshot, url} = value as ComputerState;
  if (screenshot !== undefined && !ArrayBuffer.isView(screenshot)) {
    return false;
  }
  return url === undefined || typeof url === 'string';
}

/**
 * The interface a user implements to let an agent drive a computer.
 *
 * Each abstract method below is one predefined Gemini computer-use function.
 * `ComputerUseToolset` exposes them to the model and normalizes the
 * coordinates the model produces onto the real screen, so an implementation
 * always receives absolute pixel coordinates.
 */
@experimental
export abstract class BaseComputer {
  /**
   * Called before each tool invocation to prepare resources.
   *
   * Override this to set up session-level resources (a sandbox, tokens) using
   * `context.state` for persistence across invocations.
   */
  async prepare(_context: Context): Promise<void> {}

  /** Initializes the computer. Called once, before the first action. */
  async initialize(): Promise<void> {}

  /** Releases the computer's resources. */
  async close(): Promise<void> {}

  /** Returns the screen size as `[width, height]` in pixels. */
  abstract screenSize(): Promise<[number, number]>;

  /** Returns the environment this computer operates in. */
  abstract environment(): Promise<ComputerEnvironment>;

  /** Opens the web browser. */
  abstract openWebBrowser(): Promise<ComputerState>;

  /**
   * Clicks at a specific x, y coordinate on the webpage.
   *
   * The 'x' and 'y' values are absolute values, scaled to the height and width
   * of the screen.
   */
  abstract clickAt(params: {x: number; y: number}): Promise<ComputerState>;

  /**
   * Hovers at a specific x, y coordinate on the webpage.
   *
   * May be used to explore sub-menus that appear on hover. The 'x' and 'y'
   * values are absolute values, scaled to the height and width of the screen.
   */
  abstract hoverAt(params: {x: number; y: number}): Promise<ComputerState>;

  /**
   * Types text at a specific x, y coordinate.
   *
   * The system automatically presses ENTER after typing. To disable this, set
   * `pressEnter` to false. The system automatically clears any existing content
   * before typing the specified `text`. To disable this, set
   * `clearBeforeTyping` to false. The 'x' and 'y' values are absolute values,
   * scaled to the height and width of the screen.
   */
  abstract typeTextAt(params: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState>;

  /** Scrolls the entire webpage up, down, left or right. */
  abstract scrollDocument(params: {
    direction: ScrollDirection;
  }): Promise<ComputerState>;

  /**
   * Scrolls up, down, right, or left at an x, y coordinate by magnitude.
   *
   * The 'x' and 'y' values are absolute values, scaled to the height and width
   * of the screen.
   */
  abstract scrollAt(params: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState>;

  /** Waits n seconds to let unfinished webpage processes complete. */
  abstract wait(params: {seconds: number}): Promise<ComputerState>;

  /** Navigates back to the previous webpage in the browser history. */
  abstract goBack(): Promise<ComputerState>;

  /** Navigates forward to the next webpage in the browser history. */
  abstract goForward(): Promise<ComputerState>;

  /**
   * Directly jumps to a search engine home page.
   *
   * Used when you need to start with a search. For example, when the current
   * website does not have the information needed, or because a new task is
   * being started.
   */
  abstract search(): Promise<ComputerState>;

  /** Navigates directly to a specified url. */
  abstract navigate(params: {url: string}): Promise<ComputerState>;

  /** Presses keyboard keys and combinations, such as "control+c" or "enter". */
  abstract keyCombination(params: {keys: string[]}): Promise<ComputerState>;

  /**
   * Drags an element from an x, y coordinate to a destination coordinate.
   *
   * The 'x', 'y', 'destinationX' and 'destinationY' values are absolute values,
   * scaled to the height and width of the screen.
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

/**
 * The {@link BaseComputer} methods that are exposed to the model as actions.
 *
 * The lifecycle and introspection methods are excluded. Deriving this from the
 * class rather than listing it by hand means an action added to
 * `BaseComputer` fails to compile until the action table names it.
 */
export type ComputerActionName = Exclude<
  keyof BaseComputer,
  'prepare' | 'initialize' | 'close' | 'screenSize' | 'environment'
>;
