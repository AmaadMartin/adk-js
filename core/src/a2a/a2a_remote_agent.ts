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
} from '@a2a-js/sdk';
import {Client, ClientFactory, RequestOptions} from '@a2a-js/sdk/client';
import {BaseAgent, BaseAgentConfig} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {createLinkedAbort} from '../utils/abort_utils.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {MessageRole} from './a2a_event.js';
import {
  buildRemoteAuthConfig,
  resolveRemoteAuth,
} from './a2a_remote_agent_auth.js';
import {
  A2ACardRequestInterceptor,
  A2AParametersConfig,
  A2ARequestInterceptor,
  A2AStreamEventData,
} from './a2a_remote_agent_config.js';
import {
  executeAfterRequestInterceptors,
  executeBeforeCardRequestInterceptors,
  executeBeforeRequestInterceptors,
  newIntegrationExtensionInterceptor,
} from './a2a_remote_agent_interceptors.js';
import {A2ARemoteAgentRunProcessor} from './a2a_remote_agent_run_processor.js';
import {
  getUserFunctionCallAt,
  peerRequestedCallIds,
  toForwardableA2AParts,
  toMissingRemoteSessionParts,
} from './a2a_remote_agent_utils.js';
import {adoptedCardDescription, resolveAgentCard} from './agent_card.js';
import {validateAgentCard} from './agent_card_validation.js';
import {toAdkEvent} from './event_converter_utils.js';
import {getA2ASessionMetadata} from './metadata_converter_utils.js';
import {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
} from './part_converter_utils.js';

export {AGENT_CARD_PATH};
export type {A2AStreamEventData};

/** Deadline applied to a remote A2A call when the caller sets none. */
export const DEFAULT_A2A_TIMEOUT_MS = 600_000;

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

/** Builds the metadata attached to one outgoing A2A request. */
export type A2ARequestMetaProvider = (
  ctx: InvocationContext,
  request: Message,
) => Record<string, unknown>;

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
  /**
   * Deadline for the card fetch and the remote call, in milliseconds.
   * Defaults to {@link DEFAULT_A2A_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /** `fetch` implementation used to fetch the agent card. */
  fetchImpl?: typeof fetch;
  /** Converter for a single outbound part. */
  genaiPartConverter?: GenAIPartToA2APartConverter;
  /** Converter for a single inbound part. */
  a2aPartConverter?: A2APartToGenAIPartConverter;
  /**
   * Send the whole session on every request when the peer is stateless.
   * Defaults to `false`.
   */
  fullHistoryWhenStateless?: boolean;
  /** Hooks around the `message/send` request. */
  requestInterceptors?: A2ARequestInterceptor[];
  /** Hooks around the agent card request. */
  cardRequestInterceptors?: A2ACardRequestInterceptor[];
  /**
   * Ask the server for the new ADK integration by advertising the A2A
   * extension. Defaults to `true`, which keeps the legacy integration.
   */
  useLegacy?: boolean;
  /** Scheme used to authenticate the calls to the remote agent. */
  authScheme?: AuthScheme;
  /** Credential for `authScheme`. Ignored when `authScheme` is unset. */
  authCredential?: AuthCredential;
  /**
   * Key the resolved credential is stored under. Derived from the agent name
   * when omitted. Ignored when `authScheme` is unset.
   */
  credentialKey?: string;
  /** Builds the metadata attached to one outgoing A2A request. */
  a2aRequestMetaProvider?: A2ARequestMetaProvider;
}

/**
 * RemoteA2AAgent delegates execution to a remote agent using the A2A protocol.
 *
 * @remarks
 * A cloned `RemoteA2AAgent` (via {@link BaseAgent.clone}) is a fresh,
 * uninitialized instance that re-resolves its client and card on first use.
 *
 * When `authScheme` is set, the credential is resolved once per invocation and
 * sent on both the agent card request and the message send. When no credential
 * is available the agent emits a credential request and ends the invocation, so
 * the client can collect one and the next turn resumes.
 */
export class RemoteA2AAgent extends BaseAgent<RemoteA2AAgentConfig> {
  private client?: Client;
  private card?: AgentCard;
  private readonly cardSource?: string;
  private readonly authConfig?: AuthConfig;
  private readonly requestInterceptors?: A2ARequestInterceptor[];
  private closed = false;

  constructor(private readonly a2aConfig: RemoteA2AAgentConfig) {
    super(a2aConfig);
    const {agentCard} = a2aConfig;
    if (!agentCard && !a2aConfig.client) {
      throw new Error('Either AgentCard or Client must be provided');
    }

    this.client = a2aConfig.client;
    if (typeof agentCard === 'string') {
      if (!agentCard.trim()) {
        throw new Error('agentCard string cannot be empty');
      }
      this.cardSource = agentCard.trim();
    } else if (agentCard) {
      // A card supplied directly never goes through resolution, so its
      // description is adopted here. A parent agent reads the description to
      // build its transfer instruction, before this agent ever runs.
      this.card = agentCard;
      if (!this.description && agentCard.description) {
        this.description = agentCard.description;
      }
    }

    if (a2aConfig.authScheme) {
      this.authConfig = buildRemoteAuthConfig(this.name, {
        authScheme: a2aConfig.authScheme,
        authCredential: a2aConfig.authCredential,
        credentialKey: a2aConfig.credentialKey,
      });
    }
    // Copied rather than appended in place, so this agent's extension does not
    // land on a list the caller shares with another agent.
    this.requestInterceptors =
      a2aConfig.useLegacy === false
        ? [
            ...(a2aConfig.requestInterceptors ?? []),
            newIntegrationExtensionInterceptor,
          ]
        : a2aConfig.requestInterceptors;
  }

  /**
   * Releases the client and card this agent resolved.
   *
   * A client the caller supplied is left alone: this agent never owned it.
   * Calling this twice is a no-op.
   */
  close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (!this.a2aConfig.client) {
      this.client = undefined;
    }
    if (this.cardSource) {
      this.card = undefined;
    }
    logger.debug(`Released remote A2A agent resources for ${this.name}`);
  }

  private get timeoutMs(): number {
    return this.a2aConfig.timeoutMs ?? DEFAULT_A2A_TIMEOUT_MS;
  }

  /**
   * Resolves the card and returns the client to use for this invocation.
   *
   * When the card is fetched over the network under per-invocation headers,
   * the card and the client stay local: an authenticated card is scoped to the
   * session it was fetched for, so caching it would leak it into other
   * sessions.
   */
  private async ensureResolved(
    ctx: InvocationContext,
    authHeaders?: Record<string, string>,
  ): Promise<Client> {
    const interceptorHeaders = await executeBeforeCardRequestInterceptors(
      this.a2aConfig.cardRequestInterceptors,
      ctx,
    );
    const headers =
      interceptorHeaders || authHeaders
        ? {...interceptorHeaders, ...authHeaders}
        : undefined;

    if (headers && this.cardSource) {
      const card = await this.resolveAndValidateCard(this.cardSource, headers);
      return this.a2aConfig.client ?? this.createClient(card);
    }

    if (this.client) {
      return this.client;
    }

    if (this.cardSource && !this.card) {
      const card = await this.resolveAndValidateCard(this.cardSource, headers);
      // Stored only once it has validated. A rejected card left on the
      // instance reads as already resolved, so the next call would skip the
      // check and talk to the origin that card named.
      this.card = card;
      if (!this.description && card.description) {
        this.description = adoptedCardDescription(
          card.description,
          this.cardSource,
        );
      }
    }

    // The constructor stores a supplied client, and rejects a config with
    // neither a client nor a card, so a card is available here.
    this.client = await this.createClient(this.card!);
    return this.client;
  }

  private async resolveAndValidateCard(
    source: string,
    headers?: Record<string, string>,
  ): Promise<AgentCard> {
    const card = await resolveAgentCard(source, {
      headers,
      timeoutMs: this.timeoutMs,
      fetchImpl: this.a2aConfig.fetchImpl,
    });
    validateAgentCard(card, source);
    return card;
  }

  private createClient(card: AgentCard): Promise<Client> {
    const factory = this.a2aConfig.clientFactory ?? new ClientFactory();
    return factory.createFromAgentCard(card);
  }

  /** Builds the A2A message this turn sends to the peer. */
  private buildRequest(ctx: InvocationContext): Message {
    const events = ctx.session.events;
    if (events.length === 0) {
      throw new Error('No events in session to send');
    }

    const userFnCall = getUserFunctionCallAt(ctx.session, events.length - 1);
    let parts: A2APart[] = [];
    let taskId: string | undefined;
    let contextId: string | undefined;

    if (userFnCall) {
      const event = userFnCall.response;
      // Route through the shared scrub: this credential response must not
      // cross the trust boundary unless its id is one the peer itself
      // exclusively requested. Computed over the full session, not just
      // this one response event: an id counts as peer-requested only if
      // EVERY event that issued a call for it was authored by the peer,
      // so the check needs the whole history to catch a local request
      // whose id the peer's own event reuses.
      parts = toForwardableA2AParts(
        event.content,
        event.longRunningToolIds,
        peerRequestedCallIds(events, this.name),
        this.a2aConfig.genaiPartConverter,
      );
      taskId = userFnCall.taskId;
      contextId = userFnCall.contextId;
    }

    // Every part of the resume was dropped -- a credential-only response, for
    // instance. Rebuild from history, which drops credentials too, rather than
    // sending the peer an empty message.
    if (parts.length === 0) {
      const missing = toMissingRemoteSessionParts(ctx, ctx.session, {
        fullHistoryWhenStateless: this.a2aConfig.fullHistoryWhenStateless,
        converter: this.a2aConfig.genaiPartConverter,
      });
      parts = missing.parts;
      contextId = missing.contextId ?? contextId;
    }

    const message: Message = {
      kind: 'message',
      messageId: randomUUID(),
      role: MessageRole.USER,
      parts,
      metadata: getA2ASessionMetadata({
        appName: ctx.session.appName,
        userId: ctx.session.userId,
        sessionId: ctx.session.id,
      }),
    };
    if (taskId) message.taskId = taskId;
    if (contextId) message.contextId = contextId;
    return message;
  }

  private errorEvent(ctx: InvocationContext, message: string): AdkEvent {
    logger.error(`A2ARemoteAgent ${this.name} failed: ${message}`);
    return createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      errorMessage: message,
      turnComplete: true,
    });
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    let authHeaders: Record<string, string> | undefined;
    if (this.authConfig) {
      let resolved;
      try {
        resolved = await resolveRemoteAuth(this.authConfig, ctx, this.name);
      } catch (e: unknown) {
        yield this.errorEvent(
          ctx,
          `Failed to authenticate remote A2A agent: ${formatError(e)}`,
        );
        return;
      }
      if (resolved.authRequestEvent) {
        // A pause, not a failure: the invocation resumes once the client
        // supplies the credential.
        ctx.endInvocation = true;
        yield resolved.authRequestEvent;
        return;
      }
      authHeaders = resolved.headers;
    }

    let client: Client;
    try {
      client = await this.ensureResolved(ctx, authHeaders);
    } catch (e: unknown) {
      yield this.errorEvent(
        ctx,
        `Failed to initialize remote A2A agent: ${formatError(e)}`,
      );
      return;
    }

    let message: Message;
    try {
      message = this.buildRequest(ctx);
    } catch (e: unknown) {
      yield this.errorEvent(ctx, formatError(e));
      return;
    }

    if (message.parts.length === 0) {
      logger.warn(
        'No parts to send to remote A2A agent. Emitting empty event.',
      );
      yield createEvent({
        author: this.name,
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        content: {},
      });
      return;
    }

    const intercepted = await executeBeforeRequestInterceptors(
      this.requestInterceptors,
      ctx,
      message,
    );
    if (!isA2AMessage(intercepted.request)) {
      yield intercepted.request;
      return;
    }
    message = intercepted.request;

    const params = this.buildSendParams(ctx, message, intercepted.params);
    if (authHeaders) {
      // Appended last so the credential wins a header conflict.
      params.headers = {...params.headers, ...authHeaders};
    }

    yield* this.sendRequest(ctx, client, message, params);
  }

  private buildSendParams(
    ctx: InvocationContext,
    message: Message,
    params: A2AParametersConfig,
  ): A2AParametersConfig {
    const provider = this.a2aConfig.a2aRequestMetaProvider;
    const requestMetadata = provider
      ? provider(ctx, message)
      : (params.requestMetadata ?? this.a2aConfig.metadata ?? ctx.a2aMetadata);
    return {...params, requestMetadata};
  }

  private async *sendRequest(
    ctx: InvocationContext,
    client: Client,
    message: Message,
    params: A2AParametersConfig,
  ): AsyncGenerator<AdkEvent, void, void> {
    const sendParams: MessageSendParams = {
      message,
      configuration: this.a2aConfig.messageSendConfig,
      ...(params.requestMetadata ? {metadata: params.requestMetadata} : {}),
    };
    for (const callback of this.a2aConfig.beforeRequestCallbacks ?? []) {
      await callback(ctx, sendParams);
    }

    const abort = createLinkedAbort(ctx.abortSignal, this.timeoutMs);
    const options: RequestOptions = {
      signal: abort.controller.signal,
      ...(params.headers ? {serviceParameters: params.headers} : {}),
    };
    const processor = new A2ARemoteAgentRunProcessor(sendParams);
    const useStreaming = this.card?.capabilities?.streaming !== false;

    try {
      const stream = useStreaming
        ? client.sendMessageStream(sendParams, options)
        : toStream(await client.sendMessage(sendParams, options));
      for await (const chunk of stream) {
        yield* this.emitChunk(ctx, chunk, processor, useStreaming);
      }
    } catch (e: unknown) {
      yield this.errorEvent(ctx, `A2A request failed: ${formatError(e)}`);
    } finally {
      abort.dispose();
    }
  }

  private async *emitChunk(
    ctx: InvocationContext,
    chunk: A2AStreamEventData,
    processor: A2ARemoteAgentRunProcessor,
    useStreaming: boolean,
  ): AsyncGenerator<AdkEvent, void, void> {
    for (const callback of this.a2aConfig.afterRequestCallbacks ?? []) {
      await callback(ctx, chunk);
    }

    const converted = toAdkEvent(
      chunk,
      ctx.invocationId,
      this.name,
      ctx.branch,
      this.a2aConfig.a2aPartConverter,
    );
    if (!converted) {
      return;
    }
    processor.updateCustomMetadata(converted, chunk);

    const adkEvent = await executeAfterRequestInterceptors(
      this.requestInterceptors,
      ctx,
      chunk,
      converted,
    );
    if (!adkEvent) {
      return;
    }

    if (!useStreaming) {
      yield adkEvent;
      return;
    }
    yield* processor.aggregatePartial(ctx, chunk, adkEvent);
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Live mode is not supported in A2ARemoteAgent yet.');
  }
}

/** Yields a single non-streaming response as a stream of one. */
async function* toStream(
  result: A2AStreamEventData,
): AsyncGenerator<A2AStreamEventData, void, void> {
  yield result;
}

/**
 * Whether a `beforeRequest` interceptor returned the request rather than an
 * ADK event. An A2A `Message` always carries `kind: 'message'`.
 */
function isA2AMessage(value: Message | AdkEvent): value is Message {
  return 'kind' in value;
}
