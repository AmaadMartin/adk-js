/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HTTP_EXTENSION_HEADER, Message} from '@a2a-js/sdk';
import {
  A2ACardRequestInterceptor,
  A2AParametersConfig,
  A2ARequestInterceptor,
  A2AStreamEventData,
  Event as AdkEvent,
  createEvent,
  createSession,
  InvocationContext,
  NEW_A2A_ADK_INTEGRATION_EXTENSION,
  newIntegrationExtensionInterceptor,
  PluginManager,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  executeAfterRequestInterceptors,
  executeBeforeCardRequestInterceptors,
  executeBeforeRequestInterceptors,
} from '../../src/a2a/a2a_remote_agent_interceptors.js';

const CTX = new InvocationContext({
  invocationId: 'inv-1',
  pluginManager: new PluginManager([]),
  session: createSession({id: 's-1', appName: 'app-1'}),
});

const RESPONSE: A2AStreamEventData = {
  kind: 'message',
  messageId: 'm-1',
  role: 'agent',
  parts: [{kind: 'text', text: 'hi'}],
};

function message(text: string): Message {
  return {
    kind: 'message',
    messageId: 'm-out',
    role: 'user',
    parts: [{kind: 'text', text}],
  };
}

function headerInterceptor(
  headers: Record<string, string>,
): A2ACardRequestInterceptor {
  return {beforeRequest: async () => ({headers})};
}

describe('executeBeforeCardRequestInterceptors', () => {
  it('returns undefined when there are no interceptors', async () => {
    await expect(
      executeBeforeCardRequestInterceptors(undefined, CTX),
    ).resolves.toBeUndefined();
    await expect(
      executeBeforeCardRequestInterceptors([], CTX),
    ).resolves.toBeUndefined();
  });

  it('returns undefined when no interceptor contributes a header', async () => {
    await expect(
      executeBeforeCardRequestInterceptors(
        [{}, {beforeRequest: async () => ({})}],
        CTX,
      ),
    ).resolves.toBeUndefined();
  });

  it('merges headers, letting a later interceptor win', async () => {
    const merged = await executeBeforeCardRequestInterceptors(
      [
        headerInterceptor({'X-One': 'a', 'X-Two': 'first'}),
        headerInterceptor({'X-Two': 'second'}),
      ],
      CTX,
    );

    expect(merged).toEqual({'X-One': 'a', 'X-Two': 'second'});
  });
});

describe('executeBeforeRequestInterceptors', () => {
  it('returns the request unchanged when there are no interceptors', async () => {
    const request = message('hello');

    const result = await executeBeforeRequestInterceptors(
      undefined,
      CTX,
      request,
    );

    expect(result.request).toBe(request);
    expect(result.params).toEqual({});
  });

  it('threads the request and params through each interceptor', async () => {
    const first: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, request, params) => ({
        request: {...request, messageId: 'rewritten'},
        params: {...params, headers: {'X-One': 'a'}},
      }),
    };
    const second: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, request, params) => ({
        request,
        params: {...params, requestMetadata: {trace: '1'}},
      }),
    };

    const result = await executeBeforeRequestInterceptors(
      [first, {}, second],
      CTX,
      message('hello'),
    );

    expect((result.request as Message).messageId).toBe('rewritten');
    expect(result.params).toEqual({
      headers: {'X-One': 'a'},
      requestMetadata: {trace: '1'},
    });
  });

  it('stops at the first interceptor that returns an event', async () => {
    const replacement = createEvent({author: 'test', errorMessage: 'blocked'});
    const blocking: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, _request, params) => ({
        request: replacement,
        params,
      }),
    };
    let laterRan = false;
    const later: A2ARequestInterceptor = {
      beforeRequest: async (_ctx, request, params) => {
        laterRan = true;
        return {request, params};
      },
    };

    const result = await executeBeforeRequestInterceptors(
      [blocking, later],
      CTX,
      message('hello'),
    );

    expect(result.request).toBe(replacement);
    expect(laterRan).toBe(false);
  });
});

describe('executeAfterRequestInterceptors', () => {
  const event = createEvent({author: 'peer', content: {parts: [{text: 'a'}]}});

  it('returns the event unchanged when there are no interceptors', async () => {
    await expect(
      executeAfterRequestInterceptors(undefined, CTX, RESPONSE, event),
    ).resolves.toBe(event);
  });

  it('skips an interceptor with no afterRequest hook', async () => {
    await expect(
      executeAfterRequestInterceptors([{}], CTX, RESPONSE, event),
    ).resolves.toBe(event);
  });

  it('runs the interceptors in reverse list order', async () => {
    const order: string[] = [];
    const tag = (name: string): A2ARequestInterceptor => ({
      afterRequest: async (_ctx, _response, current) => {
        order.push(name);
        return current;
      },
    });

    await executeAfterRequestInterceptors(
      [tag('first'), tag('second')],
      CTX,
      RESPONSE,
      event,
    );

    expect(order).toEqual(['second', 'first']);
  });

  it('passes the rewritten event to the next interceptor', async () => {
    const replaced = createEvent({author: 'peer', errorMessage: 'rewritten'});
    const rewrite: A2ARequestInterceptor = {
      afterRequest: async () => replaced,
    };
    let seen: AdkEvent | undefined;
    const observe: A2ARequestInterceptor = {
      afterRequest: async (_ctx, _response, current) => {
        seen = current;
        return current;
      },
    };

    const result = await executeAfterRequestInterceptors(
      [observe, rewrite],
      CTX,
      RESPONSE,
      event,
    );

    expect(result).toBe(replaced);
    expect(seen).toBe(replaced);
  });

  it('drops the event when an interceptor returns undefined', async () => {
    const drop: A2ARequestInterceptor = {afterRequest: async () => undefined};
    let laterRan = false;
    const later: A2ARequestInterceptor = {
      afterRequest: async (_ctx, _response, current) => {
        laterRan = true;
        return current;
      },
    };

    const result = await executeAfterRequestInterceptors(
      [later, drop],
      CTX,
      RESPONSE,
      event,
    );

    expect(result).toBeUndefined();
    expect(laterRan).toBe(false);
  });
});

describe('newIntegrationExtensionInterceptor', () => {
  async function run(params: A2AParametersConfig) {
    const result = await newIntegrationExtensionInterceptor.beforeRequest!(
      CTX,
      message('hello'),
      params,
    );
    return result.params.headers?.[HTTP_EXTENSION_HEADER];
  }

  it('adds the extension when no header is set', async () => {
    await expect(run({})).resolves.toBe(NEW_A2A_ADK_INTEGRATION_EXTENSION);
  });

  it('appends to an existing extension list', async () => {
    await expect(
      run({headers: {[HTTP_EXTENSION_HEADER]: 'https://other/ext'}}),
    ).resolves.toBe(`https://other/ext,${NEW_A2A_ADK_INTEGRATION_EXTENSION}`);
  });

  it('trims a spaced list so a re-add does not duplicate', async () => {
    await expect(
      run({
        headers: {
          [HTTP_EXTENSION_HEADER]: `https://other/ext, ${NEW_A2A_ADK_INTEGRATION_EXTENSION}`,
        },
      }),
    ).resolves.toBe(`https://other/ext,${NEW_A2A_ADK_INTEGRATION_EXTENSION}`);
  });

  it('does not duplicate an entry that is already declared', async () => {
    await expect(
      run({
        headers: {[HTTP_EXTENSION_HEADER]: NEW_A2A_ADK_INTEGRATION_EXTENSION},
      }),
    ).resolves.toBe(NEW_A2A_ADK_INTEGRATION_EXTENSION);
  });

  it('leaves the caller params object untouched', async () => {
    const params: A2AParametersConfig = {headers: {'X-One': 'a'}};

    await run(params);

    expect(params.headers).toEqual({'X-One': 'a'});
  });
});
