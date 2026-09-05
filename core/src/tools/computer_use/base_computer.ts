/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Context} from '../../agents/context.js';
import {experimental} from '../../utils/experimental.js';

/** The environment a {@link BaseComputer} drives. */
export enum ComputerEnvironment {
  /** Defaults to a browser. */
  ENVIRONMENT_UNSPECIFIED = 'ENVIRONMENT_UNSPECIFIED',
  /** Operates in a web browser. */
  ENVIRONMENT_BROWSER = 'ENVIRONMENT_BROWSER',
}

/** The direction a scroll action moves the page in. */
export type ScrollDirection = 'up' | 'down' | 'left' | 'right';

/** The state of the computer after an action. */
export interface ComputerState {
  /** The screenshot, in PNG format. */
  screenshot?: Uint8Array;
  /** The url of the page currently displayed. */
  url?: string;
}

/** The keys a {@link ComputerState} may carry. */
const COMPUTER_STATE_KEYS: ReadonlySet<string> = new Set(['screenshot', 'url']);

/**
 * Whether `value` is a {@link ComputerState}.
 *
 * The match is exact: an object carrying any other key is not a state. That is
 * load-bearing rather than pedantic. A refused `navigate` returns
 * `{error, url}`, and a looser check would read that as a state and rewrite it
 * into a screenshot payload, dropping the error the model needs to see.
 *
 * @param value The value to check.
 * @return Whether the value is a computer state.
 */
export function isComputerState(value: unknown): value is ComputerState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const state = value as ComputerState;
  if (
    state.screenshot !== undefined &&
    !(state.screenshot instanceof Uint8Array)
  ) {
    return false;
  }
  if (state.url !== undefined && typeof state.url !== 'string') {
    return false;
  }
  return Object.keys(state).every((key) => COMPUTER_STATE_KEYS.has(key));
}

/**
 * The interface a computer-use agent drives.
 *
 * Implement it over a real browser (Playwright, Puppeteer, a remote sandbox)
 * and hand the implementation to a `ComputerUseToolset`. Every action returns
 * the state the computer reached, which the toolset turns into the screenshot
 * the model sees next.
 *
 * Coordinates arrive already scaled to {@link screenSize}: the model works in
 * a virtual 1000x1000 space and the toolset normalizes before calling here.
 */
@experimental
export abstract class BaseComputer {
  /**
   * Prepares the computer before each action.
   *
   * Override it to bind session-scoped resources — a sandbox handle, a token —
   * from `context.state`, so the driver stays decoupled from the tool context.
   *
   * @param _context The context of the action about to run.
   */
  async prepare(_context: Context): Promise<void> {}

  /** Initializes the computer. Called once, before the first action. */
  async initialize(): Promise<void> {}

  /** Releases the resources the computer holds. */
  async close(): Promise<void> {}

  /** The screen size as `[width, height]` in pixels. */
  abstract screenSize(): Promise<[number, number]>;

  /** The environment this computer operates in. */
  abstract environment(): Promise<ComputerEnvironment>;

  /** Opens the web browser. */
  abstract openWebBrowser(): Promise<ComputerState>;

  /** Clicks at a coordinate on the page. */
  abstract clickAt(args: {x: number; y: number}): Promise<ComputerState>;

  /** Hovers at a coordinate on the page, e.g. to open a sub-menu. */
  abstract hoverAt(args: {x: number; y: number}): Promise<ComputerState>;

  /** Types text at a coordinate on the page. */
  abstract typeTextAt(args: {
    x: number;
    y: number;
    text: string;
    /** Whether to press ENTER after typing. */
    pressEnter?: boolean;
    /** Whether to clear the existing content before typing. */
    clearBeforeTyping?: boolean;
  }): Promise<ComputerState>;

  /** Scrolls the whole page in a direction. */
  abstract scrollDocument(args: {
    direction: ScrollDirection;
  }): Promise<ComputerState>;

  /** Scrolls at a coordinate on the page, by a magnitude. */
  abstract scrollAt(args: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<ComputerState>;

  /** Waits for unfinished page processes to complete. */
  abstract wait(args: {seconds: number}): Promise<ComputerState>;

  /** Navigates back in the browser history. */
  abstract goBack(): Promise<ComputerState>;

  /** Navigates forward in the browser history. */
  abstract goForward(): Promise<ComputerState>;

  /** Jumps to the home page of a search engine. */
  abstract search(): Promise<ComputerState>;

  /** Navigates to a url. */
  abstract navigate(args: {url: string}): Promise<ComputerState>;

  /** Presses a key combination, such as `['control', 'c']`. */
  abstract keyCombination(args: {keys: string[]}): Promise<ComputerState>;

  /** Drags an element from one coordinate to another. */
  abstract dragAndDrop(args: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<ComputerState>;

  /** The state of the page as it is now. */
  abstract currentState(): Promise<ComputerState>;
}
