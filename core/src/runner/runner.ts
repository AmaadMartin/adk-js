/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content, createPartFromText, Part} from '@google/genai';
import {context, trace} from '@opentelemetry/api';

import {BaseAgent} from '../agents/base_agent.js';
import {
  findEventByFunctionCallId,
  findMatchingFunctionCall,
} from '../agents/functions.js';
import {
  InvocationContext,
  newInvocationContextId,
} from '../agents/invocation_context.js';
import {isLlmAgent} from '../agents/llm_agent.js';
import {createRunConfig, RunConfig} from '../agents/run_config.js';
import {App} from '../apps/app.js';
import {ResumabilityConfig} from '../apps/resumability_config.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {ScopedArtifactService} from '../artifacts/scoped_artifact_service.js';

import {BaseCredentialService} from '../auth/credential_service/base_credential_service.js';
import {
  BuiltInCodeExecutor,
  isBuiltInCodeExecutor,
} from '../code_executors/built_in_code_executor.js';
import {
  createEvent,
  Event,
  getFunctionCalls,
  getFunctionResponses,
} from '../events/event.js';
import {createEventActions} from '../events/event_actions.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {BasePlugin} from '../plugins/base_plugin.js';
import {PluginManager} from '../plugins/plugin_manager.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {CompositeSessionKey, Session} from '../sessions/session.js';
import {
  runAsyncGeneratorWithOtelContext,
  tracer,
} from '../telemetry/tracing.js';
import {BaseToolset, isBaseToolset} from '../tools/base_toolset.js';
import {logger} from '../utils/logger.js';
import {isGemini2OrAbove} from '../utils/model_name.js';

/**
 * The configuration parameters for the Runner.
 */
export interface RunnerConfig {
  /**
   * The application object. If provided, `appName`, `agent`, and `plugins` will default from this app.
   */
  app?: App;

  /**
   * The application name. Required if `app` is not provided.
   */
  appName?: string;

  /**
   * The agent to run. Required if `app` is not provided.
   */
  agent?: BaseAgent;

  /**
   * An optional list of plugins to apply globally across all agents.
   */
  plugins?: BasePlugin[];

  /**
   * An optional service for storing and retrieving artifacts.
   */
  artifactService?: BaseArtifactService;

  /**
   * The service for managing sessions.
   */
  sessionService: BaseSessionService;

  /**
   * An optional service for storing and querying agent memory.
   */
  memoryService?: BaseMemoryService;

  /**
   * An optional service for managing authentication credentials.
   */
  credentialService?: BaseCredentialService;

  /**
   * An optional resumability configuration applied to the runner.
   */
  resumabilityConfig?: ResumabilityConfig;
}

/**
 * Session state key holding the transaction index, a map from
 * `functionCall.id` to the {@link TransactionIndexEntry} of the event that
 * issued the call.
 *
 * The spelling is a persisted contract: sessions written by one version have
 * to stay readable by the next, so always reference this constant instead of
 * repeating the literal.
 */
export const TRANSACTION_INDEX_KEY = '_adk_transactions';

/**
 * Session state key holding the {@link RoutableAgentMarker} for the session.
 *
 * The spelling is a persisted contract; see {@link TRANSACTION_INDEX_KEY}.
 */
export const LAST_ROUTABLE_AGENT_KEY = '_adk_last_routable_agent';

/**
 * Upper bound on the number of function calls kept in the transaction index.
 *
 * The index is a cache in front of the reverse event scan, so it only has to
 * cover the calls that can still be answered - normally the outstanding ones
 * of the current turn. Bounding it keeps both the persisted session state and
 * the per-event state delta constant-sized instead of growing with the
 * session; evicted calls fall back to the scan.
 */
export const MAX_TRACKED_TRANSACTIONS = 100;

/**
 * The author of events appended on behalf of the end user.
 */
const USER_AUTHOR = 'user';

/**
 * State keys owned by the runner. Resumption routing is derived from them, so
 * they are stripped from caller-supplied state deltas.
 */
const RESERVED_STATE_KEYS: readonly string[] = [
  TRANSACTION_INDEX_KEY,
  LAST_ROUTABLE_AGENT_KEY,
];

/**
 * Identifies the event that issued a function call, so that the matching
 * function response can be routed back to its author without scanning the
 * event log.
 */
export interface TransactionIndexEntry {
  /** The author of the event that issued the function call. */
  author: string;
  /** The id of the event that issued the function call. */
  eventId: string;
  /** The timestamp of that event, used to evict the oldest entries. */
  timestamp: number;
}

/**
 * Records the last agent that was routable across the agent tree, together
 * with the newest agent-authored event it was derived from.
 *
 * The event id is what makes the marker safe to trust: it is only used when it
 * still matches the newest agent-authored event of the session, so a stale
 * marker - or one written by a client - can never disagree with the event log.
 */
export interface RoutableAgentMarker {
  /** The name of the last routable agent. */
  agentName: string;
  /** The id of the newest agent-authored event when this was recorded. */
  eventId: string;
}

/**
 * The resolved resumption target, plus the state updates that were derived
 * while resolving it and that the caller is expected to persist.
 */
interface ResumptionResult {
  /** The agent that should handle the invocation. */
  agent: BaseAgent;
  /** State delta to attach to the next event appended to the session. */
  stateDelta: Record<string, unknown>;
}

/**
 * A unique symbol to identify ADK agent classes.
 * Defined once and shared by all Runner instances.
 */
const RUNNER_SIGNATURE_SYMBOL = Symbol.for('google.adk.runner');

/**
 * Type guard to check if an object is an instance of Runner.
 * @param obj The object to check.
 * @returns True if the object is an instance of Runner, false otherwise.
 */
export function isRunner(obj: unknown): obj is Runner {
  return (
    typeof obj === 'object' &&
    obj !== null &&
    RUNNER_SIGNATURE_SYMBOL in obj &&
    obj[RUNNER_SIGNATURE_SYMBOL] === true
  );
}

/**
 * Orchestrates agent execution for a given application.
 *
 * The Runner manages the full lifecycle of an agent invocation: it loads the
 * session, invokes plugin callbacks, runs the root agent, and yields the
 * resulting events. Use {@link InMemoryRunner} for quick prototyping without
 * external services.
 *
 * Example:
 * ```typescript
 * const runner = new Runner({
 *   appName: 'my_app',
 *   agent: myAgent,
 *   sessionService: new InMemorySessionService(),
 * });
 *
 * for await (const event of runner.runAsync({
 *   userId: 'user1',
 *   sessionId: 'session1',
 *   newMessage: {parts: [{text: 'Hello'}]},
 * })) {
 *   console.log(event);
 * }
 * ```
 */
export class Runner {
  readonly [RUNNER_SIGNATURE_SYMBOL] = true;
  readonly appName: string;
  readonly agent: BaseAgent;
  readonly pluginManager: PluginManager;
  readonly artifactService?: BaseArtifactService;
  readonly sessionService: BaseSessionService;
  readonly memoryService?: BaseMemoryService;
  readonly credentialService?: BaseCredentialService;
  readonly resumabilityConfig?: ResumabilityConfig;

  /**
   * Creates a new Runner instance.
   *
   * @param input The configuration for the runner.
   */
  constructor(input: RunnerConfig) {
    const appName = input.app?.name ?? input.appName;
    const agent = input.app?.rootAgent ?? input.agent;
    if (!agent) {
      throw new Error(
        'agent must be provided in runner constructor (or via app.rootAgent)',
      );
    }
    this.appName = appName!;
    this.agent = agent;
    const appPlugins = input.app?.plugins ?? [];
    const configPlugins = input.plugins ?? [];
    this.pluginManager = new PluginManager([...appPlugins, ...configPlugins]);
    this.artifactService = input.artifactService;
    this.sessionService = input.sessionService;
    this.memoryService = input.memoryService;
    this.credentialService = input.credentialService;
    this.resumabilityConfig =
      input.app?.resumabilityConfig ?? input.resumabilityConfig;
  }

  /**
   * Runs the agent with a new, ephemeral session.
   *
   * @param params.userId The user ID of the session.
   * @param params.newMessage A new message to append to the session.
   * @param params.stateDelta An optional state delta to apply to the session.
   * @param params.runConfig The run config for the agent.
   * @yields The Events generated by the agent.
   */
  async *runEphemeral(params: {
    userId: string;
    newMessage: Content;
    stateDelta?: Record<string, unknown>;
    runConfig?: RunConfig;
    customMetadata?: Record<string, unknown>;
  }): AsyncGenerator<Event, void, undefined> {
    const session = await this.sessionService.createSession({
      appName: this.appName,
      userId: params.userId,
    });
    const sessionId = session.id;

    try {
      yield* this.runAsync({
        userId: params.userId,
        sessionId,
        newMessage: params.newMessage,
        stateDelta: params.stateDelta,
        runConfig: params.runConfig,
        customMetadata: params.customMetadata,
      });
    } finally {
      await this.sessionService.deleteSession({
        appName: this.appName,
        userId: params.userId,
        sessionId,
      });
    }
  }

  /**
   * Runs the agent with the given message, and returns an async generator of
   * events.
   *
   * @param params.userId The user ID of the session.
   * @param params.sessionId The session ID of the session.
   * @param params.newMessage A new message to append to the session.
   * @param params.stateDelta An optional state delta to apply to the session.
   * @param params.runConfig The run config for the agent.
   * @yields The events generated by the agent.
   */
  // TODO - b/425992518: user, sessionId, and runConfig can be internalized.
  async *runAsync(params: {
    userId: string;
    sessionId: string;
    newMessage: Content;
    stateDelta?: Record<string, unknown>;
    runConfig?: RunConfig;
    abortSignal?: AbortSignal;
    customMetadata?: Record<string, unknown>;
  }): AsyncGenerator<Event, void, undefined> {
    const {userId, sessionId, stateDelta} = params;
    const runConfig = createRunConfig(params.runConfig);
    let newMessage = params.newMessage;
    if (newMessage && !newMessage.role) {
      newMessage.role = 'user';
    }

    // =========================================================================
    // Setup the session and invocation context
    // =========================================================================
    const span = tracer.startSpan('invocation');
    const ctx = trace.setSpan(context.active(), span);
    try {
      yield* runAsyncGeneratorWithOtelContext<Runner, Event>(
        ctx,
        this,
        async function* () {
          const session = await this.sessionService.getSession({
            appName: this.appName,
            userId,
            sessionId,
          });

          if (params.abortSignal?.aborted) {
            return;
          }

          if (!session) {
            if (!this.appName) {
              throw new Error(
                `Session lookup failed: appName must be provided in runner constructor (or via app.name)`,
              );
            }
            throw new Error(`Session not found: ${sessionId}`);
          }

          if (runConfig.supportCfc && isLlmAgent(this.agent)) {
            const modelName = this.agent.canonicalModel.model;
            if (!isGemini2OrAbove(modelName)) {
              throw new Error(
                `CFC is not supported for model: ${
                  modelName
                } in agent: ${this.agent.name}`,
              );
            }

            if (!isBuiltInCodeExecutor(this.agent.codeExecutor)) {
              this.agent.codeExecutor = new BuiltInCodeExecutor();
            }
          }

          const invocationContext = new InvocationContext({
            artifactService: this.artifactService
              ? new ScopedArtifactService(
                  this.artifactService,
                  this.appName,
                  userId,
                  sessionId,
                )
              : undefined,
            sessionService: this.sessionService,
            memoryService: this.memoryService,
            credentialService: this.credentialService,
            invocationId: newInvocationContextId(),
            agent: this.agent,
            session,
            userContent: newMessage,
            runConfig,
            pluginManager: this.pluginManager,
            abortSignal: params.abortSignal,
          });

          // =========================================================================
          // Preprocess plugins on user message
          // =========================================================================
          const pluginUserMessage =
            await this.pluginManager.runOnUserMessageCallback({
              userMessage: newMessage,
              invocationContext,
            });

          if (params.abortSignal?.aborted) {
            return;
          }

          if (pluginUserMessage) {
            newMessage = pluginUserMessage as Content;
          }

          // =========================================================================
          // Build the user message event
          // =========================================================================
          let userEvent: Event | undefined;
          if (newMessage) {
            if (!newMessage.parts?.length) {
              throw new Error('No parts in the newMessage.');
            }

            // Directly saves the artifacts (if applicable) in the user message and
            // replaces the artifact data with a file name placeholder.
            // TODO - b/425992518: fix Runner<>>ArtifactService leaky abstraction.
            if (runConfig.saveInputBlobsAsArtifacts) {
              newMessage = await this.saveArtifacts(
                invocationContext.invocationId,
                session.userId,
                session.id,
                newMessage,
              );
              if (params.abortSignal?.aborted) {
                return;
              }
            }
            userEvent = createEvent({
              invocationId: invocationContext.invocationId,
              author: USER_AUTHOR,
              actions: stateDelta
                ? createEventActions({
                    stateDelta: stripReservedStateKeys(stateDelta),
                  })
                : undefined,
              content: newMessage,
              customMetadata: params.customMetadata,
            });
          }

          // =========================================================================
          // Determine which agent should handle the workflow resumption.
          // =========================================================================
          // Resolved before the user message is appended, so that index repairs
          // discovered while resolving can be persisted by its state delta.
          const resumption = resolveResumption(
            session,
            this.agent,
            this.resumabilityConfig,
            userEvent,
          );
          invocationContext.agent = resumption.agent;

          // =========================================================================
          // Append user message to session
          // =========================================================================
          if (userEvent) {
            Object.assign(userEvent.actions.stateDelta, resumption.stateDelta);
            await this.sessionService.appendEvent({session, event: userEvent});
            if (params.abortSignal?.aborted) {
              return;
            }
          }

          // =========================================================================
          // Run the agent with the plugins (aka hooks to apply in the lifecycle)
          // =========================================================================
          if (newMessage) {
            // =========================================================================
            // Run the agent with the plugins (aka hooks to apply in the lifecycle)
            // =========================================================================
            // Step 1: Run the before_run callbacks to see if we should early exit.
            const beforeRunCallbackResponse =
              await this.pluginManager.runBeforeRunCallback({
                invocationContext,
              });
            if (params.abortSignal?.aborted) {
              return;
            }

            if (beforeRunCallbackResponse) {
              const earlyExitEvent = createEvent({
                invocationId: invocationContext.invocationId,
                author: 'model',
                content: beforeRunCallbackResponse,
              });
              this.recordResumptionIndexes(session, earlyExitEvent);
              // TODO: b/447446338 - In the future, do *not* save live call audio
              // content to session This is a feature in Python ADK
              await this.sessionService.appendEvent({
                session,
                event: earlyExitEvent,
              });
              if (params.abortSignal?.aborted) {
                return;
              }

              yield earlyExitEvent;
            } else {
              // Step 2: Otherwise continue with normal execution
              for await (const event of invocationContext.agent.runAsync(
                invocationContext,
              )) {
                if (params.abortSignal?.aborted) {
                  return;
                }

                if (!event.partial) {
                  this.recordResumptionIndexes(session, event);
                  await this.sessionService.appendEvent({session, event});
                }
                // Step 3: Run the on_event callbacks to optionally modify the event.
                const modifiedEvent =
                  await this.pluginManager.runOnEventCallback({
                    invocationContext,
                    event,
                  });
                if (params.abortSignal?.aborted) {
                  return;
                }

                if (modifiedEvent) {
                  yield modifiedEvent;
                } else {
                  yield event;
                }
              }
              // Step 4: Run the after_run callbacks to optionally modify the context.
              await this.pluginManager.runAfterRunCallback({invocationContext});
              if (params.abortSignal?.aborted) {
                return;
              }
            }
          }
        },
      );
    } finally {
      span.end();
      const toolsets = getAllToolsets(this.agent);
      await Promise.allSettled(toolsets.map((t) => t.close()));
    }
  }

  /**
   * Saves artifacts from the message parts and replaces the inline data with
   * a file name placeholder and optional file reference.
   *
   * @param invocationId The current invocation ID.
   * @param userId The user ID of the session.
   * @param sessionId The session ID of the session.
   * @param message The message containing parts to process.
   */
  private async saveArtifacts(
    invocationId: string,
    userId: string,
    sessionId: string,
    message: Content,
  ): Promise<Content> {
    if (!this.artifactService || !message.parts?.length) {
      return message;
    }

    const sessionKey: CompositeSessionKey = {
      appName: this.appName,
      userId,
      sessionId,
    };
    const newParts: Part[] = [];
    let modified = false;

    for (let i = 0; i < message.parts.length; i++) {
      const part = message.parts[i];
      if (!part.inlineData) {
        newParts.push(part);
        continue;
      }

      try {
        const inlineData = part.inlineData;
        const fileName =
          (inlineData as {displayName?: string}).displayName ||
          `artifact_${invocationId}_${i}`;

        const version = await this.artifactService.saveArtifact({
          ...sessionKey,
          filename: fileName,
          artifact: part,
        });

        newParts.push(createPartFromText(`[Uploaded Artifact: "${fileName}"]`));

        try {
          const artifactVersion = await this.artifactService.getArtifactVersion(
            {
              ...sessionKey,
              filename: fileName,
              version,
            },
          );
          if (
            artifactVersion?.canonicalUri &&
            /^(gs|https?):/i.test(artifactVersion.canonicalUri)
          ) {
            newParts.push({
              fileData: {
                fileUri: artifactVersion.canonicalUri,
                mimeType: artifactVersion.mimeType || inlineData.mimeType || '',
                displayName: fileName,
              },
            });
          }
        } catch (error) {
          logger.warn(
            `Failed to resolve artifact version for ${fileName}:`,
            error,
          );
        }
        modified = true;
        logger.info(`Successfully saved artifact: ${fileName}`);
      } catch (error) {
        logger.error(`Failed to save artifact for part ${i}:`, error);
        newParts.push(part);
      }
    }

    if (!modified) {
      return message;
    }

    return {
      ...message,
      parts: newParts,
    };
  }

  /**
   * Determines the next agent to run to continue the session. This is primarily
   * used for session resumption.
   */
  /**
   * Determines the next agent to run to continue the session. This is primarily
   * used for session resumption across tool and LRO boundaries.
   */
  private determineAgentForResumption(
    session: Session,
    rootAgent: BaseAgent,
  ): BaseAgent {
    return determineAgentForResumption(
      session,
      rootAgent,
      this.resumabilityConfig,
    );
  }

  /**
   * Whether the agent to run can transfer to any other agent in the agent tree.
   *
   * @param agentToRun The agent to check for transferability.
   * @returns True if the agent can transfer, False otherwise.
   */
  private isRoutableLlmAgent(agentToRun: BaseAgent): boolean {
    return isRoutableLlmAgent(agentToRun);
  }

  /**
   * Records the resumption indexes for an event on the event's own state
   * delta, so that they are persisted by the session service together with the
   * event rather than only in the in-memory session.
   *
   * Must be called before the event is appended: it reads the state the
   * previous events left behind and writes the next value of each index.
   *
   * @param session The session the event is about to be appended to.
   * @param event The event being appended.
   */
  private recordResumptionIndexes(session: Session, event: Event): void {
    if (event.partial || !event.author || event.author === USER_AUTHOR) {
      return;
    }

    // The transaction index is only read when resuming on a function response,
    // so there is nothing to gain from maintaining it otherwise.
    if (this.resumabilityConfig?.isResumable) {
      const index = readTransactionIndex(session.state);
      let changed = false;
      for (const functionCall of getFunctionCalls(event)) {
        if (functionCall.id) {
          index[functionCall.id] = toTransactionIndexEntry(event);
          changed = true;
        }
      }
      if (changed) {
        // A pruned copy, never the object held by `session.state`: an aliased
        // map would keep mutating the state delta of already-appended events.
        event.actions.stateDelta[TRANSACTION_INDEX_KEY] =
          pruneTransactionIndex(index);
      }
    }

    const agentName = resolveRoutableAgent(this.agent, event.author)
      ? event.author
      : readRoutableAgentMarker(session.state)?.agentName;
    if (agentName) {
      const marker: RoutableAgentMarker = {agentName, eventId: event.id};
      event.actions.stateDelta[LAST_ROUTABLE_AGENT_KEY] = marker;
    }
  }
  // TODO - b/425992518: Implement runLive and related methods.
}

/**
 * Determines the next agent to run to continue the session. This is primarily
 * used for session resumption across tool and LRO boundaries.
 */
export function determineAgentForResumption(
  session: Session,
  rootAgent: BaseAgent,
  resumabilityConfig?: ResumabilityConfig,
): BaseAgent {
  return resolveResumption(session, rootAgent, resumabilityConfig).agent;
}

/**
 * Determines the next agent to run, and the state updates that resolving it
 * produced.
 *
 * The session state indexes maintained by {@link Runner} turn both cases below
 * into O(1) lookups. Both are treated as caches: when an index is absent,
 * stale or malformed, the reverse event scan still decides, so the answer can
 * never disagree with the event log.
 *
 * @param session The session being resumed.
 * @param rootAgent The root agent of the agent tree.
 * @param resumabilityConfig The resumability configuration of the runner.
 * @param pendingEvent The event that is about to be appended to the session,
 *     if any. It is treated as the last event of the session.
 * @returns The agent to run, and a state delta the caller must persist.
 */
function resolveResumption(
  session: Session,
  rootAgent: BaseAgent,
  resumabilityConfig?: ResumabilityConfig,
  pendingEvent?: Event,
): ResumptionResult {
  const events = session.events;
  const stateDelta: Record<string, unknown> = {};

  // =========================================================================
  // Case 1: If the last event is a function response and resumability is enabled,
  // this returns the agent that made the original function call.
  // =========================================================================
  if (resumabilityConfig?.isResumable) {
    const lastEvent = pendingEvent ?? events[events.length - 1];
    const functionCallId = lastEvent
      ? getFunctionResponses(lastEvent)[0]?.id
      : undefined;
    if (functionCallId) {
      const index = readTransactionIndex(session.state);
      const indexed = index[functionCallId];
      // The scan may not look at the pending event: it holds the response, not
      // the call.
      const callEvent = indexed
        ? undefined
        : findEventByFunctionCallId(
            events,
            functionCallId,
            pendingEvent ? events.length : events.length - 1,
          );
      if (callEvent?.author) {
        // Back-fill for sessions written before the index existed, so that
        // later turns take the O(1) path.
        index[functionCallId] = toTransactionIndexEntry(callEvent);
        stateDelta[TRANSACTION_INDEX_KEY] = pruneTransactionIndex(index);
      }
      const author = indexed?.author ?? callEvent?.author;
      if (author) {
        const resumedAgent = rootAgent.findAgent(author);
        if (resumedAgent) {
          return {agent: resumedAgent, stateDelta};
        }
        logger.warn(
          `Function response from an unknown agent: ${author}, event id: ${
            indexed?.eventId ?? callEvent?.id
          }`,
        );
      }
    }
  }

  // =========================================================================
  // Case 2: Otherwise, find the last agent that emitted a message and is
  // transferable across the agent tree.
  // =========================================================================
  const lastAgentEvent = findLastAgentEvent(events);
  if (!lastAgentEvent) {
    // Nothing the backward scan below could match.
    return {agent: rootAgent, stateDelta};
  }

  const marker = readRoutableAgentMarker(session.state);
  if (marker?.eventId === lastAgentEvent.id) {
    const markedAgent = resolveRoutableAgent(rootAgent, marker.agentName);
    if (markedAgent) {
      return {agent: markedAgent, stateDelta};
    }
  }

  for (let i = events.length - 1; i >= 0; i--) {
    logger.debug('event:', JSON.stringify(events[i]));
    const event = events[i];
    if (event.author === USER_AUTHOR || !event.author) {
      continue;
    }

    const agent = resolveRoutableAgent(rootAgent, event.author);
    if (agent) {
      const nextMarker: RoutableAgentMarker = {
        agentName: agent.name,
        eventId: lastAgentEvent.id,
      };
      stateDelta[LAST_ROUTABLE_AGENT_KEY] = nextMarker;
      return {agent, stateDelta};
    }
    if (!rootAgent.findSubAgent(event.author)) {
      logger.warn(
        `Event from an unknown agent: ${event.author}, event id: ${event.id}`,
      );
    }
  }
  // =========================================================================
  // Case 3: default to root agent.
  // =========================================================================
  return {agent: rootAgent, stateDelta};
}

/**
 * Resolves an agent name to the agent that may resume the session: the root
 * agent, or a sub-agent that is routable across the agent tree.
 *
 * @param rootAgent The root agent of the agent tree.
 * @param name The name of the agent to resolve.
 * @returns The agent, or undefined if it cannot resume the session.
 */
function resolveRoutableAgent(
  rootAgent: BaseAgent,
  name: string,
): BaseAgent | undefined {
  if (name === rootAgent.name) {
    return rootAgent;
  }
  const agent = rootAgent.findSubAgent(name);
  return agent && isRoutableLlmAgent(agent) ? agent : undefined;
}

/**
 * Returns the newest event authored by an agent rather than by the user, which
 * is the newest event the resumption scan can match.
 *
 * @param events The events of the session, oldest first.
 * @returns The newest agent-authored event, or undefined if there is none.
 */
function findLastAgentEvent(events: Event[]): Event | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event.author && event.author !== USER_AUTHOR) {
      return event;
    }
  }
  return undefined;
}

/**
 * Reads the transaction index from session state, dropping anything that is
 * not a well-formed entry. Session state is client-writable and may have been
 * written by an older version, so it is validated rather than trusted.
 *
 * @param state The session state to read.
 * @returns A fresh index the caller owns and may mutate.
 */
function readTransactionIndex(
  state: Record<string, unknown>,
): Record<string, TransactionIndexEntry> {
  const index: Record<string, TransactionIndexEntry> = {};
  const stored = state[TRANSACTION_INDEX_KEY];
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) {
    return index;
  }
  for (const [functionCallId, entry] of Object.entries(stored)) {
    if (isTransactionIndexEntry(entry)) {
      index[functionCallId] = entry;
    }
  }
  return index;
}

/**
 * Whether a value read back from session state is a transaction index entry.
 */
function isTransactionIndexEntry(
  value: unknown,
): value is TransactionIndexEntry {
  if (!value || typeof value !== 'object') {
    return false;
  }
  const entry = value as Partial<TransactionIndexEntry>;
  return (
    typeof entry.author === 'string' &&
    typeof entry.eventId === 'string' &&
    typeof entry.timestamp === 'number'
  );
}

/**
 * Reads the routable agent marker from session state, returning undefined when
 * it is absent or malformed.
 */
function readRoutableAgentMarker(
  state: Record<string, unknown>,
): RoutableAgentMarker | undefined {
  const stored = state[LAST_ROUTABLE_AGENT_KEY];
  if (!stored || typeof stored !== 'object') {
    return undefined;
  }
  const marker = stored as Partial<RoutableAgentMarker>;
  if (!marker.agentName || typeof marker.eventId !== 'string') {
    return undefined;
  }
  return {agentName: marker.agentName, eventId: marker.eventId};
}

/**
 * Describes the event that issued a function call.
 */
function toTransactionIndexEntry(event: Event): TransactionIndexEntry {
  return {
    author: event.author ?? '',
    eventId: event.id,
    timestamp: event.timestamp,
  };
}

/**
 * Evicts the oldest entries until the index fits in
 * {@link MAX_TRACKED_TRANSACTIONS}.
 *
 * @param index An index owned by the caller; it is mutated in place.
 * @returns The same index, for chaining.
 */
function pruneTransactionIndex(
  index: Record<string, TransactionIndexEntry>,
): Record<string, TransactionIndexEntry> {
  const functionCallIds = Object.keys(index);
  const excess = functionCallIds.length - MAX_TRACKED_TRANSACTIONS;
  if (excess <= 0) {
    return index;
  }
  functionCallIds.sort((a, b) => index[a].timestamp - index[b].timestamp);
  for (let i = 0; i < excess; i++) {
    delete index[functionCallIds[i]];
  }
  return index;
}

/**
 * Removes the runner-owned keys from a caller-supplied state delta.
 *
 * Resumption routing reads these keys, so honoring them from a client would
 * let it pick the agent that handles the next turn.
 *
 * @param stateDelta The caller-supplied state delta.
 * @returns A copy without the reserved keys.
 */
function stripReservedStateKeys(
  stateDelta: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized = {...stateDelta};
  for (const key of RESERVED_STATE_KEYS) {
    if (key in sanitized) {
      delete sanitized[key];
      logger.warn(`Ignoring reserved key in the provided state delta: ${key}`);
    }
  }
  return sanitized;
}

/**
 * Whether the agent to run can transfer to any other agent in the agent tree.
 *
 * An agent is transferable if:
 *  - It is an instance of `LlmAgent`.
 *  - All its ancestors are also transferable (i.e., they have
 *    `disallowTransferToParent` set to false).
 *
 * @param agentToRun The agent to check for transferability.
 * @returns True if the agent can transfer, False otherwise.
 */
export function isRoutableLlmAgent(agentToRun: BaseAgent): boolean {
  let agent: BaseAgent | undefined = agentToRun;
  while (agent) {
    if (!isLlmAgent(agent)) {
      return false;
    }
    if (agent.disallowTransferToParent) {
      return false;
    }
    agent = agent.parentAgent;
  }
  return true;
}

/**
 * It iterates through the events in reverse order, and returns the event
 * containing a function call with a functionCall.id matching the
 * functionResponse.id from the last event in the session.
 */
export function findEventByLastFunctionResponseId(
  events: Event[],
): Event | null {
  return findMatchingFunctionCall(events) ?? null;
}

function getAllToolsets(agent: BaseAgent): BaseToolset[] {
  const toolsets: BaseToolset[] = [];
  const visited = new Set<BaseAgent>();

  function traverse(curr: BaseAgent) {
    if (visited.has(curr)) return;
    visited.add(curr);

    if (isLlmAgent(curr)) {
      for (const tool of curr.tools) {
        if (isBaseToolset(tool)) {
          toolsets.push(tool);
        }
      }
    }

    for (const sub of curr.subAgents) {
      traverse(sub);
    }
  }

  traverse(agent);
  return toolsets;
}
