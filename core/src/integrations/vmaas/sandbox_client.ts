/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The low-level client for a Vertex AI Computer Use Sandbox.
 *
 * It turns a browser action into Chrome DevTools Protocol (CDP) commands and
 * sends them to the sandbox over the transport its caller supplies.
 */

import {SandboxEnvironment} from '@google-cloud/vertexai/build/src/genai/types.js';

import {ScrollDirection} from '../../tools/computer_use/base_computer.js';
import {formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {sleep} from '../../utils/time_utils.js';
import {SandboxError, SandboxErrorCode} from './sandbox_errors.js';

const CDP_PAGE_CAPTURE_SCREENSHOT = 'Page.captureScreenshot';
const CDP_INPUT_DISPATCH_MOUSE_EVENT = 'Input.dispatchMouseEvent';
const CDP_INPUT_DISPATCH_KEY_EVENT = 'Input.dispatchKeyEvent';
const CDP_INPUT_INSERT_TEXT = 'Input.insertText';
const CDP_PAGE_GET_NAVIGATION_HISTORY = 'Page.getNavigationHistory';
const CDP_PAGE_NAVIGATE_TO_HISTORY_ENTRY = 'Page.navigateToHistoryEntry';
const CDP_PAGE_NAVIGATE = 'Page.navigate';

/** The sandbox path that runs one CDP command. */
const PATH_CDP = 'cdp';
/** The sandbox path that runs a batch of CDP commands. */
const PATH_CDP_BATCH = 'cdps';
/** The sandbox path that lists the browser tabs. */
const PATH_TABS = 'tabs';
/** The sandbox path that reports whether the sandbox is healthy. */
const PATH_HEALTH = '';

/** Windows virtual key codes for the keys this client synthesises. */
const KEY_CODE_A = 65;
const KEY_CODE_DELETE = 46;
const KEY_CODE_ENTER = 13;

/** How often a read is attempted while the page navigates under it. */
const DEFAULT_MAX_ATTEMPTS = 3;
/** How long to let the page settle between those attempts. */
const RETRY_DELAY_MS = 500;

/** The failures a page raises while it is navigating. */
const NAVIGATION_ERROR_FRAGMENTS = ['context was destroyed', 'navigation'];

/**
 * The key value CDP expects for each key name a caller may use.
 *
 * These are wire values shared with adk-python's `_META_KEY_MAP`.
 */
const META_KEY_MAP: Readonly<Record<string, string>> = {
  BACKSPACE: 'BackSpace',
  TAB: 'Tab',
  RETURN: 'Enter',
  ENTER: 'Enter',
  SHIFT: 'Shift_L',
  CONTROL: 'Control_L',
  ALT: 'Alt_L',
  ESCAPE: 'Escape',
  SPACE: 'space',
  PAGEUP: 'Page_Up',
  PAGE_UP: 'Page_Up',
  PAGEDOWN: 'Page_Down',
  PAGE_DOWN: 'Page_Down',
  END: 'End',
  HOME: 'Home',
  LEFT: 'Left',
  UP: 'Up',
  RIGHT: 'Right',
  DOWN: 'Down',
  INSERT: 'Insert',
  DELETE: 'Delete',
  SEMICOLON: 'semicolon',
  EQUALS: 'equal',
  MULTIPLY: 'asterisk',
  ADD: 'plus',
  SEPARATOR: 'KP_Separator',
  SUBTRACT: 'minus',
  DECIMAL: 'period',
  DIVIDE: 'slash',
  F1: 'F1',
  F2: 'F2',
  F3: 'F3',
  F4: 'F4',
  F5: 'F5',
  F6: 'F6',
  F7: 'F7',
  F8: 'F8',
  F9: 'F9',
  F10: 'F10',
  F11: 'F11',
  F12: 'F12',
  COMMAND: 'Super_L',
};

/**
 * The CDP modifier bitmask of each modifier key.
 *
 * These are wire values shared with adk-python's `_MODIFIER_MAP`.
 */
const MODIFIER_MAP: Readonly<Record<string, number>> = {
  CONTROL: 2,
  ALT: 1,
  SHIFT: 8,
  COMMAND: 4,
  SUPER: 4,
};

/** A JSON object carried in a sandbox request or response. */
export type SandboxJson = Record<string, unknown>;

/** One CDP command and the parameters it takes. */
export interface CdpCommand {
  command: string;
  params: SandboxJson;
}

/** What the sandbox reports for one command of a batch. */
export interface CdpBatchResult {
  /** `'success'` or `'error'`. */
  status?: string;
  /** The command response, when the command succeeded. */
  result?: SandboxJson;
  /** The failure message, when the command failed. */
  error?: string;
}

/**
 * Carries one request to a sandbox's HTTP surface.
 *
 * `@google-cloud/vertexai` exposes no sandbox `sendCommand` method, so the
 * caller supplies the transport.
 */
export type SandboxCommandSender = (params: {
  httpMethod: 'GET' | 'POST';
  path: string;
  accessToken: string;
  sandbox: SandboxEnvironment;
  requestBody?: SandboxJson;
}) => Promise<{body?: string} | undefined>;

/** Options for {@link SandboxClient}. */
export interface SandboxClientOptions {
  /** The sandbox the commands are sent to. */
  sandbox: SandboxEnvironment;
  /** The token that authenticates each request. */
  accessToken: string;
  /** The transport that carries a request to the sandbox. */
  sendCommand: SandboxCommandSender;
}

/** Narrows a value to a JSON object, or `undefined` when it is not one. */
function asJsonObject(value: unknown): SandboxJson | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as SandboxJson)
    : undefined;
}

/**
 * Decodes a sandbox response body.
 *
 * An absent or malformed body decodes to an empty object, which is what
 * adk-python's `_parse_response` returns.
 */
function parseResponseBody(response: {body?: string} | undefined): SandboxJson {
  if (!response?.body) {
    return {};
  }
  try {
    return asJsonObject(JSON.parse(response.body)) ?? {};
  } catch {
    return {};
  }
}

/** Reads one entry of a batch response. */
function toBatchResult(value: unknown): CdpBatchResult {
  const entry = asJsonObject(value) ?? {};
  return {
    status: typeof entry['status'] === 'string' ? entry['status'] : undefined,
    result: asJsonObject(entry['result']),
    error: typeof entry['error'] === 'string' ? entry['error'] : undefined,
  };
}

/** Whether a failure message names a page that is navigating. */
function isNavigationError(message: string): boolean {
  const lowered = message.toLowerCase();
  return NAVIGATION_ERROR_FRAGMENTS.some((fragment) =>
    lowered.includes(fragment),
  );
}

/**
 * Runs `read`, and runs it again while the page navigates under it.
 *
 * Any other failure, and a navigation failure on the last attempt, is thrown to
 * the caller.
 */
async function retryWhileNavigating<T>(
  read: () => Promise<T>,
  maxAttempts: number,
): Promise<T> {
  for (let attempt = 1; attempt < maxAttempts; attempt++) {
    try {
      return await read();
    } catch (e: unknown) {
      if (!isNavigationError(formatError(e))) {
        throw e;
      }
      logger.debug(
        `Retrying after a navigation error (attempt ${attempt} of ${maxAttempts}).`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
  // The last attempt is not retried, so it reports its own failure.
  return read();
}

/** A CDP command that dispatches a key event. */
function keyEvent(params: SandboxJson): CdpCommand {
  return {command: CDP_INPUT_DISPATCH_KEY_EVENT, params};
}

/** A CDP command that dispatches a mouse event. */
function mouseEvent(params: SandboxJson): CdpCommand {
  return {command: CDP_INPUT_DISPATCH_MOUSE_EVENT, params};
}

/** A CDP command that inserts text at the caret. */
function insertText(text: string): CdpCommand {
  return {command: CDP_INPUT_INSERT_TEXT, params: {text}};
}

/** The commands that press and release one key of the meta key map. */
function metaKeyCommands(cdpKey: string): CdpCommand[] {
  const key: SandboxJson =
    cdpKey === 'Enter'
      ? {key: cdpKey, windowsVirtualKeyCode: KEY_CODE_ENTER}
      : {key: cdpKey};
  return [
    keyEvent({type: 'keyDown', ...key}),
    keyEvent({type: 'keyUp', ...key}),
  ];
}

/** The commands that select the focused field's content and delete it. */
function clearFieldCommands(): CdpCommand[] {
  return [
    keyEvent({
      type: 'keyDown',
      modifiers: MODIFIER_MAP['CONTROL'],
      windowsVirtualKeyCode: KEY_CODE_A,
      key: 'A',
    }),
    keyEvent({type: 'keyUp', windowsVirtualKeyCode: KEY_CODE_A, key: 'A'}),
    keyEvent({
      type: 'keyDown',
      windowsVirtualKeyCode: KEY_CODE_DELETE,
      key: 'Delete',
    }),
    keyEvent({
      type: 'keyUp',
      windowsVirtualKeyCode: KEY_CODE_DELETE,
      key: 'Delete',
    }),
  ];
}

/** The commands that press and release Enter. */
function pressEnterCommands(): CdpCommand[] {
  return [
    keyEvent({
      type: 'keyDown',
      windowsVirtualKeyCode: KEY_CODE_ENTER,
      key: 'Enter',
    }),
    keyEvent({
      type: 'keyUp',
      windowsVirtualKeyCode: KEY_CODE_ENTER,
      key: 'Enter',
    }),
  ];
}

/** The commands that type one non-modifier key of a key combination. */
function combinationKeyCommands(key: string): CdpCommand[] {
  const upperKey = key.toUpperCase();
  if (upperKey in META_KEY_MAP) {
    return metaKeyCommands(META_KEY_MAP[upperKey]);
  }
  if (key.length === 1) {
    return [
      keyEvent({type: 'keyDown', text: key}),
      keyEvent({type: 'keyUp', text: key}),
    ];
  }
  return [insertText(key)];
}

/** The scroll deltas of a scroll in one direction. */
function scrollDeltas(
  direction: ScrollDirection,
  magnitude: number,
): {deltaX: number; deltaY: number} {
  const sign = direction === 'left' || direction === 'up' ? -1 : 1;
  const horizontal = direction === 'left' || direction === 'right';
  return {
    deltaX: horizontal ? sign * magnitude : 0,
    deltaY: horizontal ? 0 : sign * magnitude,
  };
}

/**
 * Drives the browser of a Vertex AI Computer Use Sandbox over CDP.
 *
 * One client holds one sandbox and one access token, and the computer builds a
 * new one for each action, so a refreshed token reaches the next action.
 */
@experimental
export class SandboxClient {
  private readonly sandbox: SandboxEnvironment;
  private readonly sendCommand: SandboxCommandSender;
  private readonly accessToken: string;

  constructor(options: SandboxClientOptions) {
    this.sandbox = options.sandbox;
    this.accessToken = options.accessToken;
    this.sendCommand = options.sendCommand;
  }

  /** Runs one CDP command and returns its response. */
  async makeCdpRequest(
    command: string,
    params: SandboxJson = {},
  ): Promise<SandboxJson> {
    return this.send({
      httpMethod: 'POST',
      path: PATH_CDP,
      requestBody: {command, params},
    });
  }

  /**
   * Runs several CDP commands.
   *
   * The batch path runs them in one request. A sandbox that does not serve that
   * path runs them one at a time instead, and `stopOnError` then decides
   * whether a failed command ends the sequence.
   */
  async makeCdpBatchRequest(
    commands: CdpCommand[],
    stopOnError = true,
  ): Promise<CdpBatchResult[]> {
    try {
      const response = await this.send({
        httpMethod: 'POST',
        path: PATH_CDP_BATCH,
        // The sandbox reads this field in snake_case.
        requestBody: {commands, stop_on_error: stopOnError},
      });
      const results = response['results'];
      return Array.isArray(results) ? results.map(toBatchResult) : [];
    } catch (e: unknown) {
      const message = formatError(e);
      if (
        message.includes('404') ||
        message.toLowerCase().includes('not found')
      ) {
        logger.debug('The sandbox serves no batch path, sending one by one.');
      } else {
        logger.warn(
          `The batch request failed, sending one by one instead: ${message}`,
        );
      }
    }
    return this.sendCommandsOneByOne(commands, stopOnError);
  }

  /** Captures the current page as PNG bytes. */
  async getScreenshot(maxAttempts = DEFAULT_MAX_ATTEMPTS): Promise<Uint8Array> {
    return retryWhileNavigating(async () => {
      const response = await this.makeCdpRequest(CDP_PAGE_CAPTURE_SCREENSHOT);
      const data = response['data'];
      if (typeof data !== 'string') {
        throw new SandboxError(
          SandboxErrorCode.SCREENSHOT_DATA_MISSING,
          `${CDP_PAGE_CAPTURE_SCREENSHOT} returned no image data.`,
        );
      }
      // Copied out of the Buffer so the caller receives a plain Uint8Array,
      // which is what ComputerState declares.
      return Uint8Array.from(Buffer.from(data, 'base64'));
    }, maxAttempts);
  }

  /** The URL of the active tab, or `undefined` when no tab is active. */
  async getCurrentUrl(
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
  ): Promise<string | undefined> {
    return retryWhileNavigating(async () => {
      const response = await this.send({httpMethod: 'GET', path: PATH_TABS});
      // The sandbox reports these two fields in snake_case.
      const activeTabId = response['active_tab_id'];
      const tabs = response['all_tabs'];
      if (activeTabId == null || !Array.isArray(tabs)) {
        return undefined;
      }
      const active = tabs
        .map(asJsonObject)
        .find((tab) => tab?.['id'] === activeTabId);
      return typeof active?.['url'] === 'string' ? active['url'] : undefined;
    }, maxAttempts);
  }

  /** Navigates the browser to `url`. */
  async navigate(url: string): Promise<SandboxJson> {
    return this.makeCdpRequest(CDP_PAGE_NAVIGATE, {url});
  }

  /** Clicks the left mouse button at a coordinate. */
  async clickAt(x: number, y: number): Promise<void> {
    await this.makeCdpBatchRequest([
      mouseEvent({type: 'mousePressed', button: 'left', x, y, clickCount: 1}),
      mouseEvent({type: 'mouseReleased', button: 'left', x, y, clickCount: 1}),
    ]);
  }

  /** Moves the mouse to a coordinate without clicking. */
  async hoverAt(x: number, y: number): Promise<void> {
    await this.makeCdpRequest(CDP_INPUT_DISPATCH_MOUSE_EVENT, {
      type: 'mouseMoved',
      x,
      y,
    });
  }

  /** Types text into the focused element. */
  async typeText(
    text: string,
    pressEnter = false,
    clearBeforeTyping = false,
  ): Promise<void> {
    const commands: CdpCommand[] = [];
    if (clearBeforeTyping) {
      commands.push(...clearFieldCommands());
    }
    if (text) {
      commands.push(insertText(text));
    }
    if (pressEnter) {
      commands.push(...pressEnterCommands());
    }
    if (commands.length > 0) {
      await this.makeCdpBatchRequest(commands);
    }
  }

  /** Clicks at a coordinate, then types text there. */
  async typeTextAt(params: {
    x: number;
    y: number;
    text: string;
    pressEnter?: boolean;
    clearBeforeTyping?: boolean;
  }): Promise<void> {
    await this.clickAt(params.x, params.y);
    await this.typeText(
      params.text,
      params.pressEnter,
      params.clearBeforeTyping,
    );
  }

  /** Scrolls at a coordinate by a pixel magnitude. */
  async scrollAt(params: {
    x: number;
    y: number;
    direction: ScrollDirection;
    magnitude: number;
  }): Promise<void> {
    const {deltaX, deltaY} = scrollDeltas(params.direction, params.magnitude);
    await this.makeCdpRequest(CDP_INPUT_DISPATCH_MOUSE_EVENT, {
      type: 'mouseWheel',
      x: params.x,
      y: params.y,
      deltaX,
      deltaY,
    });
  }

  /**
   * Navigates one entry back in the browser history.
   *
   * @returns `false` when the browser already sits on the first entry.
   */
  async goBack(): Promise<boolean> {
    return this.navigateHistory(-1);
  }

  /**
   * Navigates one entry forward in the browser history.
   *
   * @returns `false` when the browser already sits on the last entry.
   */
  async goForward(): Promise<boolean> {
    return this.navigateHistory(1);
  }

  /** Presses a combination of keys, releasing the modifiers in reverse. */
  async keyCombination(keys: string[]): Promise<void> {
    const commands: CdpCommand[] = [];
    const modifiersDown: string[] = [];
    for (const key of keys) {
      const upperKey = key.toUpperCase();
      if (!(upperKey in MODIFIER_MAP)) {
        commands.push(...combinationKeyCommands(key));
        continue;
      }
      const cdpKey = META_KEY_MAP[upperKey] ?? key;
      commands.push(keyEvent({type: 'keyDown', key: cdpKey}));
      modifiersDown.push(cdpKey);
    }
    for (const cdpKey of modifiersDown.reverse()) {
      commands.push(keyEvent({type: 'keyUp', key: cdpKey}));
    }
    if (commands.length > 0) {
      await this.makeCdpBatchRequest(commands);
    }
  }

  /** Drags from one coordinate and drops at another. */
  async dragAndDrop(params: {
    x: number;
    y: number;
    destinationX: number;
    destinationY: number;
  }): Promise<void> {
    const {x, y, destinationX, destinationY} = params;
    await this.makeCdpBatchRequest([
      mouseEvent({type: 'mouseMoved', x, y}),
      mouseEvent({type: 'mousePressed', button: 'left', x, y, clickCount: 1}),
      mouseEvent({type: 'mouseMoved', x: destinationX, y: destinationY}),
      mouseEvent({
        type: 'mouseReleased',
        button: 'left',
        x: destinationX,
        y: destinationY,
        clickCount: 1,
      }),
    ]);
  }

  /** Whether the sandbox reports itself healthy. */
  async healthCheck(): Promise<boolean> {
    try {
      const response = await this.send({
        httpMethod: 'GET',
        path: PATH_HEALTH,
      });
      return response['status'] === 'healthy';
    } catch (e: unknown) {
      logger.warn(`The sandbox health check failed: ${formatError(e)}`);
      return false;
    }
  }

  /** Sends one request to the sandbox and decodes its JSON body. */
  private async send(params: {
    httpMethod: 'GET' | 'POST';
    path: string;
    requestBody?: SandboxJson;
  }): Promise<SandboxJson> {
    const response = await this.sendCommand({
      httpMethod: params.httpMethod,
      path: params.path,
      accessToken: this.accessToken,
      sandbox: this.sandbox,
      requestBody: params.requestBody,
    });
    return parseResponseBody(response);
  }

  /** Sends each command on its own, collecting one result per command. */
  private async sendCommandsOneByOne(
    commands: CdpCommand[],
    stopOnError: boolean,
  ): Promise<CdpBatchResult[]> {
    const results: CdpBatchResult[] = [];
    for (const command of commands) {
      try {
        const result = await this.makeCdpRequest(
          command.command,
          command.params,
        );
        results.push({status: 'success', result});
      } catch (e: unknown) {
        results.push({status: 'error', error: formatError(e)});
        if (stopOnError) {
          break;
        }
      }
    }
    return results;
  }

  /** Moves `offset` entries through the browser history. */
  private async navigateHistory(offset: -1 | 1): Promise<boolean> {
    const response = await this.makeCdpRequest(CDP_PAGE_GET_NAVIGATION_HISTORY);
    const currentIndex =
      typeof response['currentIndex'] === 'number'
        ? response['currentIndex']
        : 0;
    const entries = Array.isArray(response['entries'])
      ? response['entries']
      : [];
    const targetIndex = currentIndex + offset;
    if (targetIndex < 0 || targetIndex > entries.length - 1) {
      return false;
    }
    const entryId = asJsonObject(entries[targetIndex])?.['id'];
    if (entryId === undefined) {
      throw new SandboxError(
        SandboxErrorCode.HISTORY_ENTRY_ID_MISSING,
        `Browser history entry ${targetIndex} carries no id.`,
      );
    }
    await this.makeCdpRequest(CDP_PAGE_NAVIGATE_TO_HISTORY_ENTRY, {entryId});
    return true;
  }
}
