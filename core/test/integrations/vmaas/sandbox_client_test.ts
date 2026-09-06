/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-js paths of SandboxClient that adk-python's suite does not reach: the
 * navigation retry, the batch fallback, and the malformed responses.
 */

import {SandboxEnvironment} from '@google-cloud/vertexai/build/src/genai/types.js';
import {
  CdpCommand,
  SandboxClient,
  SandboxError,
  SandboxErrorCode,
  SandboxJson,
  isSandboxError,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {SCREENSHOT_BASE64, SCREENSHOT_BYTES} from './vmaas_test_utils.js';

const SANDBOX: SandboxEnvironment = {name: 'sandbox-under-test'};

/** What the transport answers one request with. */
type Answer = SandboxJson | Error | {rawBody: string | undefined};

/** One request the client sent. */
interface RecordedCall {
  httpMethod: 'GET' | 'POST';
  path: string;
  accessToken: string;
  sandbox: SandboxEnvironment;
  requestBody?: SandboxJson;
}

/** A client whose transport answers `answers` in order. */
function createClient(...answers: Answer[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const sendCommand = vi.fn(async (params: RecordedCall) => {
    calls.push(params);
    const answer = answers[Math.min(index, answers.length - 1)] ?? {};
    index++;
    if (answer instanceof Error) {
      throw answer;
    }
    if ('rawBody' in answer && typeof answer['rawBody'] !== 'object') {
      return {body: answer['rawBody'] as string | undefined};
    }
    return {body: JSON.stringify(answer)};
  });
  const client = new SandboxClient({
    sandbox: SANDBOX,
    accessToken: 'token',
    sendCommand,
  });
  return {client, calls};
}

/** The commands of the batch request the client sent. */
function batchedCommands(call: RecordedCall): CdpCommand[] {
  const commands = call.requestBody?.['commands'];
  return Array.isArray(commands) ? (commands as CdpCommand[]) : [];
}

/** Reports the failure a rejected call carried, for a typed assertion. */
async function captureError(call: Promise<unknown>): Promise<SandboxError> {
  try {
    await call;
  } catch (e: unknown) {
    if (isSandboxError(e)) {
      return e;
    }
    expect.fail(`Expected a SandboxError, got ${String(e)}`);
  }
  expect.fail('Expected the call to fail.');
}

describe('SandboxClient', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  describe('reading while the page navigates', () => {
    it('reads the screenshot again after a destroyed context', async () => {
      const {client, calls} = createClient(
        new Error('Execution context was destroyed'),
        {data: SCREENSHOT_BASE64},
      );
      vi.useFakeTimers();

      const screenshot = client.getScreenshot();
      await vi.advanceTimersByTimeAsync(500);

      expect(await screenshot).toEqual(SCREENSHOT_BYTES);
      expect(calls).toHaveLength(2);
    });

    it('reads the tabs again after a navigation error', async () => {
      const {client, calls} = createClient(new Error('navigation in flight'), {
        active_tab_id: 'tab1',
        all_tabs: [{id: 'tab1', url: 'https://example.com'}],
      });
      vi.useFakeTimers();

      const url = client.getCurrentUrl();
      await vi.advanceTimersByTimeAsync(500);

      expect(await url).toBe('https://example.com');
      expect(calls).toHaveLength(2);
    });

    it('does not read again after an unrelated failure', async () => {
      const {client, calls} = createClient(new Error('permission denied'));

      await expect(client.getScreenshot()).rejects.toThrow('permission denied');
      expect(calls).toHaveLength(1);
    });

    it('reports the last failure when every attempt navigates', async () => {
      const {client, calls} = createClient(
        new Error('Execution context was destroyed'),
      );
      vi.useFakeTimers();

      const failing = client.getScreenshot(2);
      const assertion = expect(failing).rejects.toThrow(
        'Execution context was destroyed',
      );
      await vi.advanceTimersByTimeAsync(500);

      await assertion;
      expect(calls).toHaveLength(2);
    });

    it('reports a screenshot response that carries no image', async () => {
      const {client} = createClient({});

      const error = await captureError(client.getScreenshot());

      expect(error.code).toBe(SandboxErrorCode.SCREENSHOT_DATA_MISSING);
    });
  });

  describe('current URL', () => {
    it('has no URL when the active tab is missing from the tab list', async () => {
      const {client} = createClient({
        active_tab_id: 'tab9',
        all_tabs: [{id: 'tab1', url: 'https://example.com'}],
      });

      expect(await client.getCurrentUrl()).toBeUndefined();
    });

    it('has no URL when the response lists no tabs', async () => {
      const {client} = createClient({active_tab_id: 'tab1'});

      expect(await client.getCurrentUrl()).toBeUndefined();
    });

    it('has no URL when the active tab carries none', async () => {
      const {client} = createClient({
        active_tab_id: 'tab1',
        all_tabs: [{id: 'tab1'}],
      });

      expect(await client.getCurrentUrl()).toBeUndefined();
    });
  });

  describe('batch requests', () => {
    it('warns and still sends one by one when the batch fails oddly', async () => {
      const {client, calls} = createClient(
        new Error('500 Internal Server Error'),
        {result: 'ok'},
      );

      const results = await client.makeCdpBatchRequest([
        {command: 'Command1', params: {}},
      ]);

      expect(results).toEqual([{status: 'success', result: {result: 'ok'}}]);
      expect(calls.map((call) => call.path)).toEqual(['cdps', 'cdp']);
    });

    it('stops the sequence at the first failed command', async () => {
      const {client, calls} = createClient(
        new Error('404 Not Found'),
        new Error('the command failed'),
      );

      const results = await client.makeCdpBatchRequest([
        {command: 'Command1', params: {}},
        {command: 'Command2', params: {}},
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].status).toBe('error');
      expect(results[0].error).toContain('the command failed');
      expect(calls).toHaveLength(2);
    });

    it('runs the whole sequence when told not to stop on an error', async () => {
      const {client, calls} = createClient(
        new Error('404 Not Found'),
        new Error('the command failed'),
      );

      const results = await client.makeCdpBatchRequest(
        [
          {command: 'Command1', params: {}},
          {command: 'Command2', params: {}},
        ],
        false,
      );

      expect(results.map((result) => result.status)).toEqual([
        'error',
        'error',
      ]);
      expect(calls).toHaveLength(3);
    });

    it('reads what the batch reported for each command', async () => {
      const {client} = createClient({
        results: [{status: 'error', error: 'boom'}, 'not an object'],
      });

      const results = await client.makeCdpBatchRequest([
        {command: 'Command1', params: {}},
        {command: 'Command2', params: {}},
      ]);

      expect(results).toEqual([
        {status: 'error', result: undefined, error: 'boom'},
        {status: undefined, result: undefined, error: undefined},
      ]);
    });

    it('reports no results when the batch response carries none', async () => {
      const {client} = createClient({results: 'not a list'});

      expect(await client.makeCdpBatchRequest([])).toEqual([]);
    });

    it('sends nothing when there is nothing to type', async () => {
      const {client, calls} = createClient({});

      await client.typeText('');

      expect(calls).toHaveLength(0);
    });

    it('sends nothing for an empty key combination', async () => {
      const {client, calls} = createClient({});

      await client.keyCombination([]);

      expect(calls).toHaveLength(0);
    });
  });

  describe('malformed responses', () => {
    it('reads an absent body as an empty response', async () => {
      const {client} = createClient({rawBody: undefined});

      expect(await client.makeCdpRequest('Page.navigate')).toEqual({});
    });

    it('reads an unparseable body as an empty response', async () => {
      const {client} = createClient({rawBody: 'not json'});

      expect(await client.makeCdpRequest('Page.navigate')).toEqual({});
    });

    it('reads a non-object body as an empty response', async () => {
      const {client} = createClient({rawBody: '[1, 2]'});

      expect(await client.makeCdpRequest('Page.navigate')).toEqual({});
    });
  });

  describe('keys', () => {
    it('gives Enter its virtual key code', async () => {
      const {client, calls} = createClient({results: []});

      await client.keyCombination(['enter']);

      expect(
        batchedCommands(calls[0]).map((command) => command.params),
      ).toEqual([
        {type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13},
        {type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13},
      ]);
    });

    it('presses a named key that needs no virtual key code', async () => {
      const {client, calls} = createClient({results: []});

      await client.keyCombination(['tab']);

      expect(
        batchedCommands(calls[0]).map((command) => command.params),
      ).toEqual([
        {type: 'keyDown', key: 'Tab'},
        {type: 'keyUp', key: 'Tab'},
      ]);
    });

    it('inserts a word that names no key', async () => {
      const {client, calls} = createClient({results: []});

      await client.keyCombination(['hello']);

      expect(batchedCommands(calls[0])).toEqual([
        {command: 'Input.insertText', params: {text: 'hello'}},
      ]);
    });

    it('holds a modifier that the key map does not name', async () => {
      const {client, calls} = createClient({results: []});

      await client.keyCombination(['super', 'a']);

      expect(
        batchedCommands(calls[0]).map((command) => command.params),
      ).toEqual([
        {type: 'keyDown', key: 'super'},
        {type: 'keyDown', text: 'a'},
        {type: 'keyUp', text: 'a'},
        {type: 'keyUp', key: 'super'},
      ]);
    });

    it('releases the modifiers in reverse order', async () => {
      const {client, calls} = createClient({results: []});

      await client.keyCombination(['control', 'shift', 'n']);

      expect(
        batchedCommands(calls[0])
          .map((command) => command.params)
          .filter((params) => params['type'] === 'keyUp'),
      ).toEqual([
        {type: 'keyUp', text: 'n'},
        {type: 'keyUp', key: 'Shift_L'},
        {type: 'keyUp', key: 'Control_L'},
      ]);
    });
  });

  describe('scrolling', () => {
    it('scrolls left with a negative horizontal delta', async () => {
      const {client, calls} = createClient({});

      await client.scrollAt({x: 5, y: 6, direction: 'left', magnitude: 200});

      expect(calls[0].requestBody?.['params']).toEqual({
        type: 'mouseWheel',
        x: 5,
        y: 6,
        deltaX: -200,
        deltaY: 0,
      });
    });

    it('scrolls right with a positive horizontal delta', async () => {
      const {client, calls} = createClient({});

      await client.scrollAt({x: 5, y: 6, direction: 'right', magnitude: 200});

      expect(calls[0].requestBody?.['params']).toMatchObject({
        deltaX: 200,
        deltaY: 0,
      });
    });
  });

  describe('history', () => {
    it('stays put when the browser is at the last entry', async () => {
      const {client, calls} = createClient({
        currentIndex: 1,
        entries: [{id: 1}, {id: 2}],
      });

      expect(await client.goForward()).toBe(false);
      expect(calls).toHaveLength(1);
    });

    it('treats a response without a history as the first entry', async () => {
      const {client} = createClient({});

      expect(await client.goBack()).toBe(false);
    });

    it('reports a history entry that carries no id', async () => {
      const {client} = createClient({currentIndex: 1, entries: [{}, {id: 2}]});

      const error = await captureError(client.goBack());

      expect(error.code).toBe(SandboxErrorCode.HISTORY_ENTRY_ID_MISSING);
    });
  });
});
