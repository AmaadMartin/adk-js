/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HTTP_EXTENSION_HEADER, Message} from '@a2a-js/sdk';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent} from '../events/event.js';
import {
  A2ACardRequestInterceptor,
  A2AParametersConfig,
  A2ARequestInterceptor,
  A2AStreamEventData,
} from './a2a_remote_agent_config.js';

/**
 * The A2A extension a client advertises to ask the server for the new ADK
 * integration rather than the legacy one.
 */
export const NEW_A2A_ADK_INTEGRATION_EXTENSION =
  'https://google.github.io/adk-docs/a2a/a2a-extension/';

/** Adds {@link NEW_A2A_ADK_INTEGRATION_EXTENSION} to the extension header. */
export const newIntegrationExtensionInterceptor: A2ARequestInterceptor = {
  async beforeRequest(
    _ctx: InvocationContext,
    request: Message,
    params: A2AParametersConfig,
  ) {
    const declared = (params.headers?.[HTTP_EXTENSION_HEADER] ?? '')
      .split(',')
      .filter(Boolean);
    if (!declared.includes(NEW_A2A_ADK_INTEGRATION_EXTENSION)) {
      declared.push(NEW_A2A_ADK_INTEGRATION_EXTENSION);
    }
    return {
      request,
      params: {
        ...params,
        headers: {
          ...params.headers,
          [HTTP_EXTENSION_HEADER]: declared.join(','),
        },
      },
    };
  },
};

/**
 * Merges the card request headers every interceptor contributes.
 *
 * Later interceptors win a key conflict.
 *
 * @returns The merged headers, or `undefined` when there are none.
 */
export async function executeBeforeCardRequestInterceptors(
  interceptors: A2ACardRequestInterceptor[] | undefined,
  ctx: InvocationContext,
): Promise<Record<string, string> | undefined> {
  let headers: Record<string, string> | undefined;
  for (const interceptor of interceptors ?? []) {
    if (!interceptor.beforeRequest) {
      continue;
    }
    const config = await interceptor.beforeRequest(ctx);
    if (config?.headers) {
      headers = {...headers, ...config.headers};
    }
  }
  return headers;
}

/**
 * Runs the `beforeRequest` hooks in list order.
 *
 * Stops at the first interceptor that returns an {@link AdkEvent}; the caller
 * emits that event instead of sending the request.
 */
export async function executeBeforeRequestInterceptors(
  interceptors: A2ARequestInterceptor[] | undefined,
  ctx: InvocationContext,
  request: Message,
): Promise<{request: Message | AdkEvent; params: A2AParametersConfig}> {
  let params: A2AParametersConfig = {};
  let current: Message = request;
  for (const interceptor of interceptors ?? []) {
    if (!interceptor.beforeRequest) {
      continue;
    }
    const result = await interceptor.beforeRequest(ctx, current, params);
    params = result.params;
    if (isAdkEvent(result.request)) {
      return {request: result.request, params};
    }
    current = result.request;
  }
  return {request: current, params};
}

/**
 * Runs the `afterRequest` hooks in reverse list order.
 *
 * @returns The event to emit, or `undefined` when an interceptor dropped it.
 */
export async function executeAfterRequestInterceptors(
  interceptors: A2ARequestInterceptor[] | undefined,
  ctx: InvocationContext,
  response: A2AStreamEventData,
  event: AdkEvent,
): Promise<AdkEvent | undefined> {
  let current: AdkEvent | undefined = event;
  for (const interceptor of [...(interceptors ?? [])].reverse()) {
    if (!interceptor.afterRequest) {
      continue;
    }
    current = await interceptor.afterRequest(ctx, response, current);
    if (!current) {
      return undefined;
    }
  }
  return current;
}

/**
 * Whether an interceptor returned an ADK event in place of the request.
 *
 * An A2A `Message` always carries `kind: 'message'`, so the absence of a
 * `kind` identifies the ADK event. Not `instanceof`: an ADK event is a plain
 * object, and two copies of this package in one runtime would break identity
 * checks anyway.
 */
function isAdkEvent(value: Message | AdkEvent): value is AdkEvent {
  return !('kind' in value);
}
