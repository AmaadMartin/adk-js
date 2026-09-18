/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message} from '@a2a-js/sdk';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent} from '../events/event.js';
import type {A2AStreamEventData} from './a2a_remote_agent.js';

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
 * Whether a before-request hook returned an A2A message rather than an event
 * that aborts the send. Reads the message's `kind` discriminator rather than
 * testing the prototype, so it holds across package copies.
 */
export function isA2AMessage(value: Message | AdkEvent): value is Message {
  return 'kind' in value && value.kind === 'message';
}

/**
 * Merges the card-request headers every interceptor asks for, in list order so
 * a later interceptor wins a conflict.
 *
 * @param interceptors The card interceptors to run, if there are any.
 * @param ctx The invocation the card is fetched for, if there is one.
 * @returns The merged headers, or `undefined` when there are none.
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
 *
 * @param interceptors The request interceptors to run, if there are any.
 * @param ctx The invocation the request belongs to.
 * @param request The request the agent built.
 * @returns The request to send, or the event that aborts the send.
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
 * @param interceptors The request interceptors to run, if there are any.
 * @param ctx The invocation the response belongs to.
 * @param response The A2A response frame the event was built from.
 * @param event The event the converters produced.
 * @returns The event to emit, or `undefined` when an interceptor dropped it.
 */
export async function executeAfterRequestInterceptors(
  interceptors: A2ARequestInterceptor[] | undefined,
  ctx: InvocationContext,
  response: A2AStreamEventData,
  event: AdkEvent,
): Promise<AdkEvent | undefined> {
  let current = event;
  for (const interceptor of [...(interceptors ?? [])].reverse()) {
    if (!interceptor.afterRequest) {
      continue;
    }
    const result = await interceptor.afterRequest(ctx, response, current);
    if (!result) {
      return undefined;
    }
    current = result;
  }
  return current;
}
