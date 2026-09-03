/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Message,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent} from '../events/event.js';

/** Type alias for A2A stream event data. */
export type A2AStreamEventData =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

/** Per-invocation configuration for the agent card request. */
export interface A2ACardRequestConfig {
  /** Extra HTTP headers to send with the card request. */
  headers?: Record<string, string>;
}

/** Per-invocation configuration for the `message/send` request. */
export interface A2AParametersConfig {
  /** Metadata to attach to the A2A request. */
  requestMetadata?: Record<string, unknown>;
  /**
   * Extra HTTP headers to send with the request.
   *
   * The A2A client carries these as `RequestOptions.serviceParameters`, which
   * every transport writes out as request headers.
   */
  headers?: Record<string, string>;
}

/** Hook that configures the request fetching a remote agent card. */
export interface A2ACardRequestInterceptor {
  /**
   * Returns per-invocation configuration for the agent card request.
   *
   * Called before the card is fetched from an http(s) URL. Headers from each
   * interceptor are merged in list order, so a later interceptor wins a key
   * conflict.
   */
  beforeRequest?(ctx: InvocationContext): Promise<A2ACardRequestConfig>;
}

/** Hook that observes or rewrites an A2A request and its response. */
export interface A2ARequestInterceptor {
  /**
   * Runs before the request is sent.
   *
   * Return an {@link AdkEvent} in place of the request to abort the call and
   * emit that event instead.
   */
  beforeRequest?(
    ctx: InvocationContext,
    request: Message,
    params: A2AParametersConfig,
  ): Promise<{request: Message | AdkEvent; params: A2AParametersConfig}>;

  /**
   * Runs after each response chunk has been converted.
   *
   * Return `undefined` to drop the event. Interceptors run in reverse list
   * order, so the last one registered sees the response first.
   */
  afterRequest?(
    ctx: InvocationContext,
    response: A2AStreamEventData,
    event: AdkEvent,
  ): Promise<AdkEvent | undefined>;
}
