/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Tests for the `SandboxClient` behaviour the adk-python reference suite does
 * not reach: the navigation retry, the batch fallback, response decoding and
 * the remaining key and scroll shapes.
 */

import {
  CdpCommand,
  SandboxClient,
  SandboxErrorCode,
  isSandboxError,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {SandboxCall} from './vmaas_test_utils.js';

const ACCESS_TOKEN = 'test_token';
const SANDBOX = {name: 'projects/test/sandboxEnvironments/123'};

/** Builds a client over the given transport. */
function clientOver(
  sendCommand: (params: SandboxCall) => Promise<{body?: string} | undefined>,
): SandboxClient {
  return new SandboxClient({
    sandbox: SANDBOX,
    accessToken: ACCESS_TOKEN,
    sendCommand: vi.fn(sendCommand),
  });
}

/** A transport that answers every request with the same JSON body. */
function alwaysRespond(payload: Record<string, unknown>) {
  return vi.fn(async (_params: SandboxCall) => ({
    body: JSON.stringify(payload),
  }));
}

describe('SandboxClient', () => {
  describe('response decoding', () => {
    it('reads an empty object from a response with no body', async () => {
      const client = clientOver(async () => ({}));

      expect(await client.makeCdpRequest('Page.reload')).toEqual({});
    });

    it('reads an empty object from a response the transport omitted', async () => {
      const client = clientOver(async () => undefined);

      expect(await client.makeCdpRequest('Page.reload')).toEqual({});
    });

    it('reads an empty object from a malformed JSON body', async () => {
      const client = clientOver(async () => ({body: 'not json'}));

      expect(await client.makeCdpRequest('Page.reload')).toEqual({});
    });

    it('reads an empty object from a JSON body that is not an object', async () => {
      const client = clientOver(async () => ({body: '[1, 2]'}));

      expect(await client.makeCdpRequest('Page.reload')).toEqual({});
    });

    it('sends an empty params object when the caller passes none', async () => {
      const sendCommand = alwaysRespond({});
      const client = new SandboxClient({
        sandbox: SANDBOX,
        accessToken: ACCESS_TOKEN,
        sendCommand,
      });

      await client.makeCdpRequest('Page.reload');

      expect(sendCommand.mock.calls[0][0].requestBody).toEqual({
        command: 'Page.reload',
        params: {},
      });
    });
  });

  describe('getScreenshot', () => {
    it('retries after a destroyed execution context', async () => {
      let attempts = 0;
      const client = clientOver(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Execution context was destroyed');
        }
        return {
          body: JSON.stringify({data: Buffer.from('ok').toString('base64')}),
        };
      });

      const result = await client.getScreenshot();

      expect(attempts).toBe(2);
      expect(Buffer.from(result).toString()).toBe('ok');
    });

    it('retries after a navigation error', async () => {
      let attempts = 0;
      const client = clientOver(async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error('Page navigation interrupted the read');
        }
        return {
          body: JSON.stringify({data: Buffer.from('ok').toString('base64')}),
        };
      });

      await client.getScreenshot();

      expect(attempts).toBe(3);
    });

    it('does not retry an unrelated failure', async () => {
      let attempts = 0;
      const client = clientOver(async () => {
        attempts++;
        throw new Error('permission denied');
      });

      await expect(client.getScreenshot()).rejects.toThrow('permission denied');
      expect(attempts).toBe(1);
    });

    it('gives up after the last attempt', async () => {
      let attempts = 0;
      const client = clientOver(async () => {
        attempts++;
        throw new Error('Execution context was destroyed');
      });

      await expect(client.getScreenshot()).rejects.toThrow(
        'Execution context was destroyed',
      );
      expect(attempts).toBe(3);
    });

    it('honours a caller-supplied attempt budget', async () => {
      let attempts = 0;
      const client = clientOver(async () => {
        attempts++;
        throw new Error('Execution context was destroyed');
      });

      await expect(client.getScreenshot(1)).rejects.toThrow(
        'Execution context was destroyed',
      );
      expect(attempts).toBe(1);
    });

    it('reports a response that carries no image data', async () => {
      const client = clientOver(async () => ({body: JSON.stringify({})}));

      const error = await client.getScreenshot().catch((e: unknown) => e);

      expect(isSandboxError(error)).toBe(true);
      expect(isSandboxError(error) && error.code).toBe(
        SandboxErrorCode.SCREENSHOT_DATA_MISSING,
      );
    });
  });

  describe('getCurrentUrl', () => {
    it('returns undefined when the active tab is missing from the list', async () => {
      const client = clientOver(async () => ({
        body: JSON.stringify({
          active_tab_id: 'tab1',
          all_tabs: [{id: 'tab2', url: 'https://other.com'}],
        }),
      }));

      expect(await client.getCurrentUrl()).toBeUndefined();
    });

    it('returns undefined when the tab list is not an array', async () => {
      const client = clientOver(async () => ({
        body: JSON.stringify({active_tab_id: 'tab1', all_tabs: 'nope'}),
      }));

      expect(await client.getCurrentUrl()).toBeUndefined();
    });

    it('returns undefined when the active tab carries no URL', async () => {
      const client = clientOver(async () => ({
        body: JSON.stringify({
          active_tab_id: 'tab1',
          all_tabs: [{id: 'tab1'}],
        }),
      }));

      expect(await client.getCurrentUrl()).toBeUndefined();
    });

    it('retries a navigation error and returns the settled URL', async () => {
      let attempts = 0;
      const client = clientOver(async () => {
        attempts++;
        if (attempts === 1) {
          throw new Error('Execution context was destroyed');
        }
        return {
          body: JSON.stringify({
            active_tab_id: 'tab1',
            all_tabs: [{id: 'tab1', url: 'https://settled.com'}],
          }),
        };
      });

      const result = await client.getCurrentUrl();

      expect(result).toBe('https://settled.com');
    });
  });

  describe('makeCdpBatchRequest', () => {
    const commands: CdpCommand[] = [
      {command: 'Command1', params: {}},
      {command: 'Command2', params: {}},
    ];

    it('returns an empty list when the batch response carries no results', async () => {
      const client = clientOver(async () => ({body: JSON.stringify({})}));

      expect(await client.makeCdpBatchRequest([])).toEqual([]);
    });

    it('stops at the first sequential failure by default', async () => {
      const sendCommand = vi.fn(async (params: SandboxCall) => {
        if (params.path === 'cdps') {
          throw new Error('404 Not Found');
        }
        throw new Error('command rejected');
      });
      const client = new SandboxClient({
        sandbox: SANDBOX,
        accessToken: ACCESS_TOKEN,
        sendCommand,
      });

      const results = await client.makeCdpBatchRequest(commands);

      expect(results).toEqual([
        {status: 'error', error: 'command rejected', result: undefined},
      ]);
      expect(sendCommand).toHaveBeenCalledTimes(2);
    });

    it('runs every command when stopOnError is false', async () => {
      const sendCommand = vi.fn(async (params: SandboxCall) => {
        if (params.path === 'cdps') {
          throw new Error('the batch path is unavailable');
        }
        throw new Error('command rejected');
      });
      const client = new SandboxClient({
        sandbox: SANDBOX,
        accessToken: ACCESS_TOKEN,
        sendCommand,
      });

      const results = await client.makeCdpBatchRequest(commands, false);

      expect(results).toHaveLength(2);
      expect(sendCommand).toHaveBeenCalledTimes(3);
      expect(sendCommand.mock.calls[0][0].requestBody).toEqual({
        commands,
        stop_on_error: false,
      });
    });

    it('keeps the error the sandbox reported for one command', async () => {
      const client = clientOver(async () => ({
        body: JSON.stringify({results: [{status: 'error', error: 'boom'}]}),
      }));

      expect(await client.makeCdpBatchRequest(commands)).toEqual([
        {status: 'error', error: 'boom', result: undefined},
      ]);
    });

    it('normalises a batch entry that is not an object', async () => {
      const client = clientOver(async () => ({
        body: JSON.stringify({results: ['nope']}),
      }));

      expect(await client.makeCdpBatchRequest(commands)).toEqual([
        {status: undefined, result: undefined, error: undefined},
      ]);
    });
  });

  describe('scrollAt', () => {
    const cases: Array<[string, {deltaX: number; deltaY: number}]> = [
      ['up', {deltaX: 0, deltaY: -300}],
      ['down', {deltaX: 0, deltaY: 300}],
      ['left', {deltaX: -300, deltaY: 0}],
      ['right', {deltaX: 300, deltaY: 0}],
    ];

    it.each(cases)('signs the %s deltas', async (direction, expected) => {
      const sendCommand = alwaysRespond({});
      const client = new SandboxClient({
        sandbox: SANDBOX,
        accessToken: ACCESS_TOKEN,
        sendCommand,
      });

      await client.scrollAt({
        x: 1,
        y: 2,
        direction: direction as 'up' | 'down' | 'left' | 'right',
        magnitude: 300,
      });

      const body = sendCommand.mock.calls[0][0].requestBody as {
        params: Record<string, unknown>;
      };
      expect(body.params).toMatchObject(expected);
    });
  });

  describe('goForward', () => {
    it('returns false at the end of the history', async () => {
      const sendCommand = alwaysRespond({
        currentIndex: 1,
        entries: [{id: 1}, {id: 2}],
      });
      const client = new SandboxClient({
        sandbox: SANDBOX,
        accessToken: ACCESS_TOKEN,
        sendCommand,
      });

      expect(await client.goForward()).toBe(false);
      expect(sendCommand).toHaveBeenCalledTimes(1);
    });

    it('treats a history response with no entries as the end', async () => {
      const client = clientOver(async () => ({body: JSON.stringify({})}));

      expect(await client.goForward()).toBe(false);
      expect(await client.goBack()).toBe(false);
    });
  });

  describe('keyCombination', () => {
    /** The batch the client sent for `keys`. */
    async function commandsFor(keys: string[]) {
      const sendCommand = alwaysRespond({results: []});
      const client = new SandboxClient({
        sandbox: SANDBOX,
        accessToken: ACCESS_TOKEN,
        sendCommand,
      });
      await client.keyCombination(keys);
      const body = sendCommand.mock.calls[0]?.[0].requestBody as
        | {commands: CdpCommand[]}
        | undefined;
      return body?.commands ?? [];
    }

    it('releases the modifiers in reverse order', async () => {
      const commands = await commandsFor(['control', 'shift', 'a']);

      expect(commands.map((entry) => entry.params)).toEqual([
        {type: 'keyDown', key: 'Control_L'},
        {type: 'keyDown', key: 'Shift_L'},
        {type: 'keyDown', text: 'a'},
        {type: 'keyUp', text: 'a'},
        {type: 'keyUp', key: 'Shift_L'},
        {type: 'keyUp', key: 'Control_L'},
      ]);
    });

    it('carries the virtual key code for Enter', async () => {
      const commands = await commandsFor(['enter']);

      expect(commands.map((entry) => entry.params)).toEqual([
        {type: 'keyDown', key: 'Enter', windowsVirtualKeyCode: 13},
        {type: 'keyUp', key: 'Enter', windowsVirtualKeyCode: 13},
      ]);
    });

    it('presses a mapped special key without a virtual key code', async () => {
      const commands = await commandsFor(['escape']);

      expect(commands.map((entry) => entry.params)).toEqual([
        {type: 'keyDown', key: 'Escape'},
        {type: 'keyUp', key: 'Escape'},
      ]);
    });

    it('holds a modifier that has no mapped CDP key name', async () => {
      const commands = await commandsFor(['super', 'a']);

      expect(commands[0].params).toEqual({type: 'keyDown', key: 'super'});
      expect(commands[3].params).toEqual({type: 'keyUp', key: 'super'});
    });

    it('inserts a multi-character key as text', async () => {
      const commands = await commandsFor(['hello world']);

      expect(commands).toEqual([
        {command: 'Input.insertText', params: {text: 'hello world'}},
      ]);
    });

    it('sends nothing when there are no keys', async () => {
      expect(await commandsFor([])).toEqual([]);
    });
  });

  describe('typeText', () => {
    /** The batch the client sent, or an empty list when it sent none. */
    async function commandsFor(
      text: string,
      pressEnter?: boolean,
      clearBeforeTyping?: boolean,
    ) {
      const sendCommand = alwaysRespond({results: []});
      const client = new SandboxClient({
        sandbox: SANDBOX,
        accessToken: ACCESS_TOKEN,
        sendCommand,
      });
      await client.typeText(text, pressEnter, clearBeforeTyping);
      const body = sendCommand.mock.calls[0]?.[0].requestBody as
        | {commands: CdpCommand[]}
        | undefined;
      return body?.commands ?? [];
    }

    it('sends nothing for empty text with no flags', async () => {
      expect(await commandsFor('')).toEqual([]);
    });

    it('clears the field without typing when the text is empty', async () => {
      const commands = await commandsFor('', false, true);

      expect(commands.map((entry) => entry.params['key'])).toEqual([
        'A',
        'A',
        'Delete',
        'Delete',
      ]);
      expect(commands[0].params['modifiers']).toBe(2);
    });
  });
});
