/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {createUserContent} from '@google/genai';
import {isEqual} from 'lodash-es';

import {BaseAgent} from '../agents/base_agent.js';
import {isLlmAgent, SingleBeforeToolCallback} from '../agents/llm_agent.js';
import {BaseArtifactService} from '../artifacts/base_artifact_service.js';
import {InMemoryArtifactService} from '../artifacts/in_memory_artifact_service.js';
import {NotFoundError} from '../errors/not_found_error.js';
import {Event, getFunctionCalls, isFinalResponse} from '../events/event.js';
import {Runner} from '../runner/runner.js';
import {BaseSessionService} from '../sessions/base_session_service.js';
import {InMemorySessionService} from '../sessions/in_memory_session_service.js';
import {Session} from '../sessions/session.js';
import {randomUUID} from '../utils/env_aware_utils.js';

import {EvalConversation, ToolUse} from './eval_entry.js';

/**
 * How many times {@link generateResponses} replays the dataset by default.
 *
 * A model is not deterministic, so adk-python replays the dataset three times
 * and lets the scorer average the runs.
 */
const DEFAULT_REPEAT_NUM = 3;

/** The app a conversation runs under when the caller names none. */
const DEFAULT_APP_NAME = 'EvaluationGenerator';

/** The user a conversation runs as when the caller names none. */
const DEFAULT_USER_ID = 'test_user_id';

/** Author of the events a user contributed to a session. */
const USER_AUTHOR = 'user';

/** Overrides for the session an eval conversation is replayed in. */
export interface InitialSession {
  appName?: string;
  userId?: string;
  state?: Record<string, unknown>;
}

/** Options for {@link generateResponses}. */
export interface GenerateResponsesParams {
  /** Conversations to replay. Each is an ordered list of turns. */
  evalDataset: EvalConversation[];
  /** The root of the agent tree under test. */
  rootAgent: BaseAgent;
  /** How many times the whole dataset is replayed. Defaults to 3. */
  repeatNum?: number;
  /** Evaluate this descendant of `rootAgent` instead of `rootAgent` itself. */
  agentName?: string;
  /** Clears agent-owned state before each conversation runs. */
  resetFunc?: () => void | Promise<void>;
  initialSession?: InitialSession;
  /** Defaults to a fresh `InMemorySessionService`. */
  sessionService?: BaseSessionService;
  /** Defaults to a fresh `InMemoryArtifactService`. */
  artifactService?: BaseArtifactService;
}

/**
 * Replays an eval dataset through an agent and records what the agent did.
 *
 * Ports `EvaluationGenerator.generate_responses` from adk-python.
 *
 * Every conversation runs in its own session. A tool call the dataset records
 * a `mock_tool_output` for is answered from the recording instead of executed,
 * so a conversation replays without the real tool.
 *
 * @returns One filled-in conversation per run, ordered repeat-major: every
 *   conversation of repeat 1, then every conversation of repeat 2. adk-python's
 *   nested loop produces the same order.
 * @throws NotFoundError when `agentName` names no agent in the tree.
 */
export async function generateResponses(
  params: GenerateResponsesParams,
): Promise<EvalConversation[]> {
  const agent = resolveAgentToEvaluate(params.rootAgent, params.agentName);
  const repeatNum = params.repeatNum ?? DEFAULT_REPEAT_NUM;
  const results: EvalConversation[] = [];

  for (let repeat = 0; repeat < repeatNum; repeat++) {
    for (const conversation of params.evalDataset) {
      // Sequential: each conversation installs its own mock callback on the one
      // shared agent tree, so two in flight would answer each other's calls.
      results.push(await processConversation(conversation, agent, params));
    }
  }

  return results;
}

/**
 * Fills in an eval dataset from a session that already happened, without
 * running the agent.
 *
 * Ports `EvaluationGenerator.generate_responses_from_session` from adk-python.
 *
 * Use it to score a conversation a user already had, rather than a fresh run.
 * A turn whose query matches no user event in the session comes back with no
 * tool use and no response.
 */
export function generateResponsesFromSession(
  session: Session,
  evalDataset: EvalConversation[],
): EvalConversation[] {
  return evalDataset.map((conversation) =>
    processConversationWithSession(session, conversation),
  );
}

/**
 * The agent the dataset is replayed through.
 *
 * @throws NotFoundError when `agentName` names no agent in the tree.
 */
function resolveAgentToEvaluate(
  rootAgent: BaseAgent,
  agentName: string | undefined,
): BaseAgent {
  if (!agentName) {
    return rootAgent;
  }

  const found = rootAgent.findAgent(agentName);
  if (!found) {
    throw new NotFoundError(`Sub-Agent \`${agentName}\` not found.`);
  }
  return found;
}

/** The names of the tools the conversation records an output for. */
function collectMockedToolNames(conversation: EvalConversation): Set<string> {
  const names = new Set<string>();

  for (const entry of conversation) {
    for (const expected of entry.expected_tool_use ?? []) {
      // Presence, not truthiness: a recorded output of `null` is still a mock.
      if ('mock_tool_output' in expected && expected.tool_name !== undefined) {
        names.add(expected.tool_name);
      }
    }
  }

  return names;
}

/**
 * Builds the callback that answers a tool call from the eval data.
 *
 * Ports `EvaluationGenerator.before_tool_callback` from adk-python.
 *
 * A match consumes its whole turn, so a call the conversation records once is
 * mocked once and a repeat of it reaches the real tool. Returning `undefined`
 * lets the real tool run.
 */
function createMockToolCallback(
  pending: EvalConversation,
): SingleBeforeToolCallback {
  return ({tool, args}) => {
    for (let index = 0; index < pending.length; index++) {
      const match = (pending[index].expected_tool_use ?? []).find(
        (expected) =>
          'mock_tool_output' in expected &&
          expected.tool_name === tool.name &&
          isEqual(args, expected.tool_input ?? {}),
      );

      if (match) {
        pending.splice(index, 1);
        return {result: match.mock_tool_output};
      }
    }

    return undefined;
  };
}

/**
 * Installs `callback` on every LLM agent that owns a mocked tool.
 *
 * Ports `EvaluationGenerator.apply_before_tool_callback` from adk-python. The
 * callback replaces any `beforeToolCallback` the agent already carried.
 *
 * The walk continues through a non-LLM agent, where adk-python stops. A
 * workflow agent parenting the LLM agents is the normal shape in adk-js, and
 * stopping there runs the real tool for a call the dataset mocks.
 */
async function applyMockToolCallback(
  agent: BaseAgent,
  callback: SingleBeforeToolCallback,
  mockedToolNames: Set<string>,
): Promise<void> {
  if (isLlmAgent(agent)) {
    const tools = await agent.canonicalTools();
    if (tools.some((tool) => mockedToolNames.has(tool.name))) {
      agent.beforeToolCallback = callback;
    }
  }

  for (const subAgent of agent.subAgents) {
    await applyMockToolCallback(subAgent, callback, mockedToolNames);
  }
}

/**
 * Replays one conversation through the agent.
 *
 * Ports `EvaluationGenerator._process_query_with_root_agent` from adk-python.
 *
 * @returns A copy of `conversation` with `actual_tool_use` and `response`
 *   filled in. The input turns are left as they were.
 */
async function processConversation(
  conversation: EvalConversation,
  agent: BaseAgent,
  params: GenerateResponsesParams,
): Promise<EvalConversation> {
  const mockedToolNames = collectMockedToolNames(conversation);
  if (mockedToolNames.size > 0) {
    // `canonicalTools()` resolves toolsets, and a toolset can open a connection
    // to list its tools, so the tree is only walked when a name can match.
    await applyMockToolCallback(
      agent,
      createMockToolCallback([...conversation]),
      mockedToolNames,
    );
  }

  const sessionService = params.sessionService ?? new InMemorySessionService();
  const artifactService =
    params.artifactService ?? new InMemoryArtifactService();
  const appName = params.initialSession?.appName ?? DEFAULT_APP_NAME;
  const userId = params.initialSession?.userId ?? DEFAULT_USER_ID;
  const sessionId = randomUUID();

  await sessionService.createSession({
    appName,
    userId,
    state: params.initialSession?.state ?? {},
    sessionId,
  });

  const runner = new Runner({
    appName,
    agent,
    artifactService,
    sessionService,
  });

  await params.resetFunc?.();

  const results: EvalConversation = [];
  for (const entry of conversation) {
    const actualToolUse: ToolUse[] = [];
    let response: string | undefined;

    for await (const event of runner.runAsync({
      userId,
      sessionId,
      newMessage: createUserContent(entry.query),
    })) {
      // An event that carries a function call is never a final response, so
      // the two branches cannot both apply.
      if (isFinalResponse(event) && event.content?.parts?.length) {
        response = event.content.parts[0].text;
      } else {
        for (const call of getFunctionCalls(event)) {
          actualToolUse.push({tool_name: call.name, tool_input: call.args});
        }
      }
    }

    results.push({...entry, actual_tool_use: actualToolUse, response});
  }

  return results;
}

/** Ports `EvaluationGenerator._process_query_with_session` from adk-python. */
function processConversationWithSession(
  session: Session,
  conversation: EvalConversation,
): EvalConversation {
  return conversation.map((entry) => {
    const actualToolUse: ToolUse[] = [];
    let response: string | undefined;

    for (const userEvent of session.events) {
      if (!isUserQuery(userEvent, entry.query)) {
        continue;
      }

      for (const event of session.events) {
        if (event.invocationId !== userEvent.invocationId) {
          continue;
        }

        // An event can carry a state delta and no content at all.
        const part = event.content?.parts?.[0];
        if (!part) {
          continue;
        }

        if (part.functionCall) {
          actualToolUse.push({
            tool_name: part.functionCall.name,
            tool_input: part.functionCall.args,
          });
        } else if (event.author !== USER_AUTHOR) {
          response = part.text;
        }
      }
    }

    return {...entry, actual_tool_use: actualToolUse, response};
  });
}

function isUserQuery(event: Event, query: string): boolean {
  return (
    event.author === USER_AUTHOR && event.content?.parts?.[0]?.text === query
  );
}
