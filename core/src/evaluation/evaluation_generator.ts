/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Content} from '@google/genai';

import {BaseAgent} from '../agents/base_agent.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {InMemoryArtifactService} from '../artifacts/in_memory_artifact_service.js';
import {
  createEvent,
  Event,
  getFunctionCalls,
  isFinalResponse,
} from '../events/event.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {Runner} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {AppDetails} from './app_details.js';
import {Invocation, InvocationEvent, SessionInput} from './eval_case.js';
import {RequestIntercepterPlugin} from './request_intercepter_plugin.js';
import {EnsureRetryOptionsPlugin} from './retry_options_utils.js';
import {Status, UserSimulator} from './simulation/user_simulator.js';

/** Author used for synthetic user events. */
const USER_AUTHOR = 'user';
/** Author used when an event has no author of its own. */
const DEFAULT_AUTHOR = 'agent';

/**
 * App name used for the eval session when neither the caller nor the eval
 * case's session input supplies one.
 */
export const DEFAULT_EVAL_APP_NAME = 'EvaluationGenerator';

/**
 * User id used for the eval session when the eval case's session input does
 * not supply one.
 *
 * Shared with `local_eval_service.ts`, which reads the session back with the
 * same default; the lookup only succeeds while the two agree.
 */
export const DEFAULT_EVAL_USER_ID = 'test_user_id';

/**
 * Options for {@link EvaluationGenerator.generateInferencesFromRootAgent}.
 */
export interface GenerateInferencesFromRootAgentParams {
  /** The agent to run against the (simulated) user. */
  rootAgent: BaseAgent;
  /** Produces the user messages that drive the conversation. */
  userSimulator: UserSimulator;
  /**
   * App name to create the eval session under. Takes precedence over
   * `initialSession.appName`, and must match the app name the caller later
   * reads the session back with. Defaults to
   * {@link DEFAULT_EVAL_APP_NAME}.
   */
  appName?: string;
  /** Values that help initialize the session (app name, user id, state). */
  initialSession?: SessionInput;
  /** The session id to use. A random one is generated when omitted. */
  sessionId?: string;
  /** The session service to use. Defaults to an in-memory service. */
  sessionService?: BaseSessionService;
  /** The artifact service to use. Defaults to an in-memory service. */
  artifactService?: BaseArtifactService;
  /** The memory service to use. Defaults to an in-memory service. */
  memoryService?: BaseMemoryService;
}

/**
 * Generates evaluation `Invocation`s by driving a `Runner` with a
 * {@link UserSimulator} and projecting the resulting events.
 *
 * This is the non-live (request/response) subset of adk-python's
 * `EvaluationGenerator`; live (bidi-streaming) inference is not yet supported in
 * adk-js.
 */
export class EvaluationGenerator {
  /**
   * Runs a single user turn and yields the resulting events, prefixed with a
   * synthetic user event carrying the invocation id of the turn.
   */
  static async *generateInferencesForSingleUserInvocation(
    runner: Runner,
    userId: string,
    sessionId: string,
    userContent: Content,
  ): AsyncGenerator<Event> {
    let invocationId: string | undefined;

    for await (const event of runner.runAsync({
      userId,
      sessionId,
      newMessage: userContent,
    })) {
      if (!invocationId) {
        invocationId = event.invocationId;
        yield createEvent({
          content: userContent,
          author: USER_AUTHOR,
          invocationId,
        });
      }
      yield event;
    }
  }

  /**
   * Drives the root agent with the user simulator until the simulator stops,
   * then returns the resulting eval invocations.
   */
  static async generateInferencesFromRootAgent({
    rootAgent,
    userSimulator,
    appName,
    initialSession,
    sessionId,
    sessionService,
    artifactService,
    memoryService,
  }: GenerateInferencesFromRootAgentParams): Promise<Invocation[]> {
    const resolvedSessionService =
      sessionService ?? new InMemorySessionService();
    const resolvedMemoryService = memoryService ?? new InMemoryMemoryService();
    const resolvedAppName =
      appName ?? initialSession?.appName ?? DEFAULT_EVAL_APP_NAME;
    const userId = initialSession?.userId ?? DEFAULT_EVAL_USER_ID;
    const resolvedSessionId = sessionId ?? randomUUID();

    await resolvedSessionService.createSession({
      appName: resolvedAppName,
      userId,
      state: initialSession?.state ?? {},
      sessionId: resolvedSessionId,
    });

    const resolvedArtifactService =
      artifactService ?? new InMemoryArtifactService();

    const requestIntercepterPlugin = new RequestIntercepterPlugin(
      'request_intercepter_plugin',
    );
    // Ensure the agent's LLM requests have retries, so that transient model
    // outages do not fail the inference stage of evals.
    const ensureRetryOptionsPlugin = new EnsureRetryOptionsPlugin(
      'ensure_retry_options',
    );

    const runner = new Runner({
      appName: resolvedAppName,
      agent: rootAgent,
      artifactService: resolvedArtifactService,
      sessionService: resolvedSessionService,
      memoryService: resolvedMemoryService,
      plugins: [requestIntercepterPlugin, ensureRetryOptionsPlugin],
    });

    const events: Event[] = [];
    for (;;) {
      // simplicity: pass the live event history directly. The only shipped
      // simulator (static) ignores it; a history-reading simulator would add
      // its own defensive copy when that path lands.
      const nextUserMessage = await userSimulator.getNextUserMessage(events);
      if (
        nextUserMessage.status !== Status.SUCCESS ||
        nextUserMessage.userMessage === undefined
      ) {
        break;
      }

      const userMessage = nextUserMessage.userMessage;
      for await (const event of EvaluationGenerator.generateInferencesForSingleUserInvocation(
        runner,
        userId,
        resolvedSessionId,
        userMessage,
      )) {
        events.push(event);
      }
    }

    const appDetailsByInvocationId =
      EvaluationGenerator.getAppDetailsByInvocationId(
        events,
        requestIntercepterPlugin,
      );
    return EvaluationGenerator.convertEventsToEvalInvocations(
      events,
      appDetailsByInvocationId,
    );
  }

  /**
   * Converts a list of events to eval invocations, grouped by invocation id.
   */
  static convertEventsToEvalInvocations(
    events: Event[],
    appDetailsPerInvocation?: Record<string, AppDetails>,
  ): Invocation[] {
    const eventsByInvocationId =
      EvaluationGenerator.collectEventsByInvocationId(events);

    const invocations: Invocation[] = [];
    for (const [invocationId, invocationEvents] of eventsByInvocationId) {
      let finalEvent: Event | undefined;
      let userContent: Content = {parts: []};
      let invocationTimestamp = 0;
      const appDetails = appDetailsPerInvocation?.[invocationId];

      const eventsToAdd: Event[] = [];

      for (const event of invocationEvents) {
        const currentAuthor = (event.author ?? DEFAULT_AUTHOR).toLowerCase();

        if (currentAuthor === USER_AUTHOR) {
          // The user event only identifies the user content and timestamp.
          if (event.content !== undefined) {
            userContent = event.content;
            invocationTimestamp = event.timestamp;
          }
          continue;
        }

        if (event.content && event.content.parts) {
          if (isFinalResponse(event)) {
            finalEvent = event;
          }

          const carriesContent = event.content.parts.some(
            (part) =>
              part.functionCall ||
              part.functionResponse ||
              part.text ||
              part.inlineData,
          );
          if (carriesContent) {
            eventsToAdd.push(event);
          }
        }
      }

      // The final event is excluded from intermediate data unless it also
      // carries tool calls (e.g. skip-summarization tool-call events).
      const invocationEventsList: InvocationEvent[] = eventsToAdd
        .filter(
          (event) => event !== finalEvent || getFunctionCalls(event).length > 0,
        )
        .map((event) => ({
          author: event.author ?? DEFAULT_AUTHOR,
          content: event.content,
        }));

      invocations.push({
        invocationId,
        userContent,
        finalResponse: finalEvent?.content,
        intermediateData: {invocationEvents: invocationEventsList},
        creationTimestamp: invocationTimestamp,
        appDetails,
      });
    }

    return invocations;
  }

  /**
   * Builds per-invocation {@link AppDetails} by recovering the LLM request that
   * produced each agent event (via the request intercepter).
   *
   * Internal: takes the internal `RequestIntercepterPlugin`, so it is kept off
   * the public surface.
   */
  private static getAppDetailsByInvocationId(
    events: Event[],
    requestIntercepter: RequestIntercepterPlugin,
  ): Record<string, AppDetails> {
    const eventsByInvocationId =
      EvaluationGenerator.collectEventsByInvocationId(events);
    const appDetailsByInvocationId: Record<string, AppDetails> = {};

    for (const [invocationId, invocationEvents] of eventsByInvocationId) {
      const appDetails: AppDetails = {agentDetails: {}};
      appDetailsByInvocationId[invocationId] = appDetails;

      for (const event of invocationEvents) {
        if (event.author === USER_AUTHOR) {
          continue;
        }

        const llmRequest = requestIntercepter.getModelRequest(event);
        if (!llmRequest) {
          continue;
        }

        const author = event.author;
        if (author !== undefined && !(author in appDetails.agentDetails)) {
          const systemInstruction = llmRequest.config?.systemInstruction;
          appDetails.agentDetails[author] = {
            name: author,
            instructions:
              typeof systemInstruction === 'string' ? systemInstruction : '',
            toolDeclarations: llmRequest.config?.tools ?? [],
          };
        }
      }
    }

    return appDetailsByInvocationId;
  }

  /**
   * Groups events by invocation id, preserving first-seen order.
   */
  private static collectEventsByInvocationId(
    events: Event[],
  ): Map<string, Event[]> {
    const eventsByInvocationId = new Map<string, Event[]>();

    for (const event of events) {
      const existing = eventsByInvocationId.get(event.invocationId);
      if (existing === undefined) {
        eventsByInvocationId.set(event.invocationId, [event]);
      } else {
        existing.push(event);
      }
    }

    return eventsByInvocationId;
  }
}
