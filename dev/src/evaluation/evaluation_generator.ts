/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseAgent,
  BaseArtifactService,
  BaseSessionService,
  getFunctionCalls,
  InMemoryArtifactService,
  InMemorySessionService,
  isBaseAgent,
  isFinalResponse,
  isLlmAgent,
  RunnableRoot,
  Runner,
  SingleBeforeToolCallback,
} from '@google/adk';
import {isDeepStrictEqual} from 'node:util';
import {
  ActualToolUse,
  EvalTurn,
  InitialSession,
} from './evaluation_constants.js';

/** The app name a case without an `initial_session.app_name` runs under. */
export const DEFAULT_EVAL_APP_NAME = 'EvaluationGenerator';

/** The user id a case without an `initial_session.user_id` runs under. */
export const DEFAULT_EVAL_USER_ID = 'test_user_id';

/** Undoes what {@link applyMockToolCallback} installed. */
export type MockToolCallbackDisposer = () => void;

/** Options for {@link processQueryWithRootAgent}. */
export interface ProcessQueryOptions {
  /** The recorded turns of one eval case. Not mutated. */
  data: EvalTurn[];
  rootAgent: RunnableRoot;
  /** Clears agent-owned state before the case runs. */
  resetFunc?: () => void | Promise<void>;
  initialSession?: InitialSession;
  sessionId: string;
  sessionService?: BaseSessionService;
  artifactService?: BaseArtifactService;
}

/**
 * Builds the callback that answers a tool call from the eval data.
 *
 * The callback matches a call against the recorded turns by tool name and
 * arguments, and consumes the matched turn so a repeated call falls through to
 * the real tool. Returning `undefined` lets the real tool run.
 */
export function makeMockToolCallback(
  turns: EvalTurn[],
): SingleBeforeToolCallback {
  const remaining = [...turns];

  return ({tool, args}) => {
    for (let index = 0; index < remaining.length; index++) {
      const expectedToolUses = remaining[index].expected_tool_use ?? [];
      const match = expectedToolUses.find(
        (expected) =>
          expected.mock_tool_output !== undefined &&
          expected.tool_name === tool.name &&
          isDeepStrictEqual(args, expected.tool_input ?? {}),
      );

      if (match) {
        remaining.splice(index, 1);
        return {result: match.mock_tool_output};
      }
    }

    return undefined;
  };
}

/**
 * Installs `callback` on every LLM agent in the tree that owns a mocked tool.
 *
 * The callback is prepended to any `beforeToolCallback` the agent already
 * carries, so a user's own callback still runs; adk-python overwrites the
 * field instead. The returned disposer restores every agent's original value,
 * which keeps callbacks from accumulating across eval cases in one run.
 */
export async function applyMockToolCallback(
  agent: RunnableRoot,
  callback: SingleBeforeToolCallback,
  mockedToolNames: ReadonlySet<string>,
): Promise<MockToolCallbackDisposer> {
  const restores: MockToolCallbackDisposer[] = [];
  await installMockToolCallback(agent, callback, mockedToolNames, restores);

  return () => {
    for (const restore of restores) {
      restore();
    }
  };
}

async function installMockToolCallback(
  agent: RunnableRoot,
  callback: SingleBeforeToolCallback,
  mockedToolNames: ReadonlySet<string>,
  restores: MockToolCallbackDisposer[],
): Promise<void> {
  if (isLlmAgent(agent)) {
    const tools = await agent.canonicalTools();
    if (tools.some((tool) => mockedToolNames.has(tool.name))) {
      const original = agent.beforeToolCallback;
      agent.beforeToolCallback = original
        ? [callback, ...(Array.isArray(original) ? original : [original])]
        : callback;
      restores.push(() => {
        agent.beforeToolCallback = original;
      });
    }
  }

  // A non-LLM agent owns no tools but can still parent one that does, so the
  // walk continues through it. adk-python stops at the first non-LLM agent and
  // leaves a workflow-shaped tree unmocked.
  for (const subAgent of getSubAgents(agent)) {
    await installMockToolCallback(
      subAgent,
      callback,
      mockedToolNames,
      restores,
    );
  }
}

function getSubAgents(agent: RunnableRoot): BaseAgent[] {
  return isBaseAgent(agent) ? agent.subAgents : [];
}

/**
 * Replays the recorded turns of one eval case through the agent.
 *
 * @returns A copy of `data` with `actual_tool_use` and `response` filled in.
 */
export async function processQueryWithRootAgent(
  options: ProcessQueryOptions,
): Promise<EvalTurn[]> {
  const turns = options.data.map((turn) => ({...turn}));
  const sessionService = options.sessionService ?? new InMemorySessionService();
  const artifactService =
    options.artifactService ?? new InMemoryArtifactService();
  const appName = options.initialSession?.app_name ?? DEFAULT_EVAL_APP_NAME;
  const userId = options.initialSession?.user_id ?? DEFAULT_EVAL_USER_ID;

  const dispose = await applyMockToolCallback(
    options.rootAgent,
    makeMockToolCallback(turns),
    collectMockedToolNames(turns),
  );

  try {
    await sessionService.createSession({
      appName,
      userId,
      state: options.initialSession?.state ?? {},
      sessionId: options.sessionId,
    });

    const runner = new Runner({
      appName,
      agent: options.rootAgent,
      artifactService,
      sessionService,
    });

    await options.resetFunc?.();

    for (const turn of turns) {
      const actualToolUse: ActualToolUse[] = [];
      let response: string | undefined;

      for await (const event of runner.runAsync({
        userId,
        sessionId: options.sessionId,
        newMessage: {role: 'user', parts: [{text: turn.query}]},
      })) {
        if (isFinalResponse(event) && event.content?.parts) {
          response = event.content.parts[0].text;
          continue;
        }
        for (const call of getFunctionCalls(event)) {
          actualToolUse.push({
            tool_name: call.name ?? '',
            tool_input: call.args ?? {},
          });
        }
      }

      turn.actual_tool_use = actualToolUse;
      turn.response = response;
    }
  } finally {
    dispose();
  }

  return turns;
}

/** The names of every tool the eval data supplies a mock output for. */
function collectMockedToolNames(turns: EvalTurn[]): ReadonlySet<string> {
  const names = new Set<string>();
  for (const turn of turns) {
    for (const expected of turn.expected_tool_use ?? []) {
      if (expected.mock_tool_output !== undefined) {
        names.add(expected.tool_name);
      }
    }
  }
  return names;
}
