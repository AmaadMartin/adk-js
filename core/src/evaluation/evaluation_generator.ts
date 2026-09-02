/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Content,
  ContentUnion,
  Part,
  PartUnion,
  Tool,
  ToolUnion,
} from '@google/genai';
import {readFile} from 'node:fs/promises';

import {isBaseAgent} from '../agents/base_agent.js';
import {App, isApp} from '../apps/app.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {InMemoryArtifactService} from '../artifacts/in_memory_artifact_service.js';
import {InputValidationError} from '../errors/input_validation_error.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {
  createEvent,
  Event,
  getFunctionCalls,
  isFinalResponse,
} from '../events/event.js';
import {BaseMemoryService} from '../memory/base_memory_service.js';
import {InMemoryMemoryService} from '../memory/in_memory_memory_service.js';
import {BasePlugin} from '../plugins/base_plugin.js';
import {Runner, RunnerConfig} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {Session} from '../sessions/session.js';
import {randomUUID} from '../utils/env_aware_utils.js';
import {logger} from '../utils/logger.js';
import {
  isRunnableRoot,
  RunnableRoot,
} from '../workflow/run_node_as_invocation.js';

import {AgentDetails, AppDetails} from './app_details.js';
import {
  EvalCase,
  Invocation,
  InvocationEvent,
  SessionInput,
} from './eval_case.js';
import {EvalSet} from './eval_set.js';
import {RequestIntercepterPlugin} from './request_intercepter_plugin.js';
import {
  UserSimulator,
  validateNextUserMessage,
} from './simulation/user_simulator.js';

/** Author of the events the user contributed to a session. */
const USER_AUTHOR = 'user';

/** Author recorded for an event that names none. */
const DEFAULT_AUTHOR = 'agent';

/** App name an eval conversation runs under when the caller names none. */
const DEFAULT_EVAL_APP_NAME = 'EvaluationGenerator';

/** User an eval conversation runs as when the caller names none. */
const DEFAULT_EVAL_USER_ID = 'test_user_id';

/** Name of the intercepter plugin installed on every eval `Runner`. */
const REQUEST_INTERCEPTER_PLUGIN_NAME = 'request_intercepter_plugin';

/** How many times an eval case runs when the caller asks for no count. */
const DEFAULT_REPEAT_NUM = 3;

/**
 * Row key holding the query an eval row grades. Supplied by the caller, in the
 * original (snake_case) eval-data format.
 */
const QUERY_KEY = 'query';

/** Row key {@link processQueryWithSession} writes the recorded tool calls to. */
const ACTUAL_TOOL_USE_KEY = 'actual_tool_use';

/** Row key {@link processQueryWithSession} writes the final text response to. */
const RESPONSE_KEY = 'response';

/** Message of the error a module with an uncallable `resetData` produces. */
const RESET_DATA_NOT_CALLABLE_ERROR =
  'agent.resetData must be callable when provided.';

/** Message of the error an eval row without a string query produces. */
const NON_STRING_QUERY_ERROR =
  'Each evaluation entry must contain a string query.';

/**
 * One row of an eval dataset: the `query` the row grades, plus whatever fields
 * the caller's evaluators read.
 */
export type EvalRow = Record<string, unknown>;

/**
 * Every response set recorded for one eval case, one set per repeat.
 *
 * Repeating a case averages out the variance a single model run brings.
 */
export interface EvalCaseResponses {
  evalCase: EvalCase;

  /** The invocations of each run, in the order the runs happened. */
  responses: Invocation[][];
}

/** A tool call {@link processQueryWithSession} recovers from a session. */
interface RecordedToolUse {
  tool_name?: string;
  tool_input?: Record<string, unknown>;
}

/** The members an agent module exposes to the eval system. */
interface AgentModuleNamespace {
  agent?: {
    app?: unknown;
    rootAgent?: unknown;
    resetData?: unknown;
  };
}

function isResetFunction(value: unknown): value is () => unknown {
  return typeof value === 'function';
}

/**
 * A `CallableTool` carries no declarations to record, only the code that runs
 * it, so only the declarative arm of the union reaches `AgentDetails`.
 */
function isDeclarativeTool(tool: ToolUnion): tool is Tool {
  return !('callTool' in tool);
}

function hasTextPart(parts: Part[]): boolean {
  return parts.some((part) => Boolean(part.text));
}

function isGradablePart(part: Part): boolean {
  return Boolean(
    part.functionCall || part.functionResponse || part.text || part.inlineData,
  );
}

function partUnionText(part: PartUnion): string {
  return typeof part === 'string' ? part : (part.text ?? '');
}

/**
 * `Content` and `Part` share no required field, so `in` cannot separate them:
 * every property either type declares is optional, which leaves both arms in
 * both branches. This checks the two fields only a `Content` ever carries.
 */
function isContent(value: Content | Part): value is Content {
  return 'parts' in value || 'role' in value;
}

/**
 * Returns a deep copy of the events.
 *
 * `structuredClone` drops the symbol brand `isEvent` checks, so each copy is
 * rebuilt through `createEvent`.
 */
function copyEvents(events: Event[]): Event[] {
  return events.map((event) => createEvent(structuredClone(event)));
}

/**
 * Flattens the system instruction of a request into the plain text
 * `AgentDetails.instructions` holds.
 *
 * @param systemInstruction The instruction as `@google/genai` models it.
 * @returns The instruction text, or an empty string when there is none.
 */
export function toInstructionText(systemInstruction?: ContentUnion): string {
  if (systemInstruction === undefined) {
    return '';
  }
  if (typeof systemInstruction === 'string') {
    return systemInstruction;
  }
  if (Array.isArray(systemInstruction)) {
    return systemInstruction.map(partUnionText).join('\n');
  }
  if (isContent(systemInstruction)) {
    return (systemInstruction.parts ?? []).map(partUnionText).join('\n');
  }
  return partUnionText(systemInstruction);
}

/**
 * Groups events by the invocation they belong to.
 *
 * @param events The events to group.
 * @returns The events of each invocation, keyed by invocation id. Both the
 *     keys and the events within a group keep the order they were seen in.
 */
export function collectEventsByInvocationId(
  events: Event[],
): Map<string, Event[]> {
  const eventsByInvocationId = new Map<string, Event[]>();
  for (const event of events) {
    const group = eventsByInvocationId.get(event.invocationId);
    if (group) {
      group.push(event);
    } else {
      eventsByInvocationId.set(event.invocationId, [event]);
    }
  }
  return eventsByInvocationId;
}

/**
 * Turns a recorded event stream into the invocations the eval system grades.
 *
 * One invocation comes out per distinct invocation id, in first-seen order.
 * The user turn becomes `userContent`, the agent's last gradable reply becomes
 * `finalResponse`, and everything the agent did on the way there — tool calls,
 * tool responses, sub-agent replies, grounded answers — becomes
 * `intermediateData`.
 *
 * @param events The events to convert.
 * @param appDetailsPerInvocation App details keyed by invocation id, recording
 *     what each agent was shown during the invocation.
 * @returns One gradable invocation per invocation id.
 */
export function convertEventsToEvalInvocations(
  events: Event[],
  appDetailsPerInvocation?: Record<string, AppDetails>,
): Invocation[] {
  const invocations: Invocation[] = [];

  for (const [invocationId, groupEvents] of collectEventsByInvocationId(
    events,
  )) {
    let finalResponse: Content | undefined;
    let finalResponseParts: Part[] | undefined;
    let finalEvent: Event | undefined;
    let userContent: Content = {parts: []};
    let creationTimestamp = 0;
    const eventsToAdd: Event[] = [];

    for (const event of groupEvents) {
      if ((event.author ?? DEFAULT_AUTHOR).toLowerCase() === USER_AUTHOR) {
        if (event.content !== undefined) {
          userContent = event.content;
          creationTimestamp = event.timestamp;
        }
        continue;
      }

      const content = event.content;
      const parts = content?.parts;
      if (content !== undefined && parts !== undefined && parts.length > 0) {
        if (isFinalResponse(event)) {
          // A live turn arrives as both audio and a text transcript. Keep the
          // text one, which is what an evaluator can grade.
          if (
            finalResponseParts === undefined ||
            !hasTextPart(finalResponseParts) ||
            hasTextPart(parts)
          ) {
            finalResponse = content;
            finalResponseParts = parts;
            finalEvent = event;
          }
        }
        if (
          event.groundingMetadata !== undefined ||
          parts.some(isGradablePart)
        ) {
          eventsToAdd.push(event);
        }
      } else if (event.groundingMetadata !== undefined) {
        eventsToAdd.push(event);
      }
    }

    const invocationEvents: InvocationEvent[] = [];
    for (const event of eventsToAdd) {
      const isFinalEvent = event === finalEvent;
      const callsTools = getFunctionCalls(event).length > 0;
      // The final event is already reported as `finalResponse`. It is repeated
      // here only when it carries something extra an evaluator needs: a tool
      // call, or grounding metadata.
      if (
        isFinalEvent &&
        !callsTools &&
        event.groundingMetadata === undefined
      ) {
        continue;
      }
      invocationEvents.push({
        author: event.author ?? DEFAULT_AUTHOR,
        content: !isFinalEvent || callsTools ? event.content : undefined,
        groundingMetadata: event.groundingMetadata,
      });
    }

    invocations.push({
      invocationId,
      userContent,
      finalResponse,
      intermediateData: {invocationEvents},
      creationTimestamp,
      appDetails: appDetailsPerInvocation?.[invocationId],
    });
  }

  return invocations;
}

/**
 * Recovers what each agent was shown during a run.
 *
 * Autorater metrics grade against the instructions and tools the model saw.
 * Those live on the request, so they are read back through the intercepter
 * that recorded them.
 *
 * @param events The events of the run.
 * @param requestIntercepter The plugin that intercepted the run's requests.
 * @returns The app details of each invocation, keyed by invocation id. An
 *     invocation that made no model request gets an empty entry.
 */
export function getAppDetailsByInvocationId(
  events: Event[],
  requestIntercepter: RequestIntercepterPlugin,
): Record<string, AppDetails> {
  const appDetailsByInvocationId: Record<string, AppDetails> = {};

  for (const [invocationId, groupEvents] of collectEventsByInvocationId(
    events,
  )) {
    const agentDetails: Record<string, AgentDetails> = {};
    appDetailsByInvocationId[invocationId] = {agentDetails};

    for (const event of groupEvents) {
      if (event.author === USER_AUTHOR) {
        continue;
      }
      const llmRequest = requestIntercepter.getModelRequest(event);
      if (!llmRequest) {
        continue;
      }
      const agentName = event.author ?? DEFAULT_AUTHOR;
      if (!(agentName in agentDetails)) {
        agentDetails[agentName] = {
          name: agentName,
          instructions: toInstructionText(llmRequest.config?.systemInstruction),
          toolDeclarations: (llmRequest.config?.tools ?? []).filter(
            isDeclarativeTool,
          ),
        };
      }
    }
  }

  return appDetailsByInvocationId;
}

/**
 * Returns the session an eval case runs in.
 *
 * A pinned session id may name a session the caller prepared, so that session
 * is reused rather than replaced; `initialSession.state` then applies only
 * when the session is created.
 *
 * @param sessionService The service the session lives in.
 * @param initialSession The app, user, id and state the case asks for.
 * @param fallbackSessionId Id to create the session under when the case pins
 *     none.
 * @returns The session to run in.
 */
async function getOrCreateEvalSession(
  sessionService: BaseSessionService,
  initialSession?: SessionInput,
  fallbackSessionId?: string,
): Promise<Session> {
  const appName = initialSession?.appName ?? DEFAULT_EVAL_APP_NAME;
  const userId = initialSession?.userId ?? DEFAULT_EVAL_USER_ID;
  const pinnedSessionId = initialSession?.sessionId;

  if (pinnedSessionId) {
    const session = await sessionService.getSession({
      appName,
      userId,
      sessionId: pinnedSessionId,
    });
    if (session) {
      return session;
    }
  }

  return sessionService.createSession({
    appName,
    userId,
    state: initialSession?.state ?? {},
    sessionId: pinnedSessionId ?? fallbackSessionId ?? randomUUID(),
  });
}

/**
 * Returns the `Runner` configuration that evaluates `rootAgent`.
 *
 * With an `app`, the Runner is built from a copy of it that merges the
 * internal eval plugins into `app.plugins`, so the app's own plugins and
 * configuration take part in the eval run. The copy leaves the caller's `App`
 * untouched, and `rootAgent` overrides its root so the Runner targets the
 * agent the caller asked to evaluate, which may be a sub-agent. Without an
 * `app`, the Runner is built from the bare `rootAgent`.
 *
 * @param params.rootAgent The agent under evaluation.
 * @param params.appName The app name the session runs under.
 * @param params.app The app the agent belongs to, when there is one.
 * @param params.internalEvalPlugins Plugins the eval system installs itself.
 * @param params.sessionService The service the session lives in.
 * @param params.artifactService The service artifacts live in.
 * @param params.memoryService The service memory lives in.
 * @returns A configuration ready to construct a `Runner` from.
 */
export function buildEvalRunnerConfig(params: {
  rootAgent: RunnableRoot;
  appName: string;
  app?: App;
  internalEvalPlugins: BasePlugin[];
  sessionService: BaseSessionService;
  artifactService?: BaseArtifactService;
  memoryService?: BaseMemoryService;
}): RunnerConfig {
  const {rootAgent, appName, app, internalEvalPlugins, ...services} = params;

  if (app === undefined) {
    return {
      appName,
      agent: rootAgent,
      plugins: internalEvalPlugins,
      ...services,
    };
  }

  // The copy is named after the session, not after `app`: a `Runner` built
  // from an app takes its app name from `app.name`, and that is the name it
  // looks the session up under. adk-python's `Runner` prefers the explicit
  // `app_name` instead, and reaches the same session either way.
  const runnerApp = new App({
    name: appName,
    rootAgent,
    plugins: [...app.plugins, ...internalEvalPlugins],
    resumabilityConfig: app.resumabilityConfig,
  });
  return {app: runnerApp, appName, ...services};
}

/**
 * Runs one user turn and yields the events it produced.
 *
 * The user turn itself is not an event the runner emits, so a synthetic one is
 * yielded first, carrying the invocation id the runner assigned. That is what
 * lets {@link convertEventsToEvalInvocations} pair a user turn with the
 * agent's reply.
 *
 * @param params.runner The runner driving the agent.
 * @param params.userId The user the session belongs to.
 * @param params.sessionId The session to append the turn to.
 * @param params.userContent The user turn to send.
 * @yields The synthetic user event, then every event the runner produced.
 */
export async function* generateInferencesForSingleUserInvocation(params: {
  runner: Runner;
  userId: string;
  sessionId: string;
  userContent: Content;
}): AsyncGenerator<Event> {
  const {runner, userId, sessionId, userContent} = params;
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
 * Drives an agent through a whole simulated conversation and returns what it
 * did, ready to grade.
 *
 * The user simulator supplies one turn at a time and decides when the
 * conversation ends. It sees a copy of the conversation so far, so it cannot
 * disturb the record the eval system keeps.
 *
 * @param params.rootAgent The agent under evaluation.
 * @param params.userSimulator The simulator playing the user.
 * @param params.resetFunc Clears agent-owned state; called once before the run.
 * @param params.initialSession The session the conversation runs in.
 * @param params.sessionId Id to create the session under when
 *     `initialSession` pins none.
 * @param params.sessionService Defaults to a fresh `InMemorySessionService`.
 * @param params.artifactService Defaults to a fresh `InMemoryArtifactService`.
 * @param params.memoryService Defaults to a fresh `InMemoryMemoryService`.
 * @param params.app The app the agent belongs to, when there is one.
 * @returns One invocation per turn of the conversation.
 */
export async function generateInferencesFromRootAgent(params: {
  rootAgent: RunnableRoot;
  userSimulator: UserSimulator;
  resetFunc?: () => unknown;
  initialSession?: SessionInput;
  sessionId?: string;
  sessionService?: BaseSessionService;
  artifactService?: BaseArtifactService;
  memoryService?: BaseMemoryService;
  app?: App;
}): Promise<Invocation[]> {
  const sessionService = params.sessionService ?? new InMemorySessionService();
  const memoryService = params.memoryService ?? new InMemoryMemoryService();
  const artifactService =
    params.artifactService ?? new InMemoryArtifactService();

  const session = await getOrCreateEvalSession(
    sessionService,
    params.initialSession,
    params.sessionId,
  );

  params.resetFunc?.();

  const requestIntercepter = new RequestIntercepterPlugin(
    REQUEST_INTERCEPTER_PLUGIN_NAME,
  );
  const runner = new Runner(
    buildEvalRunnerConfig({
      rootAgent: params.rootAgent,
      appName: session.appName,
      app: params.app,
      internalEvalPlugins: [requestIntercepter],
      sessionService,
      artifactService,
      memoryService,
    }),
  );

  const events: Event[] = [];
  for (;;) {
    const next = await params.userSimulator.getNextUserMessage(
      copyEvents(events),
    );
    validateNextUserMessage(next);
    // The validator ties the two together: there is a message exactly when the
    // status is SUCCESS, so no message means the conversation is over.
    const userContent = next.userMessage;
    if (userContent === undefined) {
      break;
    }
    for await (const event of generateInferencesForSingleUserInvocation({
      runner,
      userId: session.userId,
      sessionId: session.id,
      userContent,
    })) {
      events.push(event);
    }
  }

  return convertEventsToEvalInvocations(
    events,
    getAppDetailsByInvocationId(events, requestIntercepter),
  );
}

/**
 * Loads an agent from a module and evaluates it.
 *
 * The module must expose an `agent` member holding either an `App` (preferred,
 * so the app's plugins and configuration take part in the run) or a
 * `rootAgent`. An optional `resetData` function on the same member clears
 * agent-owned state before the run.
 *
 * @param params.modulePath The module to import the agent from.
 * @param params.userSimulator The simulator playing the user.
 * @param params.agentName Evaluate this descendant instead of the root.
 * @param params.initialSession The session the conversation runs in.
 * @returns One invocation per turn of the conversation.
 * @throws {InputValidationError} If the module exposes no root agent, or its
 *     `resetData` is not callable.
 * @throws {NotFoundError} If `agentName` names no descendant of the root.
 */
export async function generateInferencesFromAgentModule(params: {
  modulePath: string;
  userSimulator: UserSimulator;
  agentName?: string;
  initialSession?: SessionInput;
}): Promise<Invocation[]> {
  const agentModule: AgentModuleNamespace = await import(params.modulePath);
  const agentNamespace = agentModule.agent;

  const appCandidate = agentNamespace?.app;
  const app = isApp(appCandidate) ? appCandidate : undefined;
  const rootCandidate = app ? app.rootAgent : agentNamespace?.rootAgent;
  if (!isRunnableRoot(rootCandidate)) {
    throw new InputValidationError(
      `Module '${params.modulePath}' does not expose agent.rootAgent.`,
    );
  }

  const resetCandidate = agentNamespace?.resetData;
  if (resetCandidate !== undefined && !isResetFunction(resetCandidate)) {
    throw new InputValidationError(RESET_DATA_NOT_CALLABLE_ERROR);
  }

  let agentToEvaluate: RunnableRoot = rootCandidate;
  if (params.agentName) {
    const selectedAgent = isBaseAgent(rootCandidate)
      ? rootCandidate.findAgent(params.agentName)
      : undefined;
    if (!selectedAgent) {
      throw new NotFoundError(`Sub-Agent '${params.agentName}' not found.`);
    }
    agentToEvaluate = selectedAgent;
  }

  return generateInferencesFromRootAgent({
    rootAgent: agentToEvaluate,
    userSimulator: params.userSimulator,
    resetFunc: resetCandidate,
    initialSession: params.initialSession,
    app,
  });
}

/**
 * Runs every case of an eval set against an agent, repeatedly.
 *
 * A single run of a case says little, because a model answers the same prompt
 * differently each time. Repeating the case gives the metrics several samples
 * to average over.
 *
 * @param params.evalSet The cases to run.
 * @param params.agentModulePath The module to import the agent from.
 * @param params.repeatNum How many times each case runs. Defaults to 3.
 * @param params.agentName Evaluate this descendant instead of the root.
 * @param params.createUserSimulator Builds the simulator that plays the user
 *     for one run of one case. It is called once per repeat, because a
 *     simulator is stateful across the turns of the conversation it drives.
 * @returns One entry per eval case, holding the invocations of every repeat.
 */
export async function generateResponses(params: {
  evalSet: EvalSet;
  agentModulePath: string;
  repeatNum?: number;
  agentName?: string;
  createUserSimulator: (evalCase: EvalCase) => UserSimulator;
}): Promise<EvalCaseResponses[]> {
  const repeatNum = params.repeatNum ?? DEFAULT_REPEAT_NUM;
  const results: EvalCaseResponses[] = [];

  for (const evalCase of params.evalSet.evalCases) {
    const responses: Invocation[][] = [];
    for (let repeat = 0; repeat < repeatNum; repeat++) {
      responses.push(
        await generateInferencesFromAgentModule({
          modulePath: params.agentModulePath,
          userSimulator: params.createUserSimulator(evalCase),
          agentName: params.agentName,
          initialSession: evalCase.sessionInput,
        }),
      );
    }
    results.push({evalCase, responses});
  }

  return results;
}

/**
 * Annotates eval rows with what an agent actually did, read back from a
 * recorded session instead of a fresh run.
 *
 * @param sessionData The recorded session.
 * @param rows The eval rows to annotate. They are copied, not modified.
 * @returns The annotated copies, each carrying `actual_tool_use` and
 *     `response`.
 * @throws {InputValidationError} If a row's `query` is not a string.
 */
export function processQueryWithSession(
  sessionData: Session,
  rows: EvalRow[],
): EvalRow[] {
  return rows.map((row) => {
    const query = row[QUERY_KEY];
    if (typeof query !== 'string') {
      throw new InputValidationError(NON_STRING_QUERY_ERROR);
    }

    const actualToolUses: RecordedToolUse[] = [];
    let response: string | undefined;

    for (const event of sessionData.events) {
      if (
        event.author !== USER_AUTHOR ||
        event.content?.parts?.[0]?.text !== query
      ) {
        continue;
      }
      for (const subsequentEvent of sessionData.events) {
        if (subsequentEvent.invocationId !== event.invocationId) {
          continue;
        }
        const firstPart = subsequentEvent.content?.parts?.[0];
        if (firstPart === undefined) {
          continue;
        }
        if (firstPart.functionCall) {
          actualToolUses.push({
            tool_name: firstPart.functionCall.name,
            tool_input: firstPart.functionCall.args,
          });
        } else if (subsequentEvent.author !== USER_AUTHOR) {
          response = firstPart.text;
        }
      }
    }

    return {
      ...row,
      [ACTUAL_TOOL_USE_KEY]: actualToolUses,
      [RESPONSE_KEY]: response,
    };
  });
}

/**
 * Annotates an eval dataset from a session recorded on disk.
 *
 * @param sessionPath Path to a JSON file holding a recorded `Session`.
 * @param evalDataset The conversations to annotate, each a list of eval rows.
 * @returns The annotated copies, in the order they were given.
 */
export async function generateResponsesFromSession(
  sessionPath: string,
  evalDataset: EvalRow[][],
): Promise<EvalRow[][]> {
  // The file holds unescaped non-ASCII text, so the encoding is named rather
  // than left to the platform default.
  const sessionData: Session = JSON.parse(await readFile(sessionPath, 'utf-8'));
  logger.debug(`Loaded session ${sessionPath}`);

  return evalDataset.map((rows) => processQueryWithSession(sessionData, rows));
}
