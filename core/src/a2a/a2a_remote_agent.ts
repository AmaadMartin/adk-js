/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Part as A2APart,
  AGENT_CARD_PATH,
  AgentCard,
  Message,
  MessageSendConfiguration,
  MessageSendParams,
  Task,
  TaskArtifactUpdateEvent,
  TaskStatusUpdateEvent,
} from '@a2a-js/sdk';
import {Client, ClientFactory, RequestOptions} from '@a2a-js/sdk/client';
import {BaseAgent, BaseAgentConfig} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {MessageRole} from './a2a_event.js';
import {
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
  executeAfterRequestInterceptors,
  executeBeforeCardRequestInterceptors,
  executeBeforeRequestInterceptors,
  isA2AMessage,
} from './a2a_remote_agent_interceptors.js';
import {A2ARemoteAgentRunProcessor} from './a2a_remote_agent_run_processor.js';
import {
  getUserFunctionCallAt,
  peerRequestedCallIds,
  toForwardableA2AParts,
  toMissingRemoteSessionParts,
} from './a2a_remote_agent_utils.js';
import {isRemoteCardSource, resolveAgentCard} from './agent_card.js';
import {
  A2AArtifactUpdateToEventConverter,
  A2AEventConverters,
  A2AMessageToEventConverter,
  A2AStatusUpdateToEventConverter,
  A2ATaskToEventConverter,
  toAdkEvent,
} from './event_converter_utils.js';
import {getA2ASessionMetadata} from './metadata_converter_utils.js';
import {A2APartToGenAIPartConverter} from './part_converter_utils.js';

export {AGENT_CARD_PATH};

/**
 * Type alias for A2A stream event data.
 */
export type A2AStreamEventData =
  | Message
  | Task
  | TaskStatusUpdateEvent
  | TaskArtifactUpdateEvent;

/**
 * Callback called before sending a request to the remote agent.
 * Allows modifying the request parameters.
 *
 * @param ctx - The current invocation context, providing access to session
 *   state, agent metadata, and services.
 * @param params - The A2A message send parameters that will be sent to the
 *   remote agent. Mutations to this object are reflected in the outgoing
 *   request.
 * @returns A Promise or void. Returning a rejected Promise aborts the request.
 */
export type BeforeA2ARequestCallback = (
  ctx: InvocationContext,
  params: MessageSendParams,
) => Promise<void> | void;

/**
 * Callback called after receiving a response from the remote agent.
 * Allows inspecting or modifying the response.
 *
 * @param ctx - The current invocation context, providing access to session
 *   state, agent metadata, and services.
 * @param resp - The raw A2A stream event data received from the remote agent,
 *   before conversion to an ADK event.
 * @returns A Promise or void. Returning a rejected Promise stops further
 *   processing of the response.
 */
export type AfterA2ARequestCallback = (
  ctx: InvocationContext,
  resp: A2AStreamEventData,
) => Promise<void> | void;

/**
 * Configuration for the A2ARemoteAgent.
 */
export interface RemoteA2AAgentConfig extends BaseAgentConfig {
  /**
   * Loaded AgentCard or URL to AgentCard.
   */
  agentCard?: AgentCard | string;

  /**
   * Optional pre-initialized Client for connection pooling.
   */
  client?: Client;

  /**
   * Optional ClientFactory for creating the A2A Client.
   */
  clientFactory?: ClientFactory;
  /**
   * Optional default configuration for sending messages.
   */
  messageSendConfig?: MessageSendConfiguration;
  /**
   * Callbacks run before the remote request is sent.
   */
  beforeRequestCallbacks?: BeforeA2ARequestCallback[];
  /**
   * Callbacks run after receiving a response chunk or event, before conversion.
   */
  afterRequestCallbacks?: AfterA2ARequestCallback[];
  /**
   * Optional request-level metadata to include in the A2A message send request.
   * If omitted, defaults to `context.a2aMetadata` from the current invocation context.
   */
  metadata?: Record<string, unknown>;

  /** Converts an A2A Message of the response. Defaults to the built-in one. */
  a2aMessageConverter?: A2AMessageToEventConverter;

  /** Converts an A2A Task of the response. Defaults to the built-in one. */
  a2aTaskConverter?: A2ATaskToEventConverter;

  /** Converts an A2A status update. Defaults to the built-in one. */
  a2aStatusUpdateConverter?: A2AStatusUpdateToEventConverter;

  /** Converts an A2A artifact update. Defaults to the built-in one. */
  a2aArtifactUpdateConverter?: A2AArtifactUpdateToEventConverter;

  /**
   * Converts an individual A2A part of the response. Handed to whichever
   * converter above runs. Defaults to `toGenAIPart`.
   */
  a2aPartConverter?: A2APartToGenAIPartConverter;

  /** Interceptors around the A2A message send. */
  requestInterceptors?: A2ARequestInterceptor[];

  /** Interceptors around the remote agent card fetch. */
  cardRequestInterceptors?: A2ACardRequestInterceptor[];
}

/**
 * RemoteA2AAgent delegates execution to a remote agent using the A2A protocol.
 *
 * @remarks
 * A cloned `RemoteA2AAgent` (via {@link BaseAgent.clone}) is a fresh,
 * uninitialized instance that re-resolves its client and card on first use.
 */
export class RemoteA2AAgent extends BaseAgent<RemoteA2AAgentConfig> {
  private client?: Client;
  private card?: AgentCard;
  private isInitialized = false;

  constructor(private readonly a2aConfig: RemoteA2AAgentConfig) {
    super(a2aConfig);
    if (!a2aConfig.agentCard && !a2aConfig.client) {
      throw new Error('Either AgentCard or Client must be provided');
    }
  }

  private async init(context: InvocationContext) {
    if (this.isInitialized) {
      return;
    }

    if (this.a2aConfig.client) {
      this.client = this.a2aConfig.client;
    }

    if (this.a2aConfig.agentCard) {
      this.card = await this.resolveCard(this.a2aConfig.agentCard, context);

      if (!this.client) {
        const factory = this.a2aConfig.clientFactory || new ClientFactory();
        this.client = await factory.createFromAgentCard(this.card);
      }
    }

    this.isInitialized = true;
  }

  /**
   * Fetches the card, letting the card interceptors add headers for this
   * invocation. They are consulted only for an `http(s)` source: a card object
   * and a file path never reach the network.
   */
  private async resolveCard(
    source: AgentCard | string,
    context: InvocationContext,
  ): Promise<AgentCard> {
    const headers =
      typeof source === 'string' && isRemoteCardSource(source)
        ? await executeBeforeCardRequestInterceptors(
            this.a2aConfig.cardRequestInterceptors,
            context,
          )
        : undefined;
    return resolveAgentCard(source, {headers});
  }

  /**
   * Returns the client and the card to use for this invocation.
   *
   * Per the A2A specification an authenticated agent card is scoped to one
   * authenticated session, so when card interceptors are configured for a URL
   * source the card and the client are built per invocation and kept local.
   * That stops one session's authenticated card leaking into another.
   */
  private async ensureResolved(
    context: InvocationContext,
  ): Promise<{client: Client; card?: AgentCard}> {
    const source = this.a2aConfig.agentCard;
    if (
      typeof source === 'string' &&
      isRemoteCardSource(source) &&
      this.a2aConfig.cardRequestInterceptors?.length
    ) {
      const card = await this.resolveCard(source, context);
      const factory = this.a2aConfig.clientFactory || new ClientFactory();
      const client =
        this.a2aConfig.client ?? (await factory.createFromAgentCard(card));
      return {client, card};
    }

    await this.init(context);
    // The constructor rejects a config with neither a card nor a client, so
    // init() always leaves one behind.
    return {client: this.client!, card: this.card};
  }

  /** Converts one response frame and runs the after-request hooks over it. */
  private async toEmittableEvent(
    context: InvocationContext,
    chunk: A2AStreamEventData,
    converters: A2AEventConverters,
  ): Promise<AdkEvent | undefined> {
    const converted = toAdkEvent(
      chunk,
      context.invocationId,
      this.name,
      context.branch,
      converters,
    );
    return converted
      ? executeAfterRequestInterceptors(
          this.a2aConfig.requestInterceptors,
          context,
          chunk,
          converted,
        )
      : undefined;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    const {client, card} = await this.ensureResolved(context);

    try {
      // 1. Convert current ADK state to A2A Message
      const events = context.session.events;
      if (events.length === 0) {
        throw new Error('No events in session to send');
      }

      const userFnCall = getUserFunctionCallAt(
        context.session,
        events.length - 1,
      );
      let parts: A2APart[];
      let taskId: string | undefined = undefined;
      let contextId: string | undefined = undefined;

      if (userFnCall) {
        const event = userFnCall.response;
        // Route through the shared scrub: this credential response must not
        // cross the trust boundary unless its id is one the peer itself
        // exclusively requested. Computed over the full session, not just
        // this one response event: an id counts as peer-requested only if
        // EVERY event that issued a call for it was authored by the peer,
        // so the check needs the whole history to catch a local request
        // whose id the peer's own event reuses.
        const peerRequestedIds = peerRequestedCallIds(events, this.name);
        parts = toForwardableA2AParts(
          event.content,
          event.longRunningToolIds,
          peerRequestedIds,
        );
        taskId = userFnCall.taskId;
        contextId = userFnCall.contextId;
      } else {
        const missing = toMissingRemoteSessionParts(context, context.session);
        parts = missing.parts;
        contextId = missing.contextId;
      }

      const message: Message = {
        kind: 'message',
        messageId: randomUUID(),
        role: MessageRole.USER,
        parts,
        metadata: getA2ASessionMetadata({
          appName: context.session.appName,
          userId: context.session.userId,
          sessionId: context.session.id,
        }),
      };
      if (taskId) message.taskId = taskId;
      if (contextId) message.contextId = contextId;

      const metadata = this.a2aConfig.metadata ?? context.a2aMetadata;
      const params: MessageSendParams = {
        message,
        configuration: this.a2aConfig.messageSendConfig,
        ...(metadata ? {metadata} : {}),
      };

      const processor = new A2ARemoteAgentRunProcessor(params);

      if (this.a2aConfig.beforeRequestCallbacks) {
        for (const callback of this.a2aConfig.beforeRequestCallbacks) {
          await callback(context, params);
        }
      }

      const intercepted = await executeBeforeRequestInterceptors(
        this.a2aConfig.requestInterceptors,
        context,
        params.message,
      );
      if (!isA2AMessage(intercepted.request)) {
        yield intercepted.request;
        return;
      }
      params.message = intercepted.request;
      if (intercepted.params.requestMetadata) {
        params.metadata = intercepted.params.requestMetadata;
      }
      // Spread rather than passed positionally: with no interceptor headers
      // the send keeps its single-argument shape, so nothing downstream sees a
      // trailing `undefined` it did not see before.
      const sendOptions: [RequestOptions] | [] = intercepted.params.headers
        ? [{serviceParameters: intercepted.params.headers}]
        : [];

      const converters: A2AEventConverters = {
        message: this.a2aConfig.a2aMessageConverter,
        task: this.a2aConfig.a2aTaskConverter,
        statusUpdate: this.a2aConfig.a2aStatusUpdateConverter,
        artifactUpdate: this.a2aConfig.a2aArtifactUpdateConverter,
        part: this.a2aConfig.a2aPartConverter,
      };

      const useStreaming = card ? card.capabilities?.streaming !== false : true;
      if (useStreaming) {
        for await (const chunk of client.sendMessageStream(
          params,
          ...sendOptions,
        )) {
          if (this.a2aConfig.afterRequestCallbacks) {
            for (const callback of this.a2aConfig.afterRequestCallbacks) {
              await callback(context, chunk);
            }
          }

          const adkEvent = await this.toEmittableEvent(
            context,
            chunk,
            converters,
          );
          if (!adkEvent) {
            continue;
          }

          processor.updateCustomMetadata(adkEvent, chunk);

          const eventsToEmit = processor.aggregatePartial(
            context,
            chunk,
            adkEvent,
          );
          for (const ev of eventsToEmit) {
            yield ev;
          }
        }
      } else {
        const result = await client.sendMessage(params, ...sendOptions);
        if (this.a2aConfig.afterRequestCallbacks) {
          for (const callback of this.a2aConfig.afterRequestCallbacks) {
            await callback(context, result);
          }
        }
        const adkEvent = await this.toEmittableEvent(
          context,
          result,
          converters,
        );
        if (adkEvent) {
          processor.updateCustomMetadata(adkEvent, result);
          yield adkEvent;
        }
      }
    } catch (e: unknown) {
      const error = e as Error;
      logger.error(`A2ARemoteAgent ${this.name} failed:`, error);

      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        errorMessage: error.message,
        turnComplete: true,
      });
    }
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Live mode is not supported in A2ARemoteAgent yet.');
  }
}
