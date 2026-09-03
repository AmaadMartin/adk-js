/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message} from '@a2a-js/sdk';
import {ClientCallContext, ServiceParameters} from '@a2a-js/sdk/client';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent} from '../events/event.js';
import {A2AEvent} from './a2a_event.js';

export type {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
} from './part_converter_utils.js';

/**
 * The extension URI a client sends to ask the server for the new ADK
 * integration, and that the server echoes on a response built with it.
 *
 * Wire value, kept byte for byte in step with `google/adk-python`
 * `a2a/agent/interceptors/new_integration_extension.py`.
 */
export const NEW_A2A_ADK_INTEGRATION_EXTENSION =
  'https://google.github.io/adk-docs/a2a/a2a-extension/';

/** Per-call parameters carried alongside an outbound A2A request. */
export interface A2ARequestParameters {
  /** Context handed to the A2A client for this call. */
  clientCallContext?: ClientCallContext;
  /** Transport parameters; carried as HTTP headers by the JSON-RPC transport. */
  serviceParameters?: ServiceParameters;
  /** Metadata merged into the outgoing `MessageSendParams`. */
  requestMetadata?: Record<string, unknown>;
}

/** Interceptor around the remote agent invocation call. */
export interface A2ARequestInterceptor {
  /**
   * Runs before the request is sent.
   *
   * @param ctx - The current invocation context.
   * @param request - The A2A message about to be sent.
   * @param params - The parameters accumulated by earlier interceptors.
   * @returns The message to send and the parameters to carry forward.
   *   Returning an ADK `Event` instead of a message aborts the call and emits
   *   that event to the caller.
   */
  beforeRequest?: (
    ctx: InvocationContext,
    request: Message,
    params: A2ARequestParameters,
  ) => Promise<[Message | AdkEvent, A2ARequestParameters]>;

  /**
   * Runs after a response chunk is converted to an ADK event.
   *
   * @param ctx - The current invocation context.
   * @param response - The raw A2A response the event was converted from.
   * @param event - The converted ADK event.
   * @returns The event to emit, or `undefined` to drop it.
   */
  afterRequest?: (
    ctx: InvocationContext,
    response: A2AEvent,
    event: AdkEvent,
  ) => Promise<AdkEvent | undefined>;
}

/** Configuration for the HTTP request that fetches a remote agent card. */
export interface A2ACardRequestConfig {
  /** Extra HTTP headers to include in the card request. */
  headers?: Record<string, string>;
}

/**
 * Interceptor for the remote agent card fetch only.
 *
 * Ignored for a loaded `AgentCard` and for a file-path source, neither of
 * which reaches the network.
 */
export interface A2ACardRequestInterceptor {
  beforeRequest?: (ctx: InvocationContext) => Promise<A2ACardRequestConfig>;
}
