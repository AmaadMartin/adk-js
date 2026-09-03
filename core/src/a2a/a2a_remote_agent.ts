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
import {Schema} from '@google/genai';
import {BaseAgent, BaseAgentConfig} from '../agents/base_agent.js';
import {InvocationContext} from '../agents/invocation_context.js';
import {AuthCredential} from '../auth/auth_credential.js';
import {AuthScheme} from '../auth/auth_schemes.js';
import {AuthConfig} from '../auth/auth_tool.js';
import {Event as AdkEvent, createEvent} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {
  FINISH_TASK_ERROR_RESULT,
  FINISH_TASK_TOOL_NAME,
  FinishTaskTool,
  isFinishTaskTerminalResponse,
} from '../tools/finish_task_tool.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {formatError} from '../utils/error_utils.js';
import {logger} from '../utils/logger.js';
import {
  getFailedTaskStatusUpdateEventError,
  isTask,
  isTaskStatusUpdateEvent,
  MessageRole,
  TaskState,
} from './a2a_event.js';
import {
  buildAuthInterceptors,
  deriveCredentialKey,
  resolveAuthCredential,
} from './a2a_remote_agent_auth.js';
import {
  A2ACardRequestInterceptor,
  A2ARequestInterceptor,
  executeAfterRequestInterceptors,
  executeBeforeCardRequestInterceptors,
  executeBeforeRequestInterceptors,
  isA2AMessage,
  newIntegrationExtensionInterceptor,
} from './a2a_remote_agent_interceptors.js';
import {A2ARemoteAgentRunProcessor} from './a2a_remote_agent_run_processor.js';
import {
  findFinishTaskArgsFromHistory,
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
  A2AErrorMetadataKeys,
  AdkMetadataKeys,
  getA2ASessionMetadata,
} from './metadata_converter_utils.js';
import {
  A2APartToGenAIPartConverter,
  GenAIPartToA2APartConverter,
  toA2APart,
  toGenAIPart,
} from './part_converter_utils.js';

export {AGENT_CARD_PATH};

/**
 * Milliseconds a card fetch and a message send are allowed to take before they
 * are aborted. Matches adk-python's `DEFAULT_TIMEOUT` of 600 seconds.
 */
export const DEFAULT_A2A_TIMEOUT_MS = 600_000;

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
   * Delegation mode. `'task'` runs the agent as a task sub-agent of a parent
   * that owns the conversation, and hands control back once the remote task
   * reports completion through the `finish_task` tool.
   */
  mode?: 'task';

  /**
   * Send the whole session to a peer that returns no context id. Defaults to
   * `false`, and to `true` in task mode.
   */
  fullHistoryWhenStateless?: boolean;

  /**
   * The schema the remote task's output follows. Read in task mode only, to
   * unwrap the `finish_task` arguments.
   */
  outputSchema?: Schema;

  /**
   * Milliseconds after which the agent card fetch and the message send are
   * aborted. Defaults to {@link DEFAULT_A2A_TIMEOUT_MS}.
   */
  timeout?: number;

  /** Converts a GenAI part for the outgoing request. Defaults to `toA2APart`. */
  genaiPartConverter?: GenAIPartToA2APartConverter;

  /** Converts an A2A part of the response. Defaults to `toGenAIPart`. */
  a2aPartConverter?: A2APartToGenAIPartConverter;

  /** Interceptors around the A2A message send. */
  requestInterceptors?: A2ARequestInterceptor[];

  /** Interceptors around the remote agent card fetch. */
  cardRequestInterceptors?: A2ACardRequestInterceptor[];

  /**
   * When `false`, tells the server to use its new ADK integration by sending
   * {@link NEW_A2A_ADK_INTEGRATION_EXTENSION} in the A2A extension header.
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
   * scheme, the credential and the remote.
   */
  credentialKey?: string;
}

/** Whether task mode should hand control back, and why. */
interface TaskControl {
  release: boolean;
  errorMessage?: string;
}

/** Marks the task as finished in error, so the coordinator regains control. */
function releaseTaskControl(control: TaskControl, errorMessage: string): void {
  control.release = true;
  control.errorMessage = errorMessage;
}

/**
 * The failure text for a task that ended badly, or `undefined` when the task
 * has not failed.
 */
/** A remote task that ended badly: which task, and why. */
interface TaskFailure {
  taskId: string;
  text: string;
}

/**
 * The failure a response chunk reports, or `undefined` when it reports none.
 *
 * A terminal state reaches the client either as a whole `Task` (the first frame
 * of a stream, and the only frame of a non-streaming send) or as a
 * `status-update` frame once the task is already running. Both are checked: a
 * task that fails after it started only ever reports it the second way, and the
 * A2A client forwards those frames without folding them into a running task.
 */
function taskFailure(
  chunk: A2AStreamEventData,
  event?: AdkEvent,
): TaskFailure | undefined {
  const isTaskChunk = isTask(chunk);
  if (!isTaskChunk && !isTaskStatusUpdateEvent(chunk)) {
    return undefined;
  }
  const state = chunk.status?.state;
  if (state !== TaskState.FAILED && state !== TaskState.CANCELED) {
    return undefined;
  }
  const taskId = isTaskChunk ? chunk.id : chunk.taskId;
  if (state === TaskState.CANCELED) {
    return {taskId, text: 'Task canceled'};
  }
  return {taskId, text: failureText(chunk, event)};
}

/** The reason a failed task gives, from the chunk or the event built from it. */
function failureText(
  chunk: Task | TaskStatusUpdateEvent,
  event?: AdkEvent,
): string {
  // A failed task converts to an event carrying its reason on `errorMessage`
  // and no content, so read that first and fall back to any text either the
  // event or the chunk's own status message carries.
  const eventText = (event?.content?.parts ?? [])
    .map((part) => part.text)
    .filter((part): part is string => !!part)
    .join('\n');
  return (
    event?.errorMessage ||
    eventText ||
    getFailedTaskStatusUpdateEventError(chunk) ||
    'Unknown error'
  );
}

/**
 * The HTTP status code a thrown value carries, when it carries one. A transport
 * error from the A2A client reports the response status this way.
 */
function httpStatusCode(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) {
    return undefined;
  }
  const {status} = err;
  return typeof status === 'number' ? status : undefined;
}

/**
 * Fills an empty description from a card supplied directly.
 *
 * A card object never goes through the resolution path, so it is adopted here
 * instead. A parent agent reads the description to build its transfer
 * instruction, and that happens before this agent ever runs.
 */
function withAdoptedCardDescription(
  config: RemoteA2AAgentConfig,
): RemoteA2AAgentConfig {
  const card = config.agentCard;
  if (config.description || typeof card !== 'object' || !card.description) {
    return config;
  }
  return {...config, description: card.description};
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
  /** The location a string-sourced card is fetched from, once trimmed. */
  private readonly cardSource?: string;
  private readonly timeoutMs: number;
  private readonly fullHistoryWhenStateless: boolean;
  /** Unwraps the `finish_task` arguments in task mode. */
  private readonly finishTaskTool?: FinishTaskTool;
  private readonly authConfig?: AuthConfig;
  private readonly requestInterceptors: A2ARequestInterceptor[];
  private readonly cardRequestInterceptors: A2ACardRequestInterceptor[];

  constructor(private readonly a2aConfig: RemoteA2AAgentConfig) {
    super(withAdoptedCardDescription(a2aConfig));
    if (!a2aConfig.agentCard && !a2aConfig.client) {
      throw new Error('Either AgentCard or Client must be provided');
    }
    if (typeof a2aConfig.agentCard === 'string') {
      if (!a2aConfig.agentCard.trim()) {
        throw new Error('agentCard string cannot be empty');
      }
      this.cardSource = a2aConfig.agentCard.trim();
    }
    this.timeoutMs = a2aConfig.timeout ?? DEFAULT_A2A_TIMEOUT_MS;
    this.fullHistoryWhenStateless =
      a2aConfig.fullHistoryWhenStateless ?? a2aConfig.mode === 'task';
    if (a2aConfig.mode === 'task') {
      this.finishTaskTool = new FinishTaskTool(a2aConfig.outputSchema);
    }

    // Copied rather than used in place, so this agent's own interceptors never
    // land on another agent that shares the same config object.
    this.requestInterceptors = [...(a2aConfig.requestInterceptors ?? [])];
    this.cardRequestInterceptors = [
      ...(a2aConfig.cardRequestInterceptors ?? []),
    ];
    if (a2aConfig.useLegacy === false) {
      this.requestInterceptors.push(newIntegrationExtensionInterceptor);
    }
    if (a2aConfig.authScheme) {
      this.authConfig = {
        authScheme: a2aConfig.authScheme,
        rawAuthCredential: a2aConfig.authCredential,
        credentialKey:
          a2aConfig.credentialKey ??
          deriveCredentialKey(
            a2aConfig.authScheme,
            a2aConfig.authCredential,
            a2aConfig.agentCard ?? this.name,
          ),
      };
      // Appended last, so the credential wins over a caller's own header.
      const auth = buildAuthInterceptors(this.authConfig);
      this.cardRequestInterceptors.push(auth.card);
      this.requestInterceptors.push(auth.request);
    }
  }

  private async init(context?: InvocationContext) {
    if (this.isInitialized) {
      return;
    }

    if (this.a2aConfig.client) {
      this.client = this.a2aConfig.client;
    }

    if (this.a2aConfig.agentCard) {
      // A card supplied directly is the caller's own object and is taken as
      // given, as it is in the reference. Only a card this agent went and
      // fetched is validated.
      const card = this.cardSource
        ? await this.resolveAndValidateCard(this.cardSource, context)
        : (this.a2aConfig.agentCard as AgentCard);
      this.card = card;

      if (!this.client) {
        const factory = this.a2aConfig.clientFactory || new ClientFactory();
        this.client = await factory.createFromAgentCard(card);
      }
    }

    this.isInitialized = true;
  }

  /**
   * Fetches the card from `source`, checks where it aims RPC traffic and
   * adopts its description. Nothing is stored on the instance until the card
   * has validated: a rejected card left behind reads as already resolved, so
   * the next call would skip the check and talk to the origin that card named.
   */
  private async resolveAndValidateCard(
    source: string,
    context?: InvocationContext,
  ): Promise<AgentCard> {
    const remoteSource = isRemoteCardSource(source) ? source : undefined;
    const headers = remoteSource
      ? await executeBeforeCardRequestInterceptors(
          this.cardRequestInterceptors,
          context,
        )
      : undefined;
    const card = await resolveAgentCard(source, {
      headers,
      timeoutMs: this.timeoutMs,
    });
    validateAgentCard(card, remoteSource);
    if (!this.description && card.description) {
      this.description = adoptedCardDescription(card.description, source);
    }
    return card;
  }

  /**
   * Returns the client and card to use for this invocation.
   *
   * Per the A2A spec an authenticated agent card is scoped to one
   * authenticated session, so when card interceptors are configured for a URL
   * source the card and the client are built per invocation and kept local.
   * That stops one session's authenticated card leaking into another.
   */
  private async ensureResolved(
    context: InvocationContext,
  ): Promise<{client: Client; card?: AgentCard}> {
    const source = this.cardSource;
    if (
      source &&
      isRemoteCardSource(source) &&
      this.cardRequestInterceptors.length > 0
    ) {
      const card = await this.resolveAndValidateCard(source, context);
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

  protected async *runAsyncImpl(
    context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    if (!this.finishTaskTool) {
      yield* this.runTurn(context);
      return;
    }
    // Task mode: every exit but a credential pause hands control back to the
    // coordinator, so the release lives in a `finally`.
    const control: TaskControl = {release: false};
    try {
      yield* this.runTurn(context, control);
    } finally {
      if (control.release) {
        if (control.errorMessage !== undefined) {
          yield this.finishTaskEvent(context, {
            errorMessage: control.errorMessage,
          });
        }
        yield createEvent({
          author: this.name,
          invocationId: context.invocationId,
          branch: context.branch,
          actions: createEventActions({endOfAgent: true}),
        });
      }
    }
  }

  /** Runs one exchange with the remote peer. */
  private async *runTurn(
    context: InvocationContext,
    control: TaskControl = {release: false},
  ): AsyncGenerator<AdkEvent, void, void> {
    if (this.authConfig) {
      let authRequestEvent: AdkEvent | undefined;
      try {
        authRequestEvent = await resolveAuthCredential(
          context,
          this.authConfig,
          this.name,
        );
      } catch (e: unknown) {
        const errorMessage = `Failed to authenticate remote A2A agent: ${formatError(e)}`;
        logger.error(errorMessage);
        releaseTaskControl(control, errorMessage);
        yield createEvent({
          author: this.name,
          invocationId: context.invocationId,
          errorMessage,
          turnComplete: true,
        });
        return;
      }
      if (authRequestEvent) {
        // A pause, not a failure: the invocation resumes once the client
        // supplies the credential.
        yield authRequestEvent;
        return;
      }
    }

    let client: Client;
    let card: AgentCard | undefined;
    try {
      ({client, card} = await this.ensureResolved(context));
    } catch (e: unknown) {
      const errorMessage = `Failed to initialize remote A2A agent: ${formatError(e)}`;
      logger.error(errorMessage);
      releaseTaskControl(control, errorMessage);
      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        errorMessage,
        turnComplete: true,
      });
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
      let parts: A2APart[];
      let taskId: string | undefined = undefined;
      let contextId: string | undefined = undefined;

      const genaiPartConverter = this.a2aConfig.genaiPartConverter ?? toA2APart;
      const a2aPartConverter = this.a2aConfig.a2aPartConverter ?? toGenAIPart;

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
          genaiPartConverter,
        );
        taskId = userFnCall.taskId;
        contextId = userFnCall.contextId;
      } else {
        const missing = toMissingRemoteSessionParts(context, context.session, {
          converter: genaiPartConverter,
          taskScope: this.taskScope(context),
          fullHistoryWhenStateless: this.fullHistoryWhenStateless,
        });
        parts = missing.parts;
        contextId = missing.contextId;
      }

      if (parts.length === 0) {
        logger.warn('No parts to send to remote A2A agent.');
        releaseTaskControl(control, 'No parts to send to remote A2A agent.');
        yield createEvent({
          author: this.name,
          invocationId: context.invocationId,
          branch: context.branch,
          content: {},
        });
        return;
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
        this.requestInterceptors,
        context,
        params.message,
      );
      if (!isA2AMessage(intercepted.request)) {
        releaseTaskControl(control, 'Request intercepted');
        yield intercepted.request;
        return;
      }
      params.message = intercepted.request;
      if (intercepted.params.requestMetadata) {
        params.metadata = intercepted.params.requestMetadata;
      }
      const options: RequestOptions = {
        signal: AbortSignal.timeout(this.timeoutMs),
        ...(intercepted.params.headers
          ? {serviceParameters: intercepted.params.headers}
          : {}),
      };

      const useStreaming = card ? card.capabilities?.streaming !== false : true;
      const responses = useStreaming
        ? client.sendMessageStream(params, options)
        : [await client.sendMessage(params, options)];

      for await (const chunk of responses) {
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
          a2aPartConverter,
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

          if (this.finishTaskTool && isFinishTaskTerminalResponse(adkEvent)) {
            adkEvent.output = this.taskOutput(context, adkEvent);
            yield adkEvent;
            // Returning early stops the stream reader, ignoring any duplicate
            // responses the server sends at the end of the run.
            control.release = true;
            return;
          }

          if (!useStreaming) {
            yield adkEvent;
          } else {
            for (const ev of processor.aggregatePartial(
              context,
              chunk,
              adkEvent,
            )) {
              yield ev;
            }
          }
        }

        // Checked against the chunk, not the event: a terminal status update
        // often carries no content and converts to no event at all.
        const failure = this.finishTaskTool
          ? taskFailure(chunk, adkEvent)
          : undefined;
        if (failure) {
          logger.warn(
            `Remote task ${failure.taskId} reported ${failure.text}.` +
              ' Releasing control.',
          );
          const errorMessage = `Remote A2A task failed: ${failure.text}`;
          yield createEvent({
            author: this.name,
            invocationId: context.invocationId,
            branch: context.branch,
            isolationScope: context.isolationScope,
            errorMessage,
            customMetadata: {
              [A2AErrorMetadataKeys.ERROR]: errorMessage,
              [AdkMetadataKeys.TASK_ID]: failure.taskId,
            },
          });
          releaseTaskControl(control, errorMessage);
          return;
        }
      }
    } catch (e: unknown) {
      const errorMessage = `A2A request failed: ${formatError(e)}`;
      logger.error(errorMessage);
      releaseTaskControl(control, errorMessage);
      const statusCode = httpStatusCode(e);

      yield createEvent({
        author: this.name,
        invocationId: context.invocationId,
        errorMessage,
        turnComplete: true,
        customMetadata: {
          [A2AErrorMetadataKeys.ERROR]: errorMessage,
          ...(statusCode === undefined
            ? {}
            : {[A2AErrorMetadataKeys.STATUS_CODE]: statusCode}),
        },
      });
    }
  }

  /** The isolation scope the current delegated task runs under, in task mode. */
  private taskScope(context: InvocationContext): string | undefined {
    return this.finishTaskTool ? context.isolationScope : undefined;
  }

  /**
   * The output a completed task produced, read from the `finish_task` call in
   * session history and unwrapped through the output schema's wrapper key.
   */
  private taskOutput(context: InvocationContext, completed: AdkEvent): unknown {
    const args = findFinishTaskArgsFromHistory(
      context.session,
      context.isolationScope,
      completed,
    );
    if (!args) {
      logger.warn(
        'Could not find finish_task arguments in session history for' +
          ` isolation scope '${context.isolationScope}'. Task output will not` +
          ' be set.',
      );
      return undefined;
    }
    const wrapperKey = this.finishTaskTool?.wrapperKey;
    // A remote that answered with the object itself rather than the wrapper
    // key still produced output; the reference takes the args whole.
    if (wrapperKey && !(wrapperKey in args)) {
      return args;
    }
    return this.finishTaskTool?.extractOutput(args);
  }

  /** The `finish_task` response event that ends this agent's turn. */
  private finishTaskEvent(
    context: InvocationContext,
    {errorMessage}: {errorMessage: string},
  ): AdkEvent {
    return createEvent({
      author: this.name,
      invocationId: context.invocationId,
      branch: context.branch,
      isolationScope: context.isolationScope,
      errorMessage,
      content: {
        role: 'user',
        parts: [
          {
            functionResponse: {
              name: FINISH_TASK_TOOL_NAME,
              response: {result: FINISH_TASK_ERROR_RESULT},
            },
          },
        ],
      },
    });
  }

  protected runLiveImpl(
    _context: InvocationContext,
  ): AsyncGenerator<AdkEvent, void, void> {
    throw new Error('Live mode is not supported in A2ARemoteAgent yet.');
  }
}
