/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Low-level client for Vertex AI Computer Use Sandbox commands.
 *
 * The client turns browser actions into Chrome DevTools Protocol (CDP)
 * commands and sends them to the sandbox over the transport the caller
 * supplies.
 */

import {SandboxEnvironment} from '@google-cloud/vertexai/build/src/genai/types.js';

import {formatError} from '../../utils/error_utils.js';
import {experimental} from '../../utils/experimental.js';
import {logger} from '../../utils/logger.js';
import {SandboxError, SandboxErrorCode} from './sandbox_errors.js';

const CDP_COMMAND_PAGE_CAPTURE_SCREENSHOT = 'Page.captureScreenshot';
const CDP_COMMAND_INPUT_DISPATCH_MOUSE_EVENT = 'Input.dispatchMouseEvent';
const CDP_COMMAND_INPUT_DISPATCH_KEY_EVENT = 'Input.dispatchKeyEvent';
const CDP_COMMAND_INPUT_INSERT_TEXT = 'Input.insertText';
const CDP_COMMAND_PAGE_GET_NAV_HISTORY = 'Page.getNavigationHistory';
const CDP_COMMAND_PAGE_NAV_TO_HISTORY = 'Page.navigateToHistoryEntry';
const CDP_COMMAND_PAGE_NAVIGATE = 'Page.navigate';

/** The sandbox path that runs a single CDP command. */
const PATH_CDP = 'cdp';
/** The sandbox path that runs a batch of CDP commands. */
const PATH_CDP_BATCH = 'cdps';
/** The sandbox path that lists the browser tabs. */
const PATH_TABS = 'tabs';

/** Windows virtual key codes for the keys the client synthesises itself. */
const VIRTUAL_KEY_CODE_A = 65;
const VIRTUAL_KEY_CODE_DELETE = 46;
const VIRTUAL_KEY_CODE_ENTER = 13;

/** Attempts and pause used when the page navigates under a read. */
const DEFAULT_MAX_RETRIES = 3;
const RETRY_DELAY_MS = 500;

/** The two transient failures a navigating page raises under a read. */
const TRANSIENT_ERROR_FRAGMENTS = ['context was destroyed', 'navigation'];

/** Maps a user-facing key name to the key value CDP expects. */
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

/** Maps a modifier key name to its CDP modifier bitmask. */
const MODIFIER_MAP: Readonly<Record<string, number>> = {
  CONTROL: 2,
  ALT: 1,
  SHIFT: 8,
  COMMAND: 4,
  SUPER: 4,
};

/** The direction of a scroll, as the sandbox client accepts it. */
export type SandboxScrollDirection = 'up' | 'down' | 'left' | 'right';

/** A JSON object decoded from a sandbox response. */
export type CdpResponse = Record<string, unknown>;

/** One Chrome DevTools Protocol command and its parameters. */
export interface CdpCommand {
  command: string;
  params: CdpResponse;
}

/** What the sandbox reports for one command of a batch. */
export interface CdpBatchResult {
  status?: string;
  result?: CdpResponse;
  error?: string;
}

/**
 * Sends one raw request to a sandbox's HTTP surface.
 *
 * `@google-cloud/vertexai@1.12.0` does not expose the sandbox `sendCommand`
 * method that adk-python calls, so the caller supplies the transport.
 */
export type SandboxCommandSender = (params: {
  httpMethod: 'GET' | 'POST';
  path: string;
  accessToken: string;
  sandbox: SandboxEnvironment;
  requestBody?: CdpResponse;
}) => Promise<{body?: string} | undefined>;

/** Options for {@link SandboxClient}. */
export interface SandboxClientOptions {
  /** The sandbox environment the commands are sent to. */
  sandbox: SandboxEnvironment;
  /** The access token authenticating each request. */
  accessToken: string;
  /** The transport that carries a request to the sandbox. */
  sendCommand: SandboxCommandSender;
}

/** Narrows a value to a JSON object, or `undefined` when it is not one. */
function asRecord(value: unknown): CdpResponse | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as CdpResponse)
    : undefined;
}

/**
 * Decodes a sandbox response body as JSON.
 *
 * Returns an empty object for an absent or malformed body, which is what
 * adk-python's `safe_json_loads` does.
 */
function parseResponseBody(response: {body?: string} | undefined): CdpResponse {
  if (!response?.body) {
    return {};
  }
  try {
    return asRecord(JSON.parse(response.body)) ?? {};
  } catch {
    return {};
  }
}

/** Normalises one entry of a batch response into a {@link CdpBatchResult}. */
function toBatchResult(value: unknown): CdpBatchResult {
  const record = asRecord(value) ?? {};
  return {
    status: typeof record['status'] === 'string' ? record['status'] : undefined,
    result: asRecord(record['result']),
    error: typeof record['error'] === 'string' ? record['error'] : undefined,
  };
}

/** Resolves after `ms` milliseconds. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Whether an error message names a failure a navigating page raises. */
function isTransientNavigationError(message: string): boolean {
  const lowered = message.toLowerCase();
  return TRANSIENT_ERROR_FRAGMENTS.some((fragment) =>
    lowered.includes(fragment),
  );
}

/**
 * Runs `operation`, retrying it while the page is navigating.
 *
 * Any other failure is rethrown at once, and so is a transient failure on the
 * last attempt.
 */
async function retryWhileNavigating<T>(
  operation: () => Promise<T>,
  maxRetries: number,
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (e: unknown) {
      if (
        attempt >= maxRetries ||
        !isTransientNavigationError(formatError(e))
      ) {
        throw e;
      }
      logger.debug(
        `Retrying after a navigation error (attempt ${attempt} of ${maxRetries}).`,
      );
      await sleep(RETRY_DELAY_MS);
    }
  }
}

/** Builds the CDP command that dispatches a key event. */
function keyEvent(params: CdpResponse): CdpCommand {
  return {command: CDP_COMMAND_INPUT_DISPATCH_KEY_EVENT, params};
}

/** Builds the CDP command that dispatches a mouse event. */
function mouseEvent(params: CdpResponse): CdpCommand {
  return {command: CDP_COMMAND_INPUT_DISPATCH_MOUSE_EVENT, params};
}

/** Builds the pair of commands that press and release one mapped key. */
function keyPress(cdpKey: string): CdpCommand[] {
  const params: CdpResponse = {key: cdpKey};
  if (cdpKey === 'Enter') {
    params['windowsVirtualKeyCode'] = VIRTUAL_KEY_CODE_ENTER;
  }
  return [
    keyEvent({type: 'keyDown', ...params}),
    keyEvent({type: 'keyUp', ...params}),
  ];
}

/** The commands that select the focused field's content and delete it. */
function clearFieldCommands(): CdpCommand[] {
  return [
    keyEvent({
      type: 'keyDown',
      modifiers: MODIFIER_MAP['CONTROL'],
      windowsVirtualKeyCode: VIRTUAL_KEY_CODE_A,
      key: 'A',
    }),
    keyEvent({
      type: 'keyUp',
      windowsVirtualKeyCode: VIRTUAL_KEY_CODE_A,
      key: 'A',
    }),
    keyEvent({
      type: 'keyDown',
      windowsVirtualKeyCode: VIRTUAL_KEY_CODE_DELETE,
      key: 'Delete',
    }),
    keyEvent({
      type: 'keyUp',
      windowsVirtualKeyCode: VIRTUAL_KEY_CODE_DELETE,
      key: 'Delete',
    }),
  ];
}

/** The commands that press and release Enter. */
function pressEnterCommands(): CdpCommand[] {
  return [
    keyEvent({
      type: 'keyDown',
      windowsVirtualKeyCode: VIRTUAL_KEY_CODE_ENTER,
      key: 'Enter',
    }),
    keyEvent({
      type: 'keyUp',
      windowsVirtualKeyCode: VIRTUAL_KEY_CODE_ENTER,
      key: 'Enter',
    }),
  ];
}

/** The commands that press and release one key of a key combination. */
function keyCombinationCommands(key: string): CdpCommand[] {
  const upperKey = key.toUpperCase();
  if (upperKey in META_KEY_MAP) {
    return keyPress(META_KEY_MAP[upperKey]);
  }
  if (key.length === 1) {
    return [
      keyEvent({type: 'keyDown', text: key}),
      keyEvent({type: 'keyUp', text: key}),
    ];
  }
  return [{command: CDP_COMMAND_INPUT_INSERT_TEXT, params: {text: key}}];
}

/** The pixel deltas of a scroll in the given direction. */
function scrollDeltas(
  direction: SandboxScrollDirection,
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
 * Drives a Vertex AI Computer Use Sandbox browser over the Chrome DevTools
 * Protocol.
 *
 * The client holds one sandbox and one access token for its lifetime, so it is
 * created per action batch and replaced when the token is refreshed.
 */
@experimental
export class SandboxClient {
  private readonly sandbox: SandboxEnvironment;
  private readonly sendCommand: SandboxCommandSender;
  private accessToken: string;

  constructor(options: SandboxClientOptions) {
    this.sandbox = options.sandbox;
    this.accessToken = options.accessToken;
    this.sendCommand = options.sendCommand;
  }

  /** Replaces the access token used by later requests. */
  updateAccessToken(accessToken: string): void {
    this.accessToken = accessToken;
  }

  /** Sends one request to the sandbox and decodes its JSON body. */
  private async send(params: {
    httpMethod: 'GET' | 'POST';
    path: string;
    requestBody?: CdpResponse;
  }): Promise<CdpResponse> {
    const response = await this.sendCommand({
      httpMethod: params.httpMethod,
      path: params.path,
      accessToken: this.accessToken,
      sandbox: this.sandbox,
      requestBody: params.requestBody,
    });
    return parseResponseBody(response);
  }

  /** Runs one CDP command and returns its response. */
  async makeCdpRequest(
    command: string,
    params: CdpResponse = {},
  ): Promise<CdpResponse> {
    return this.send({
      httpMethod: 'POST',
      path: PATH_CDP,
      requestBody: {command, params},
    });
  }

  /**
   * Runs several CDP commands.
   *
   * The batch path runs them in one request. When the sandbox does not serve
   * that path, the commands run one at a time instead.
   */
  async makeCdpBatchRequest(
    commands: CdpCommand[],
    stopOnError = true,
  ): Promise<CdpBatchResult[]> {
    try {
      const parsed = await this.send({
        httpMethod: 'POST',
        path: PATH_CDP_BATCH,
        // The sandbox reads this field in snake_case.
        requestBody: {commands, stop_on_error: stopOnError},
      });
      const results = parsed['results'];
      return Array.isArray(results) ? results.map(toBatchResult) : [];
    } catch (e: unknown) {
      const message = formatError(e);
      if (
        message.includes('404') ||
        message.toLowerCase().includes('not found')
      ) {
        logger.debug('Batch CDP path is not available, running sequentially.');
      } else {
        logger.warn(
          `Batch CDP request failed, running sequentially: ${message}`,
        );
      }
    }
    return this.runCommandsSequentially(commands, stopOnError);
  }

  /** Runs each command on its own, collecting one result per command. */
  private async runCommandsSequentially(
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

  /** Captures the current page as PNG bytes. */
  async getScreenshot(maxRetries = DEFAULT_MAX_RETRIES): Promise<Uint8Array> {
    return retryWhileNavigating(async () => {
      const response = await this.makeCdpRequest(
        CDP_COMMAND_PAGE_CAPTURE_SCREENSHOT,
      );
      const data = response['data'];
      if (typeof data !== 'string') {
        throw new SandboxError(
          SandboxErrorCode.SCREENSHOT_DATA_MISSING,
          `${CDP_COMMAND_PAGE_CAPTURE_SCREENSHOT} returned no image data.`,
        );
      }
      return Buffer.from(data, 'base64');
    }, maxRetries);
  }

  /** Returns the URL of the active tab, or `undefined` when there is none. */
  async getCurrentUrl(
    maxRetries = DEFAULT_MAX_RETRIES,
  ): Promise<string | undefined> {
    return retryWhileNavigating(async () => {
      const parsed = await this.send({httpMethod: 'GET', path: PATH_TABS});
      // The sandbox reports these fields in snake_case.
      const activeTabId = parsed['active_tab_id'];
      if (activeTabId === undefined || activeTabId === null) {
        return undefined;
      }
      const tabs = parsed['all_tabs'];
      if (!Array.isArray(tabs)) {
        return undefined;
      }
      const active = tabs
        .map(asRecord)
        .find((tab) => tab?.['id'] === activeTabId);
      const url = active?.['url'];
      return typeof url === 'string' ? url : undefined;
    }, maxRetries);
  }

  /** Navigates the browser to `url`. */
  async navigate(url: string): Promise<CdpResponse> {
    return this.makeCdpRequest(CDP_COMMAND_PAGE_NAVIGATE, {url});
  }

  /** Clicks the left mouse button at a coordinate. */
  async clickAt(x: number, y: number): Promise<void> {
    await this.makeCdpBatchRequest([
      mouseEvent({
        type: 'mousePressed',
        button: 'left',
        x,
        y,
        clickCount: 1,
      }),
      mouseEvent({
        type: 'mouseReleased',
        button: 'left',
        x,
        y,
        clickCount: 1,
      }),
    ]);
  }

  /** Moves the mouse to a coordinate without clicking. */
  async hoverAt(x: number, y: number): Promise<void> {
    await this.makeCdpRequest(CDP_COMMAND_INPUT_DISPATCH_MOUSE_EVENT, {
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
      commands.push({
        command: CDP_COMMAND_INPUT_INSERT_TEXT,
        params: {text},
      });
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
    direction: SandboxScrollDirection;
    magnitude: number;
  }): Promise<void> {
    const {deltaX, deltaY} = scrollDeltas(params.direction, params.magnitude);
    await this.makeCdpRequest(CDP_COMMAND_INPUT_DISPATCH_MOUSE_EVENT, {
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
   * @returns `false` when the browser is already at the first entry.
   */
  async goBack(): Promise<boolean> {
    return this.navigateHistory(-1);
  }

  /**
   * Navigates one entry forward in the browser history.
   *
   * @returns `false` when the browser is already at the last entry.
   */
  async goForward(): Promise<boolean> {
    return this.navigateHistory(1);
  }

  /** Moves `offset` entries through the browser history. */
  private async navigateHistory(offset: -1 | 1): Promise<boolean> {
    const response = await this.makeCdpRequest(
      CDP_COMMAND_PAGE_GET_NAV_HISTORY,
    );
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
    await this.makeCdpRequest(CDP_COMMAND_PAGE_NAV_TO_HISTORY, {
      entryId: asRecord(entries[targetIndex])?.['id'],
    });
    return true;
  }

  /** Presses a combination of keys, releasing the modifiers in reverse. */
  async keyCombination(keys: string[]): Promise<void> {
    const commands: CdpCommand[] = [];
    const modifiersDown: string[] = [];
    for (const key of keys) {
      const upperKey = key.toUpperCase();
      if (upperKey in MODIFIER_MAP) {
        const cdpKey = META_KEY_MAP[upperKey] ?? key;
        commands.push(keyEvent({type: 'keyDown', key: cdpKey}));
        modifiersDown.push(cdpKey);
        continue;
      }
      commands.push(...keyCombinationCommands(key));
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
      mouseEvent({
        type: 'mousePressed',
        button: 'left',
        x,
        y,
        clickCount: 1,
      }),
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
      const parsed = await this.send({httpMethod: 'GET', path: ''});
      return parsed['status'] === 'healthy';
    } catch (e: unknown) {
      logger.warn(`Sandbox health check failed: ${formatError(e)}`);
      return false;
    }
  }
}
