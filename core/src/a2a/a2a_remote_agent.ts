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
import {
  getOutputWrapperKey,
  isFinishTaskTerminalFr,
} from '../tools/finish_task_tool.js';
import {createLinkedAbort} from '../utils/abort_utils.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {NodeContext} from '../workflow/node_context.js';
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
  isAdkEvent,
  newIntegrationExtensionInterceptor,
} from './a2a_remote_agent_interceptors.js';
import {promoteResponseToOutput} from './a2a_remote_agent_output.js';
import {A2ARemoteAgentRunProcessor} from './a2a_remote_agent_run_processor.js';
import {
  createEndOfAgentEvent,
  createFinishTaskFailureEvent,
  createTaskFailureEvents,
  findFinishTaskArgsFromHistory,
  textFromContent,
} from './a2a_remote_agent_task.js';
import {
  getUserFunctionCallAt,
  peerRequestedCallIds,
  toForwardableA2AParts,
  toMissingRemoteSessionParts,
} from './a2a_remote_agent_utils.js';
import {adoptedCardDescription, resolveAgentCard} from './agent_card.js';
import {validateAgentCard} from './agent_card_validation.js';
import {toAdkEvent} from './event_converter_utils.js';
import {
  AdkMetadataKeys,
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';
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
  /**
   * Delegation mode. Only `'task'` is supported: the agent runs as a task
   * sub-agent that a coordinator owns across turns, and hands control back
   * when the remote task completes.
   *
   * This requires the remote agent to call the `finish_task` tool. An ADK
   * task-mode agent does that natively; a custom A2A server must return a
   * function response named `finish_task` whose `result` is
   * `'Task completed.'` or `'Task failed.'`. Set `outputSchema` to mirror the
   * remote agent's, so the output is unwrapped the same way.
   *
   * Unset (the default) leaves the agent a plain transfer target.
   */
  mode?: 'task';
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
  /**
   * Writable here alone: this agent adopts the description its resolved agent
   * card carries, which it cannot know at construction. `readonly` is not part
   * of assignability, so a `BaseNode`-typed reference still cannot write it.
   */
  declare description: string;

  private client?: Client;
  private card?: AgentCard;
  private readonly cardSource?: string;
  private readonly authConfig?: AuthConfig;
  private readonly requestInterceptors?: A2ARequestInterceptor[];

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
      // A card supplied directly did not come off the network here, so it is
      // the caller's own object and is not validated, as adk-python also
      // leaves it. It never goes through resolution, so its description is
      // adopted here: a parent agent reads the description to build its
      // transfer instruction, before this agent ever runs.
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

  private get timeoutMs(): number {
    return this.a2aConfig.timeoutMs ?? DEFAULT_A2A_TIMEOUT_MS;
  }

  /** The delegation mode this agent runs in. */
  get mode(): 'task' | undefined {
    return this.a2aConfig.mode;
  }

  /**
   * A delegated task always sends its whole scoped history: the scope is new
   * to the peer, so there is nothing it has already seen.
   */
  private get fullHistoryWhenStateless(): boolean {
    return (
      this.a2aConfig.fullHistoryWhenStateless === true || this.mode === 'task'
    );
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
  ): Promise<ResolvedPeer> {
    const interceptorHeaders = await executeBeforeCardRequestInterceptors(
      this.a2aConfig.cardRequestInterceptors,
      ctx,
    );
    const headers =
      interceptorHeaders || authHeaders
        ? {...interceptorHeaders, ...authHeaders}
        : undefined;

    if (headers && this.cardSource) {
      const card = await this.resolveAndValidateCard(
        this.cardSource,
        headers,
        ctx.abortSignal,
      );
      this.adoptDescription(card);
      return {
        client: this.a2aConfig.client ?? (await this.createClient(card)),
        card,
      };
    }

    if (this.client) {
      return {client: this.client, card: this.card};
    }

    if (this.cardSource && !this.card) {
      const card = await this.resolveAndValidateCard(
        this.cardSource,
        headers,
        ctx.abortSignal,
      );
      // Stored only once it has validated. A rejected card left on the
      // instance reads as already resolved, so the next call would skip the
      // check and talk to the origin that card named.
      this.card = card;
      this.adoptDescription(card);
    }

    // The constructor stores a supplied client, and rejects a config with
    // neither a client nor a card, so a card is available here.
    this.client = await this.createClient(this.card!);
    return {client: this.client, card: this.card};
  }

  /** Takes the card's description when this agent was given none. */
  private adoptDescription(card: AgentCard): void {
    if (!this.description && card.description) {
      this.description = adoptedCardDescription(
        card.description,
        this.cardSource,
      );
    }
  }

  private async resolveAndValidateCard(
    source: string,
    headers?: Record<string, string>,
    abortSignal?: AbortSignal,
  ): Promise<AgentCard> {
    const card = await resolveAgentCard(source, {
      headers,
      timeoutMs: this.timeoutMs,
      abortSignal,
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
        fullHistoryWhenStateless: this.fullHistoryWhenStateless,
        converter: this.a2aConfig.genaiPartConverter,
        taskScope: this.mode === 'task' ? ctx.isolationScope : undefined,
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

  private errorEvent(
    ctx: InvocationContext,
    message: string,
    customMetadata?: Record<string, unknown>,
  ): AdkEvent {
    logger.error(`A2ARemoteAgent ${this.name} failed: ${message}`);
    return createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      isolationScope: ctx.isolationScope,
      errorMessage: message,
      turnComplete: true,
      customMetadata,
    });
  }

  protected async *runAsyncImpl(
    ctx: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    const control: TaskControl = {release: false};
    try {
      yield* this.runTurn(ctx, control);
    } finally {
      // Every terminating path in task mode hands control back, so the
      // coordinator is never left waiting on a task that has stopped.
      if (this.mode === 'task' && control.release) {
        if (control.errorMessage !== undefined) {
          yield createFinishTaskFailureEvent(
            ctx,
            this.name,
            control.errorMessage,
          );
        }
        yield createEndOfAgentEvent(ctx, this.name);
      }
    }
  }

  private async *runTurn(
    ctx: InvocationContext,
    control: TaskControl,
  ): AsyncGenerator<AdkEvent, void, void> {
    let authHeaders: Record<string, string> | undefined;
    if (this.authConfig) {
      let resolved;
      try {
        resolved = await resolveRemoteAuth(this.authConfig, ctx, this.name);
      } catch (e: unknown) {
        control.errorMessage = `Failed to authenticate remote A2A agent: ${formatError(e)}`;
        control.release = true;
        yield this.errorEvent(ctx, control.errorMessage);
        return;
      }
      if (resolved.authRequestEvent) {
        // A pause, not a failure: the invocation resumes once the client
        // supplies the credential, so a task keeps its control here.
        ctx.endInvocation = true;
        yield resolved.authRequestEvent;
        return;
      }
      authHeaders = resolved.headers;
    }

    let peer: ResolvedPeer;
    try {
      peer = await this.ensureResolved(ctx, authHeaders);
    } catch (e: unknown) {
      control.errorMessage = `Failed to initialize remote A2A agent: ${formatError(e)}`;
      control.release = true;
      yield this.errorEvent(ctx, control.errorMessage);
      return;
    }

    let message: Message;
    try {
      message = this.buildRequest(ctx);
    } catch (e: unknown) {
      control.errorMessage = formatError(e);
      control.release = true;
      yield this.errorEvent(ctx, control.errorMessage);
      return;
    }

    if (message.parts.length === 0) {
      logger.warn(
        'No parts to send to remote A2A agent. Emitting empty event.',
      );
      control.errorMessage = 'No parts to send to remote A2A agent.';
      control.release = true;
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
    if (isAdkEvent(intercepted.request)) {
      control.errorMessage = 'Request intercepted';
      control.release = true;
      yield intercepted.request;
      return;
    }
    message = intercepted.request;

    const params = this.buildSendParams(ctx, message, intercepted.params);
    if (authHeaders) {
      // Appended last so the credential wins a header conflict.
      params.headers = {...params.headers, ...authHeaders};
    }

    yield* this.sendRequest(ctx, peer, message, params, control);
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
    peer: ResolvedPeer,
    message: Message,
    params: A2AParametersConfig,
    control: TaskControl,
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
    const useStreaming = peer.card?.capabilities?.streaming !== false;

    try {
      const stream = useStreaming
        ? peer.client.sendMessageStream(sendParams, options)
        : [await peer.client.sendMessage(sendParams, options)];
      for await (const chunk of stream) {
        for await (const event of this.emitChunk(
          ctx,
          chunk,
          processor,
          useStreaming,
        )) {
          if (this.mode === 'task' && isFinishTaskTerminalFr(event)) {
            this.setTaskOutput(ctx, event);
            yield event;
            // Returning here ignores a duplicate function response a legacy
            // server sends at the end of the run.
            control.release = true;
            return;
          }
          yield event;

          const failure = this.taskFailureEvents(ctx, chunk, event, message);
          if (failure) {
            yield* failure;
            control.release = true;
            return;
          }
        }
      }
    } catch (e: unknown) {
      const errorMessage = `A2A request failed: ${formatError(e)}`;
      control.errorMessage = errorMessage;
      control.release = true;
      yield this.errorEvent(ctx, errorMessage, {
        [AdkMetadataKeys.ERROR]: errorMessage,
        [AdkMetadataKeys.REQUEST]: message,
      });
    } finally {
      abort.dispose();
    }
  }

  /** Promotes the peer's `finish_task` arguments to the task output. */
  private setTaskOutput(ctx: InvocationContext, event: AdkEvent): void {
    const args = findFinishTaskArgsFromHistory(
      ctx.session,
      ctx.isolationScope,
      event,
    );
    if (!args) {
      logger.warn(
        'Could not find finish_task arguments in session history for' +
          ` isolation scope '${ctx.isolationScope}'. Task output is not set.`,
      );
      return;
    }
    const wrapperKey = getOutputWrapperKey(this.outputSchema);
    event.output = wrapperKey && wrapperKey in args ? args[wrapperKey] : args;
  }

  /** The events a failed or cancelled remote task produces, if it is one. */
  private taskFailureEvents(
    ctx: InvocationContext,
    chunk: A2AStreamEventData,
    event: AdkEvent,
    request: Message,
  ): AdkEvent[] | undefined {
    if (this.mode !== 'task' || chunk.kind !== 'task') {
      return undefined;
    }
    const state = chunk.status?.state;
    if (state !== 'failed' && state !== 'canceled') {
      return undefined;
    }
    logger.warn(
      `Remote task reported ${state}. Yielding an error event and releasing` +
        ' control.',
    );
    const errorText =
      state === 'canceled'
        ? 'Task canceled'
        : (textFromContent(event.content) ??
          event.errorMessage ??
          'Unknown error');
    return createTaskFailureEvents({
      errorText,
      ctx,
      agentName: this.name,
      taskId: chunk.id,
      request,
    });
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

  /**
   * Runs the agent as a workflow node.
   *
   * Promotes the peer's textual answer to `event.output` so the scheduler
   * propagates it downstream. Without this a `JoinNode` aggregating parallel
   * `RemoteA2AAgent` predecessors sees `undefined` for each of them: the agent
   * carries its answer in `event.content` and nothing sets `event.output`.
   */
  protected override async *runImpl(
    ctx: NodeContext,
    nodeInput: unknown,
  ): AsyncGenerator<AdkEvent, void, void> {
    let promoted = false;
    for await (const event of super.runImpl(ctx, nodeInput)) {
      if (!promoted && promoteResponseToOutput(event, this.name)) {
        promoted = true;
      }
      yield event;
    }
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Live mode is not supported in A2ARemoteAgent yet.');
  }
}

/** The client for this turn and the card whose capabilities it honours. */
interface ResolvedPeer {
  client: Client;
  card?: AgentCard;
}

/** Tracks whether a delegated task must hand control back, and why. */
interface TaskControl {
  release: boolean;
  errorMessage?: string;
}
