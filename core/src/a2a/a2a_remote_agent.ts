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
import {generateAuthEvent} from '../agents/functions.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthHandler} from '../auth/auth_handler.js';
import {buildAuthHeaders} from '../auth/auth_headers.js';
import {TOOLSET_AUTH_CREDENTIAL_ID_PREFIX} from '../auth/auth_preprocessor.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {State} from '../sessions/state.js';
import {
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_SUCCESS_RESULT,
  FINISH_TASK_TOOL_NAME,
  getOutputWrapperKey,
  isFinishTaskTerminalFr,
} from '../tools/finish_task_tool.js';
import {AutoAuthCredentialExchanger} from '../tools/openapi_tool/auth/credential_exchangers/auto_auth_credential_exchanger.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  isMessage,
  isTask,
  isTaskStatusUpdateEvent,
  MessageRole,
  TaskState,
} from './a2a_event.js';
import {
  A2ACardRequestInterceptor,
  A2APartToGenAIPartConverter,
  A2ARequestInterceptor,
  GenAIPartToA2APartConverter,
} from './a2a_remote_agent_config.js';
import {
  buildAuthInterceptors,
  buildRemoteAuthConfig,
  executeAfterRequestInterceptors,
  executeBeforeCardRequestInterceptors,
  executeBeforeRequestInterceptors,
  newIntegrationExtensionInterceptor,
} from './a2a_remote_agent_interceptors.js';
import {A2ARemoteAgentRunProcessor} from './a2a_remote_agent_run_processor.js';
import {
  findFinishTaskArgsFromHistory,
  toTaskScopeA2AParts,
} from './a2a_remote_agent_task_utils.js';
import {
  getUserFunctionCallAt,
  peerRequestedCallIds,
  toForwardableA2AParts,
  toMissingRemoteSessionParts,
} from './a2a_remote_agent_utils.js';
import {
  adoptedCardDescription,
  isRemoteCardSource,
  resolveAgentCard,
} from './agent_card.js';
import {validateAgentCard} from './agent_card_validation.js';
import {toAdkEvent} from './event_converter_utils.js';
import {
  AdkMetadataKeys,
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';

/** Aborts a card fetch or a message send after ten minutes. */
export const DEFAULT_TIMEOUT_MS = 600_000;

export {AGENT_CARD_PATH};

/** Tracks whether a task delegation must hand control back, and why. */
interface TaskOutcome {
  release: boolean;
  errorMessage?: string;
}

/**
 * Why a remote task ended badly, or `undefined` when it did not.
 *
 * Both shapes a peer may report a terminal state in are accepted: a whole
 * `Task`, and the incremental `status-update` that adk-js's own A2A server
 * emits for a failure. The stream is read rather than the converted event,
 * because the converter drops the content of a failed task and emits nothing
 * at all for a canceled one that carries no message.
 */
function terminalTaskFailure(
  chunk: A2AStreamEventData,
): {reason: string; taskId?: string} | undefined {
  if (!isTask(chunk) && !isTaskStatusUpdateEvent(chunk)) {
    return undefined;
  }
  const taskId = isTask(chunk) ? chunk.id : chunk.taskId;
  switch (chunk.status?.state) {
    case TaskState.CANCELED:
      return {reason: 'Task canceled', taskId};
    case TaskState.FAILED:
      return {reason: statusText(chunk) || 'Unknown error', taskId};
    default:
      return undefined;
  }
}

/** Joins the text of a task status message, or `undefined` when it has none. */
function statusText(chunk: Task | TaskStatusUpdateEvent): string | undefined {
  const texts = (chunk.status?.message?.parts ?? [])
    .filter((part) => part.kind === 'text')
    .map((part) => part.text)
    .filter((text) => !!text);
  return texts.length > 0 ? texts.join('\n') : undefined;
}

/**
 * Builds the `finish_task` function response that ends a task delegation.
 *
 * A remote peer has no local tool run to produce it, so the delegating agent
 * writes it on the peer's behalf.
 */
function finishTaskEvent(
  ctx: InvocationContext,
  agentName: string,
  options: {errorMessage?: string; output?: unknown} = {},
): AdkEvent {
  return createEvent({
    author: agentName,
    invocationId: ctx.invocationId,
    branch: ctx.branch,
    isolationScope: ctx.isolationScope,
    errorMessage: options.errorMessage,
    output: options.output,
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: FINISH_TASK_TOOL_NAME,
            response: {
              result: options.errorMessage
                ? FINISH_TASK_ERROR_RESULT
                : FINISH_TASK_SUCCESS_RESULT,
            },
          },
        },
      ],
    },
  });
}

/** The HTTP status a transport error exposes, when it exposes one. */
function httpStatusCode(err: unknown): number | undefined {
  if (err !== null && typeof err === 'object' && 'status' in err) {
    const status = err.status;
    return typeof status === 'number' ? status : undefined;
  }
  return undefined;
}

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
  /**
   * Aborts a card fetch or a message send after this many milliseconds.
   * Defaults to {@link DEFAULT_TIMEOUT_MS}.
   */
  timeoutMs?: number;
  /** Converts one genai part on the outbound path. */
  genaiPartConverter?: GenAIPartToA2APartConverter;
  /** Converts one A2A part on the inbound path. */
  a2aPartConverter?: A2APartToGenAIPartConverter;
  /** Interceptors around the remote agent invocation call. */
  requestInterceptors?: A2ARequestInterceptor[];
  /** Interceptors contributing headers to the agent card fetch. */
  cardRequestInterceptors?: A2ACardRequestInterceptor[];
  /**
   * When `false`, declares the new ADK integration extension on every call so
   * the server answers with it. Defaults to `true`.
   */
  useLegacy?: boolean;
  /**
   * Scheme used to authenticate the calls to the remote agent. When set, the
   * credential is resolved once per invocation and attached to both the agent
   * card fetch and the message send.
   */
  authScheme?: AuthScheme;
  /** Credential for {@link authScheme}. Ignored when no scheme is set. */
  authCredential?: AuthCredential;
  /**
   * Key the resolved credential is cached under. Defaults to a digest of the
   * scheme, the credential and the remote's identity.
   */
  credentialKey?: string;
  /** Performs the agent card fetch. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
  /** Supplies per-request metadata for the outgoing A2A request. */
  a2aRequestMetaProvider?: (
    ctx: InvocationContext,
    message: Message,
  ) => Record<string, unknown>;
  /**
   * Delegation mode. Only `'task'` is supported: the agent runs as a task
   * sub-agent of a parent that owns the conversation across turns, and hands
   * control back once the remote task reaches a terminal state.
   *
   * The remote must call the `finish_task` tool to signal completion, and
   * {@link BaseNodeConfig.outputSchema} must mirror the remote's own output
   * schema for the output to be unwrapped correctly.
   */
  mode?: 'task';
  /**
   * Whether a stateless peer -- one that returns no context id -- receives the
   * whole history on every request. Always on in task mode.
   */
  fullHistoryWhenStateless?: boolean;
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
  /** Aborted by {@link close}, so an in-flight call stops with the agent. */
  private lifetime = new AbortController();
  private readonly authConfig?: AuthConfig;
  private readonly requestInterceptors?: A2ARequestInterceptor[];
  private readonly cardRequestInterceptors?: A2ACardRequestInterceptor[];
  private readonly timeoutMs: number;
  private readonly fullHistoryWhenStateless: boolean;

  /**
   * Redeclared without `readonly`: a card reached over the network only names
   * the remote late, so the description it supplies is adopted on first
   * resolution. `declare` emits nothing, so the base class still owns the
   * field and its constructor value.
   */
  declare description: string;

  constructor(private readonly a2aConfig: RemoteA2AAgentConfig) {
    super(a2aConfig);
    if (!a2aConfig.agentCard && !a2aConfig.client) {
      throw new Error('Either AgentCard or Client must be provided');
    }
    if (typeof a2aConfig.agentCard === 'string') {
      if (!a2aConfig.agentCard.trim()) {
        throw new Error('agentCard string cannot be empty');
      }
    } else if (!this.description && a2aConfig.agentCard?.description) {
      // A card supplied directly never goes through the resolution path, and a
      // parent agent reads the description to build its transfer instruction
      // before this agent ever runs.
      this.description = a2aConfig.agentCard.description;
    }

    this.timeoutMs = a2aConfig.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    // A task peer is driven turn by turn, so it needs the whole scope each
    // time unless it reports a context id of its own.
    this.fullHistoryWhenStateless =
      (a2aConfig.fullHistoryWhenStateless ?? false) ||
      a2aConfig.mode === 'task';
    // Copied before appending, so this agent's interceptors never land on the
    // arrays the caller passed in and may share with another agent.
    let requestInterceptors = a2aConfig.requestInterceptors
      ? [...a2aConfig.requestInterceptors]
      : undefined;
    let cardRequestInterceptors = a2aConfig.cardRequestInterceptors
      ? [...a2aConfig.cardRequestInterceptors]
      : undefined;

    if (a2aConfig.useLegacy === false) {
      requestInterceptors = [
        ...(requestInterceptors ?? []),
        newIntegrationExtensionInterceptor,
      ];
    }

    if (a2aConfig.authScheme) {
      this.authConfig = buildRemoteAuthConfig({
        authScheme: a2aConfig.authScheme,
        authCredential: a2aConfig.authCredential,
        credentialKey: a2aConfig.credentialKey,
        agentCard: a2aConfig.agentCard,
      });
      const {cardInterceptor, requestInterceptor} = buildAuthInterceptors(
        this.authConfig,
      );
      // Appended last so the credential's headers win a key conflict.
      requestInterceptors = [
        ...(requestInterceptors ?? []),
        requestInterceptor,
      ];
      cardRequestInterceptors = [
        ...(cardRequestInterceptors ?? []),
        cardInterceptor,
      ];
    }

    this.requestInterceptors = requestInterceptors;
    this.cardRequestInterceptors = cardRequestInterceptors;
  }

  /**
   * Resolves the credential for this invocation, caching it in
   * invocation-scoped `temp:` state.
   *
   * @returns An event asking the client to collect the credential, or
   *   `undefined` once the credential is available.
   */
  private async resolveAuthCredential(
    ctx: InvocationContext,
  ): Promise<AdkEvent | undefined> {
    const authConfig = this.authConfig;
    if (!authConfig) {
      return undefined;
    }
    const state = new State(ctx.session.state);
    const handler = new AuthHandler(authConfig);
    let credential = handler.getAuthResponse(state);

    if (!credential && authConfig.rawAuthCredential) {
      const exchanged = await new AutoAuthCredentialExchanger().exchange({
        authScheme: authConfig.authScheme,
        authCredential: authConfig.rawAuthCredential,
      });
      credential = exchanged.credential;
    }

    // A failed exchange returns the credential with no usable token, and
    // counting that as resolved would send the request unauthenticated.
    if (credential && buildAuthHeaders(credential, authConfig.authScheme)) {
      state.set(`${State.TEMP_PREFIX}${authConfig.credentialKey}`, credential);
      return undefined;
    }

    // The credential id is prefixed so the auth preprocessor stores the
    // response without trying to resume a function call.
    const requestId = `${TOOLSET_AUTH_CREDENTIAL_ID_PREFIX}${this.name}`;
    const authEvent = generateAuthEvent(
      ctx,
      createEvent({
        author: this.name,
        invocationId: ctx.invocationId,
        branch: ctx.branch,
        actions: {
          requestedAuthConfigs: {[requestId]: handler.generateAuthRequest()},
        },
      }),
    );
    ctx.endInvocation = true;
    return authEvent;
  }

  /**
   * Releases what this agent owns: an in-flight call is aborted and the cached
   * client and card are dropped. Safe to call twice. A caller-supplied
   * `client` or `fetchImpl` is left alone; this agent never owned it.
   */
  close(): void {
    this.lifetime.abort();
    this.lifetime = new AbortController();
    this.card = undefined;
    this.client = undefined;
    this.isInitialized = false;
  }

  /** Bounds one call by the agent lifetime, the invocation, and the timeout. */
  private callSignal(ctx: InvocationContext): AbortSignal {
    const signals = [this.lifetime.signal, AbortSignal.timeout(this.timeoutMs)];
    if (ctx.abortSignal) {
      signals.push(ctx.abortSignal);
    }
    return AbortSignal.any(signals);
  }

  /**
   * Resolves the client and card for one invocation.
   *
   * An authenticated (extended) agent card is scoped to the session that
   * fetched it, so when card request interceptors are configured against a URL
   * source the card and client are resolved per invocation and returned as
   * locals. Caching them would serve one session's card to another.
   */
  private async resolveClient(
    ctx: InvocationContext,
  ): Promise<{client: Client; card?: AgentCard}> {
    const source = this.a2aConfig.agentCard;
    if (
      this.cardRequestInterceptors?.length &&
      typeof source === 'string' &&
      isRemoteCardSource(source)
    ) {
      const card = await this.fetchCard(source, ctx);
      validateAgentCard(card, source);
      const client = this.a2aConfig.client ?? (await this.createClient(card));
      return {client, card};
    }

    await this.init();
    if (!this.client) {
      throw new Error('RemoteA2AAgent has no client');
    }
    return {client: this.client, card: this.card};
  }

  private async fetchCard(
    source: string,
    ctx?: InvocationContext,
  ): Promise<AgentCard> {
    return resolveAgentCard(source, {
      headers: await executeBeforeCardRequestInterceptors(
        this.cardRequestInterceptors,
        ctx,
      ),
      timeoutMs: this.timeoutMs,
      signal: this.lifetime.signal,
      fetchImpl: this.a2aConfig.fetchImpl,
    });
  }

  private createClient(card: AgentCard): Promise<Client> {
    const factory = this.a2aConfig.clientFactory || new ClientFactory();
    return factory.createFromAgentCard(card);
  }

  /** An event carrying only an error message, authored by this agent. */
  private errorEvent(ctx: InvocationContext, message: string): AdkEvent {
    logger.error(message);
    return createEvent({
      author: this.name,
      invocationId: ctx.invocationId,
      branch: ctx.branch,
      errorMessage: message,
    });
  }

  private async init() {
    if (this.isInitialized) {
      return;
    }

    if (this.a2aConfig.client) {
      this.client = this.a2aConfig.client;
    }

    if (this.a2aConfig.agentCard) {
      const source = this.a2aConfig.agentCard;
      const card =
        typeof source === 'string' ? await this.fetchCard(source) : source;
      if (typeof source === 'string') {
        // Validate before caching. A rejected card left on the instance reads
        // as already resolved, so the next call would skip the check and talk
        // to the origin that card named.
        validateAgentCard(card, source);
        if (!this.description && card.description) {
          this.description = adoptedCardDescription(card.description, source);
        }
      }
      this.card = card;

      if (!this.client) {
        this.client = await this.createClient(this.card);
      }
    }

    this.isInitialized = true;
  }

  /**
   * The output the peer passed to `finish_task`, unwrapped when the configured
   * schema wraps a non-object value.
   */
  private taskOutput(ctx: InvocationContext, event: AdkEvent): unknown {
    const args = findFinishTaskArgsFromHistory(
      ctx.session,
      ctx.isolationScope,
      event,
    );
    if (args === undefined) {
      logger.warn(
        'Could not find finish_task arguments in session history for' +
          ` isolation scope '${ctx.isolationScope}'. Task output will not be set.`,
      );
      return undefined;
    }
    const wrapperKey = getOutputWrapperKey(this.outputSchema);
    return wrapperKey && wrapperKey in args ? args[wrapperKey] : args;
  }

  /** The isolation scope this task delegation runs under, in task mode. */
  private taskScope(ctx: InvocationContext): string | undefined {
    return this.a2aConfig.mode === 'task' ? ctx.isolationScope : undefined;
  }

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    if (this.a2aConfig.mode !== 'task') {
      yield* this.runTurn(context, {release: false});
      return;
    }

    // A task delegation must give control back to the parent coordinator on
    // every exit except a pause for credentials, which resumes this same run.
    const outcome: TaskOutcome = {release: false};
    yield* this.runTurn(context, outcome);
    if (!outcome.release) {
      return;
    }
    if (outcome.errorMessage !== undefined) {
      yield finishTaskEvent(context, this.name, {
        errorMessage: outcome.errorMessage,
      });
    }
    yield createEvent({
      author: this.name,
      invocationId: context.invocationId,
      branch: context.branch,
      isolationScope: context.isolationScope,
      actions: {endOfAgent: true},
    });
  }

  private async *runTurn(
    context: InvocationContext,
    outcome: TaskOutcome,
  ): AsyncGenerator<AdkEvent, void, void> {
    if (this.authConfig) {
      let authEvent: AdkEvent | undefined;
      try {
        authEvent = await this.resolveAuthCredential(context);
      } catch (e: unknown) {
        outcome.errorMessage = `Failed to authenticate remote A2A agent: ${formatError(e)}`;
        outcome.release = true;
        yield this.errorEvent(context, outcome.errorMessage);
        return;
      }
      if (authEvent) {
        // A pause, not a failure: the invocation resumes once the client
        // supplies the credential, so a task keeps its control here.
        yield authEvent;
        return;
      }
    }

    let client: Client;
    let card: AgentCard | undefined;
    try {
      ({client, card} = await this.resolveClient(context));
    } catch (e: unknown) {
      outcome.errorMessage = `Failed to initialize remote A2A agent: ${formatError(e)}`;
      outcome.release = true;
      yield this.errorEvent(context, outcome.errorMessage);
      return;
    }

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
      let parts: A2APart[] = [];
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
          this.a2aConfig.genaiPartConverter,
        );
        taskId = userFnCall.taskId;
        contextId = userFnCall.contextId;
      }

      if (parts.length === 0) {
        // Either there was no function response to forward, or every part of
        // it was scrubbed (a credential-only resume). Either way the peer has
        // to be brought up to date from the session history instead.
        const missing = this.taskScope(context)
          ? toTaskScopeA2AParts(context, context.session, {
              peerName: this.name,
              taskScope: this.taskScope(context) ?? '',
              fullHistoryWhenStateless: this.fullHistoryWhenStateless,
              converter: this.a2aConfig.genaiPartConverter,
            })
          : toMissingRemoteSessionParts(
              context,
              context.session,
              this.a2aConfig.genaiPartConverter,
              this.fullHistoryWhenStateless,
            );
        parts = missing.parts;
        contextId = missing.contextId;
        taskId = undefined;
      }

      if (parts.length === 0) {
        logger.warn(
          'No parts to send to remote A2A agent. Emitting empty event.',
        );
        outcome.errorMessage = 'No parts to send to remote A2A agent.';
        outcome.release = true;
        yield createEvent({
          author: this.name,
          invocationId: context.invocationId,
          branch: context.branch,
          content: {},
        });
        return;
      }

      let message: Message = {
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

      const [intercepted, requestParameters] =
        await executeBeforeRequestInterceptors(
          this.requestInterceptors,
          context,
          message,
        );
      if (!isMessage(intercepted)) {
        outcome.errorMessage = 'Request intercepted';
        outcome.release = true;
        yield intercepted;
        return;
      }
      message = intercepted;

      const metadata =
        this.a2aConfig.a2aRequestMetaProvider?.(context, message) ??
        requestParameters.requestMetadata ??
        this.a2aConfig.metadata ??
        context.a2aMetadata;
      const params: MessageSendParams = {
        message,
        configuration: this.a2aConfig.messageSendConfig,
        ...(metadata ? {metadata} : {}),
      };
      const sendOptions: RequestOptions = {
        signal: this.callSignal(context),
        ...(requestParameters.serviceParameters
          ? {serviceParameters: requestParameters.serviceParameters}
          : {}),
        ...(requestParameters.clientCallContext
          ? {context: requestParameters.clientCallContext}
          : {}),
      };

      const processor = new A2ARemoteAgentRunProcessor(params);

      if (this.a2aConfig.beforeRequestCallbacks) {
        for (const callback of this.a2aConfig.beforeRequestCallbacks) {
          await callback(context, params);
        }
      }

      const useStreaming = card ? card.capabilities?.streaming !== false : true;
      const chunks = useStreaming
        ? client.sendMessageStream(params, sendOptions)
        : [await client.sendMessage(params, sendOptions)];

      for await (const chunk of chunks) {
        if (this.a2aConfig.afterRequestCallbacks) {
          for (const callback of this.a2aConfig.afterRequestCallbacks) {
            await callback(context, chunk);
          }
        }

        const converted = toAdkEvent(
          chunk,
          context.invocationId,
          this.name,
          context.branch,
          this.a2aConfig.a2aPartConverter,
        );
        const adkEvent = converted
          ? await executeAfterRequestInterceptors(
              this.requestInterceptors,
              context,
              chunk,
              converted,
            )
          : undefined;

        if (adkEvent) {
          processor.updateCustomMetadata(adkEvent, chunk);

          if (
            this.a2aConfig.mode === 'task' &&
            isFinishTaskTerminalFr(adkEvent)
          ) {
            adkEvent.output = this.taskOutput(context, adkEvent);
            // Yield the semantic output event so the parent runner records the
            // tool response, then stop: a legacy server may repeat it.
            yield adkEvent;
            outcome.release = true;
            return;
          }

          if (useStreaming) {
            for (const ev of processor.aggregatePartial(
              context,
              chunk,
              adkEvent,
            )) {
              yield ev;
            }
          } else {
            yield adkEvent;
          }
        }

        const failure =
          this.a2aConfig.mode === 'task'
            ? terminalTaskFailure(chunk)
            : undefined;
        if (failure) {
          const message = `Remote A2A task failed: ${failure.reason}`;
          logger.warn(message);
          yield createEvent({
            author: this.name,
            invocationId: context.invocationId,
            branch: context.branch,
            isolationScope: context.isolationScope,
            errorMessage: message,
            customMetadata: {
              [AdkMetadataKeys.ERROR]: message,
              ...(failure.taskId
                ? {[AdkMetadataKeys.TASK_ID]: failure.taskId}
                : {}),
            },
          });
          yield finishTaskEvent(context, this.name, {errorMessage: message});
          outcome.release = true;
          return;
        }
      }
    } catch (e: unknown) {
      const message = `A2A request failed: ${formatError(e)}`;
      logger.error(`A2ARemoteAgent ${this.name} failed:`, message);
      outcome.errorMessage = message;
      outcome.release = true;

      const statusCode = httpStatusCode(e);
      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        branch: context.branch,
        errorMessage: message,
        turnComplete: true,
        customMetadata: {
          [AdkMetadataKeys.ERROR]: message,
          ...(statusCode === undefined
            ? {}
            : {[AdkMetadataKeys.STATUS_CODE]: String(statusCode)}),
        },
      });
    }
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Live mode is not supported in A2ARemoteAgent yet.');
  }
}
