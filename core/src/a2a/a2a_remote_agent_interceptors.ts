/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {HTTP_EXTENSION_HEADER, Message} from '@a2a-js/sdk';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent} from '../events/event.js';
import type {A2AStreamEventData} from './a2a_remote_agent.js';

/**
 * Extension URI that tells an ADK A2A server to use its new agent integration.
 * Sent when {@link RemoteA2AAgentConfig.useLegacy} is `false`.
 */
export const NEW_A2A_ADK_INTEGRATION_EXTENSION =
  'https://google.github.io/adk-docs/a2a/a2a-extension/';

/** Per-request parameters an interceptor may modify before the send. */
export interface A2ARequestParameters {
  /** Request-level metadata to attach to the A2A send. */
  requestMetadata?: Record<string, unknown>;
  /** HTTP headers to send with the A2A request. */
  headers?: Record<string, string>;
}

/** Configuration for the HTTP request that fetches a remote agent card. */
export interface A2ACardRequestConfig {
  /** Extra HTTP headers to include in the card request. */
  headers?: Record<string, string>;
}

/** The outcome of the before-request hooks: a request to send, or an abort. */
export interface A2ABeforeRequestResult {
  /** The request to send, or an {@link AdkEvent} that aborts the send. */
  request: Message | AdkEvent;
  /** The parameters the send runs with. */
  params: A2ARequestParameters;
}

/** Interceptor for the remote agent card fetch. */
export interface A2ACardRequestInterceptor {
  /**
   * Returns per-invocation configuration for the card request. Called before
   * fetching the card from an `http(s)` URL. Ignored for a card object or a
   * file path.
   */
  beforeRequest?(ctx: InvocationContext): Promise<A2ACardRequestConfig>;
}

/** Interceptor for the A2A message send. */
export interface A2ARequestInterceptor {
  /**
   * Runs before the request is sent. Returning an {@link AdkEvent} as the
   * request aborts the send, and that event is yielded to the caller.
   */
  beforeRequest?(
    ctx: InvocationContext,
    request: Message,
    params: A2ARequestParameters,
  ): Promise<A2ABeforeRequestResult>;

  /**
   * Runs after a response has been converted to an event. Returning
   * `undefined` drops the event.
   */
  afterRequest?(
    ctx: InvocationContext,
    response: A2AStreamEventData,
    event: AdkEvent,
  ): Promise<AdkEvent | undefined>;
}

/**
 * Merges the card-request headers every interceptor asks for, in list order so
 * a later interceptor wins a conflict.
 *
 * @return The merged headers, or `undefined` when there are none.
 */
export async function executeBeforeCardRequestInterceptors(
  interceptors: A2ACardRequestInterceptor[] | undefined,
  ctx: InvocationContext | undefined,
): Promise<Record<string, string> | undefined> {
  const headers: Record<string, string> = {};
  if (interceptors && ctx) {
    for (const interceptor of interceptors) {
      if (!interceptor.beforeRequest) {
        continue;
      }
      const config = await interceptor.beforeRequest(ctx);
      Object.assign(headers, config.headers);
    }
  }
  return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * Runs the before-request hooks in list order, stopping at the first one that
 * returns an event instead of a request.
 */
export async function executeBeforeRequestInterceptors(
  interceptors: A2ARequestInterceptor[] | undefined,
  ctx: InvocationContext,
  request: Message,
): Promise<A2ABeforeRequestResult> {
  let current = request;
  let params: A2ARequestParameters = {};
  for (const interceptor of interceptors ?? []) {
    if (!interceptor.beforeRequest) {
      continue;
    }
    const result = await interceptor.beforeRequest(ctx, current, params);
    params = result.params;
    if (!isA2AMessage(result.request)) {
      return {request: result.request, params};
    }
    current = result.request;
  }
  return {request: current, params};
}

/**
 * Runs the after-request hooks in reverse list order, so the interceptor that
 * shaped the request last sees the response first.
 *
 * @return The event to emit, or `undefined` when an interceptor dropped it.
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
 * Whether a before-request hook returned an A2A message rather than an event
 * that aborts the send. Reads the message's `kind` discriminator rather than
 * testing the prototype, so it holds across package copies.
 */
export function isA2AMessage(value: Message | AdkEvent): value is Message {
  return 'kind' in value && value.kind === 'message';
}

/**
 * Interceptor that asks an ADK A2A server to use its new agent integration, by
 * adding {@link NEW_A2A_ADK_INTEGRATION_EXTENSION} to the A2A extension header.
 */
export const newIntegrationExtensionInterceptor: A2ARequestInterceptor = {
  async beforeRequest(_ctx, request, params) {
    const declared = (params.headers?.[HTTP_EXTENSION_HEADER] ?? '')
      .split(',')
      .filter((extension) => extension);
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
