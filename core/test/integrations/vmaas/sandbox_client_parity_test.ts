/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The reference suite for SandboxClient, ported test by test from adk-python
 * `main`, `tests/unittests/integrations/vmaas/test_sandbox_client.py`.
 *
 * Each `it` keeps its Python test name. The Python tests patch
 * `asyncio.to_thread` and read private fields; these drive the injected
 * transport instead, because adk-js tests may not reach into a private.
 */

import {SandboxEnvironment} from '@google-cloud/vertexai/build/src/genai/types.js';
import {SandboxClient, SandboxCommandSender, SandboxJson} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';

import {SCREENSHOT_BASE64, SCREENSHOT_BYTES} from './vmaas_test_utils.js';

const ACCESS_TOKEN = 'test_token_12345';
const SANDBOX: SandboxEnvironment = {name: 'sandbox-under-test'};

/** One request the client sent. */
interface RecordedCall {
  httpMethod: 'GET' | 'POST';
  path: string;
  accessToken: string;
  sandbox: SandboxEnvironment;
  requestBody?: SandboxJson;
}

/**
 * A client whose transport answers `bodies` in order, and records every call.
 *
 * A `body` entry that is an `Error` is thrown instead of answered.
 */
function createClient(...answers: Array<SandboxJson | Error>) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const sendCommand: SandboxCommandSender = vi.fn(
    async (params: RecordedCall) => {
      calls.push(params);
      const answer = answers[Math.min(index, answers.length - 1)] ?? {};
      index++;
      if (answer instanceof Error) {
        throw answer;
      }
      return {body: JSON.stringify(answer)};
    },
  );
  const client = new SandboxClient({
    sandbox: SANDBOX,
    accessToken: ACCESS_TOKEN,
    sendCommand,
  });
  return {client, calls};
}

/** The commands of the batch request the client sent. */
function batchedCommands(call: RecordedCall): unknown[] {
  const commands = call.requestBody?.['commands'];
  return Array.isArray(commands) ? commands : [];
}

describe('SandboxClient parity with adk-python', () => {
  it('test_init', async () => {
    const {client, calls} = createClient({});

    await client.makeCdpRequest('Page.navigate');

    // The constructor arguments are private, so the request they shape is what
    // this asserts on.
    expect(calls[0].sandbox).toBe(SANDBOX);
    expect(calls[0].accessToken).toBe(ACCESS_TOKEN);
  });

  it('test_update_access_token', async () => {
    const {client, calls} = createClient({});
    client.updateAccessToken('new_token_67890');

    await client.makeCdpRequest('Page.navigate');

    expect(calls[0].accessToken).toBe('new_token_67890');
  });

  it('test_make_cdp_request', async () => {
    const {client, calls} = createClient({result: 'success'});

    const result = await client.makeCdpRequest('Page.navigate', {
      url: 'https://example.com',
    });

    expect(result).toEqual({result: 'success'});
    expect(calls).toHaveLength(1);
    expect(calls[0].httpMethod).toBe('POST');
    expect(calls[0].path).toBe('cdp');
    expect(calls[0].accessToken).toBe(ACCESS_TOKEN);
    expect(calls[0].sandbox).toBe(SANDBOX);
    expect(calls[0].requestBody).toEqual({
      command: 'Page.navigate',
      params: {url: 'https://example.com'},
    });
  });

  it('test_make_cdp_batch_request_with_batch_endpoint', async () => {
    const {client, calls} = createClient({
      results: [{status: 'success'}, {status: 'success'}],
    });

    const results = await client.makeCdpBatchRequest([
      {command: 'Input.dispatchMouseEvent', params: {type: 'mousePressed'}},
      {command: 'Input.dispatchMouseEvent', params: {type: 'mouseReleased'}},
    ]);

    expect(results).toHaveLength(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].path).toBe('cdps');
  });

  it('test_make_cdp_batch_request_fallback_sequential', async () => {
    const {client, calls} = createClient(
      new Error('404 Not Found'),
      {result: 'ok'},
      {result: 'ok'},
    );

    const results = await client.makeCdpBatchRequest([
      {command: 'Command1', params: {}},
      {command: 'Command2', params: {}},
    ]);

    expect(results).toHaveLength(2);
    expect(results[0].status).toBe('success');
    expect(results[1].status).toBe('success');
    // One failed batch request, then one request per command.
    expect(calls).toHaveLength(3);
    expect(calls.map((call) => call.path)).toEqual(['cdps', 'cdp', 'cdp']);
  });

  it('test_get_screenshot', async () => {
    const {client, calls} = createClient({data: SCREENSHOT_BASE64});

    const screenshot = await client.getScreenshot();

    expect(screenshot).toEqual(SCREENSHOT_BYTES);
    expect(calls[0].requestBody?.['command']).toBe('Page.captureScreenshot');
  });

  it('test_get_current_url', async () => {
    const {client, calls} = createClient({
      active_tab_id: 'tab1',
      all_tabs: [{id: 'tab1', url: 'https://example.com', title: 'Example'}],
    });

    const url = await client.getCurrentUrl();

    expect(url).toBe('https://example.com');
    expect(calls[0].path).toBe('tabs');
    expect(calls[0].httpMethod).toBe('GET');
  });

  it('test_get_current_url_no_active_tab', async () => {
    const {client} = createClient({active_tab_id: null, all_tabs: []});

    expect(await client.getCurrentUrl()).toBeUndefined();
  });

  it('test_navigate', async () => {
    const {client, calls} = createClient({frameId: 'frame123'});

    const result = await client.navigate('https://example.com');

    expect(result).toEqual({frameId: 'frame123'});
    expect(calls[0].requestBody).toEqual({
      command: 'Page.navigate',
      params: {url: 'https://example.com'},
    });
  });

  it('test_click_at', async () => {
    const {client, calls} = createClient({results: [{}, {}]});

    await client.clickAt(100, 200);

    expect(calls[0].path).toBe('cdps');
    expect(batchedCommands(calls[0])).toEqual([
      {
        command: 'Input.dispatchMouseEvent',
        params: {
          type: 'mousePressed',
          button: 'left',
          x: 100,
          y: 200,
          clickCount: 1,
        },
      },
      {
        command: 'Input.dispatchMouseEvent',
        params: {
          type: 'mouseReleased',
          button: 'left',
          x: 100,
          y: 200,
          clickCount: 1,
        },
      },
    ]);
  });

  it('test_hover_at', async () => {
    const {client, calls} = createClient({});

    await client.hoverAt(150, 250);

    expect(calls[0].requestBody?.['params']).toEqual({
      type: 'mouseMoved',
      x: 150,
      y: 250,
    });
  });

  it('test_scroll_at_down', async () => {
    const {client, calls} = createClient({});

    await client.scrollAt({x: 100, y: 200, direction: 'down', magnitude: 300});

    expect(calls[0].requestBody?.['params']).toEqual({
      type: 'mouseWheel',
      x: 100,
      y: 200,
      deltaX: 0,
      deltaY: 300,
    });
  });

  it('test_scroll_at_up', async () => {
    const {client, calls} = createClient({});

    await client.scrollAt({x: 100, y: 200, direction: 'up', magnitude: 300});

    expect(calls[0].requestBody?.['params']).toMatchObject({deltaY: -300});
  });

  it('test_go_back', async () => {
    const {client, calls} = createClient(
      {
        currentIndex: 1,
        entries: [
          {id: 1, url: 'https://first.com'},
          {id: 2, url: 'https://second.com'},
        ],
      },
      {},
    );

    expect(await client.goBack()).toBe(true);
    expect(calls).toHaveLength(2);
    expect(calls[1].requestBody).toEqual({
      command: 'Page.navigateToHistoryEntry',
      params: {entryId: 1},
    });
  });

  it('test_go_back_at_beginning', async () => {
    const {client, calls} = createClient({
      currentIndex: 0,
      entries: [{id: 1, url: 'https://first.com'}],
    });

    expect(await client.goBack()).toBe(false);
    // Only the history read: there is nothing to navigate to.
    expect(calls).toHaveLength(1);
  });

  it('test_type_text_with_clear_and_enter', async () => {
    const {client, calls} = createClient({results: []});

    await client.typeText('hello', true, true);

    // Ctrl+A down and up, Delete down and up, insertText, Enter down and up.
    expect(batchedCommands(calls[0])).toHaveLength(7);
  });

  it('test_key_combination', async () => {
    const {client, calls} = createClient({results: []});

    await client.keyCombination(['control', 'c']);

    // Control down, c down, c up, Control up.
    expect(batchedCommands(calls[0])).toHaveLength(4);
  });

  it('test_drag_and_drop', async () => {
    const {client, calls} = createClient({results: []});

    await client.dragAndDrop({
      x: 10,
      y: 20,
      destinationX: 100,
      destinationY: 200,
    });

    // Move to the start, press, move to the destination, release.
    expect(batchedCommands(calls[0])).toHaveLength(4);
  });

  it('test_health_check_healthy', async () => {
    const {client, calls} = createClient({status: 'healthy'});

    expect(await client.healthCheck()).toBe(true);
    expect(calls[0].httpMethod).toBe('GET');
    expect(calls[0].path).toBe('');
  });

  it('test_health_check_unhealthy', async () => {
    const {client} = createClient({status: 'unhealthy'});

    expect(await client.healthCheck()).toBe(false);
  });

  it('test_health_check_exception', async () => {
    const {client} = createClient(new Error('Connection failed'));

    expect(await client.healthCheck()).toBe(false);
  });
});
