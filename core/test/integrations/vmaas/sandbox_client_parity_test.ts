/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The adk-python reference tests for `SandboxClient`, ported to TypeScript.
 * Each `it(...)` keeps its Python name verbatim, so a reviewer can match the
 * two suites by grep.
 *
 * Source: adk-python `main`,
 * `tests/unittests/integrations/vmaas/test_sandbox_client.py`.
 *
 * Four of the 21 reference tests are not ported. `test_update_access_token`
 * and the three `test_health_check_*` tests cover `update_access_token` and
 * `health_check`, which no caller reaches in either SDK: adk-python's
 * `sandbox_computer.py` calls neither, and this port builds a fresh client per
 * action, so a token can never be replaced on a live one. Both methods were
 * dropped rather than shipped as public surface nothing calls.
 *
 * adk-python patches `asyncio.to_thread` and reads the keyword arguments it
 * received. adk-js has no `to_thread`, so the tests read the requests the
 * injected `sendCommand` transport received instead.
 */

import {CdpCommand, SandboxClient} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';

import {SandboxCall} from './vmaas_test_utils.js';

const ACCESS_TOKEN = 'test_token_12345';
const SANDBOX = {name: 'projects/test/sandboxEnvironments/123'};

/** Builds a transport that answers every request with the same JSON body. */
function respondWith(payload: Record<string, unknown>) {
  return vi.fn(async (_params: SandboxCall) => ({
    body: JSON.stringify(payload),
  }));
}

/** The commands carried by the batch request recorded in `call`. */
function batchCommandsOf(call: SandboxCall): CdpCommand[] {
  return call.requestBody?.['commands'] as CdpCommand[];
}

describe('SandboxClient parity with adk-python', () => {
  let sendCommand: ReturnType<typeof respondWith>;
  let client: SandboxClient;

  /** Builds a client whose transport answers with `payload`. */
  function clientRespondingWith(payload: Record<string, unknown>) {
    sendCommand = respondWith(payload);
    return new SandboxClient({
      sandbox: SANDBOX,
      accessToken: ACCESS_TOKEN,
      sendCommand,
    });
  }

  beforeEach(() => {
    client = clientRespondingWith({});
  });

  it('test_init', async () => {
    await client.makeCdpRequest('Page.reload');

    expect(sendCommand).toHaveBeenCalledWith(
      expect.objectContaining({accessToken: ACCESS_TOKEN, sandbox: SANDBOX}),
    );
  });

  it('test_make_cdp_request', async () => {
    client = clientRespondingWith({result: 'success'});

    const result = await client.makeCdpRequest('Page.navigate', {
      url: 'https://example.com',
    });

    expect(result).toEqual({result: 'success'});
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand).toHaveBeenCalledWith({
      httpMethod: 'POST',
      path: 'cdp',
      accessToken: ACCESS_TOKEN,
      sandbox: SANDBOX,
      requestBody: {
        command: 'Page.navigate',
        params: {url: 'https://example.com'},
      },
    });
  });

  it('test_make_cdp_batch_request_with_batch_endpoint', async () => {
    client = clientRespondingWith({
      results: [{status: 'success'}, {status: 'success'}],
    });
    const commands: CdpCommand[] = [
      {
        command: 'Input.dispatchMouseEvent',
        params: {type: 'mousePressed'},
      },
      {
        command: 'Input.dispatchMouseEvent',
        params: {type: 'mouseReleased'},
      },
    ];

    const result = await client.makeCdpBatchRequest(commands);

    expect(result).toHaveLength(2);
    expect(sendCommand).toHaveBeenCalledTimes(1);
    expect(sendCommand.mock.calls[0][0]).toMatchObject({path: 'cdps'});
  });

  it('test_make_cdp_batch_request_fallback_sequential', async () => {
    const transport = vi.fn(async (params: SandboxCall) => {
      if (params.path === 'cdps') {
        throw new Error('404 Not Found');
      }
      return {body: JSON.stringify({result: 'ok'})};
    });
    client = new SandboxClient({
      sandbox: SANDBOX,
      accessToken: ACCESS_TOKEN,
      sendCommand: transport,
    });

    const result = await client.makeCdpBatchRequest([
      {command: 'Command1', params: {}},
      {command: 'Command2', params: {}},
    ]);

    expect(result).toEqual([
      {status: 'success', result: {result: 'ok'}, error: undefined},
      {status: 'success', result: {result: 'ok'}, error: undefined},
    ]);
    expect(transport).toHaveBeenCalledTimes(3);
  });

  it('test_get_screenshot', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    client = clientRespondingWith({
      data: Buffer.from(pngBytes).toString('base64'),
    });

    const result = await client.getScreenshot();

    expect(Array.from(result)).toEqual(Array.from(pngBytes));
    expect(sendCommand.mock.calls[0][0]).toMatchObject({
      requestBody: {command: 'Page.captureScreenshot'},
    });
  });

  it('test_get_current_url', async () => {
    client = clientRespondingWith({
      active_tab_id: 'tab1',
      all_tabs: [{id: 'tab1', url: 'https://example.com', title: 'Example'}],
    });

    const result = await client.getCurrentUrl();

    expect(result).toBe('https://example.com');
    expect(sendCommand.mock.calls[0][0]).toMatchObject({
      path: 'tabs',
      httpMethod: 'GET',
    });
  });

  it('test_get_current_url_no_active_tab', async () => {
    client = clientRespondingWith({active_tab_id: null, all_tabs: []});

    expect(await client.getCurrentUrl()).toBeUndefined();
  });

  it('test_navigate', async () => {
    client = clientRespondingWith({frameId: 'frame123'});

    const result = await client.navigate('https://example.com');

    expect(result).toEqual({frameId: 'frame123'});
    expect(sendCommand.mock.calls[0][0]).toMatchObject({
      requestBody: {
        command: 'Page.navigate',
        params: {url: 'https://example.com'},
      },
    });
  });

  it('test_click_at', async () => {
    client = clientRespondingWith({results: [{}, {}]});

    await client.clickAt(100, 200);

    const call = sendCommand.mock.calls[0][0];
    expect(call).toMatchObject({path: 'cdps'});
    const commands = batchCommandsOf(call);
    expect(commands).toHaveLength(2);
    expect(commands[0].params['type']).toBe('mousePressed');
    expect(commands[1].params['type']).toBe('mouseReleased');
  });

  it('test_hover_at', async () => {
    await client.hoverAt(150, 250);

    expect(sendCommand.mock.calls[0][0].requestBody?.['params']).toEqual({
      type: 'mouseMoved',
      x: 150,
      y: 250,
    });
  });

  it('test_scroll_at_down', async () => {
    await client.scrollAt({x: 100, y: 200, direction: 'down', magnitude: 300});

    expect(sendCommand.mock.calls[0][0].requestBody?.['params']).toEqual({
      type: 'mouseWheel',
      x: 100,
      y: 200,
      deltaX: 0,
      deltaY: 300,
    });
  });

  it('test_scroll_at_up', async () => {
    await client.scrollAt({x: 100, y: 200, direction: 'up', magnitude: 300});

    expect(sendCommand.mock.calls[0][0].requestBody?.['params']).toMatchObject({
      deltaY: -300,
    });
  });

  it('test_go_back', async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce({
        body: JSON.stringify({
          currentIndex: 1,
          entries: [
            {id: 1, url: 'https://first.com'},
            {id: 2, url: 'https://second.com'},
          ],
        }),
      })
      .mockResolvedValueOnce({body: JSON.stringify({})});
    client = new SandboxClient({
      sandbox: SANDBOX,
      accessToken: ACCESS_TOKEN,
      sendCommand: transport,
    });

    expect(await client.goBack()).toBe(true);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][0].requestBody).toEqual({
      command: 'Page.navigateToHistoryEntry',
      params: {entryId: 1},
    });
  });

  it('test_go_back_at_beginning', async () => {
    client = clientRespondingWith({
      currentIndex: 0,
      entries: [{id: 1, url: 'https://first.com'}],
    });

    expect(await client.goBack()).toBe(false);
    expect(sendCommand).toHaveBeenCalledTimes(1);
  });

  it('test_type_text_with_clear_and_enter', async () => {
    client = clientRespondingWith({results: []});

    await client.typeText('hello', true, true);

    expect(batchCommandsOf(sendCommand.mock.calls[0][0])).toHaveLength(7);
  });

  it('test_key_combination', async () => {
    client = clientRespondingWith({results: []});

    await client.keyCombination(['control', 'c']);

    expect(batchCommandsOf(sendCommand.mock.calls[0][0])).toHaveLength(4);
  });

  it('test_drag_and_drop', async () => {
    client = clientRespondingWith({results: []});

    await client.dragAndDrop({
      x: 10,
      y: 20,
      destinationX: 100,
      destinationY: 200,
    });

    expect(batchCommandsOf(sendCommand.mock.calls[0][0])).toHaveLength(4);
  });
});
