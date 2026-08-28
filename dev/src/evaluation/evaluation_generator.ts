/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  App,
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
  DEFAULT_EVAL_APP_NAME,
  DEFAULT_EVAL_USER_ID,
  EvalTurn,
  InitialSession,
  ResetFunc,
} from './eval_types.js';

/** Undoes what {@link applyMockToolCallback} installed. */
export type MockToolCallbackDisposer = () => void;

/** Options for {@link processQueryWithRootAgent}. */
export interface ProcessQueryOptions {
  /** The recorded turns of one eval case. Not mutated. */
  data: EvalTurn[];
  rootAgent: RunnableRoot;
  /**
   * The app the agent file exported, when it exported one. `Runner` takes its
   * plugins and resumability config from here, so a case that omits it scores
   * a different composition than `adk run` executes.
   */
  app?: App;
  /** Clears agent-owned state before the case runs. */
  resetFunc?: ResetFunc;
  initialSession?: InitialSession;
  sessionId: string;
  sessionService?: BaseSessionService;
  artifactService?: BaseArtifactService;
}

/**
 * The app name a case runs under.
 *
 * An app names itself, and `Runner` prefers `app.name` over any `appName`
 * passed beside it. The session has to be created under the same name, or the
 * runner cannot find the session it is told to resume.
 */
export function resolveAppName(
  app: App | undefined,
  initialSession: InitialSession | undefined,
): string {
  return app?.name ?? initialSession?.app_name ?? DEFAULT_EVAL_APP_NAME;
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
 * Installs `callback` on every LLM agent in the tree.
 *
 * The callback is prepended to any `beforeToolCallback` the agent already
 * carries, so a user's own callback still runs; adk-python overwrites the
 * field instead. The returned disposer restores every agent's original value,
 * which keeps callbacks from accumulating across eval cases in one run.
 *
 * Every LLM agent gets the callback, whether or not it owns a mocked tool: the
 * callback returns `undefined` for a call it has no mock for, and the agent
 * falls through to the next callback and then to the real tool. Asking each
 * agent for its tools first would resolve its toolsets, and an `MCPToolset`
 * opens a session to list them, so the gate cost a connection per server to
 * decide not to install a callback that does nothing.
 */
export function applyMockToolCallback(
  agent: RunnableRoot,
  callback: SingleBeforeToolCallback,
): MockToolCallbackDisposer {
  const restores: MockToolCallbackDisposer[] = [];
  installMockToolCallback(agent, callback, restores);

  return () => {
    for (const restore of restores) {
      restore();
    }
  };
}

function installMockToolCallback(
  agent: RunnableRoot,
  callback: SingleBeforeToolCallback,
  restores: MockToolCallbackDisposer[],
): void {
  if (isLlmAgent(agent)) {
    const original = agent.beforeToolCallback;
    agent.beforeToolCallback = original
      ? [callback, ...(Array.isArray(original) ? original : [original])]
      : callback;
    restores.push(() => {
      agent.beforeToolCallback = original;
    });
  }

  // A non-LLM agent owns no tools but can still parent one that does, so the
  // walk continues through it. adk-python stops at the first non-LLM agent and
  // leaves a workflow-shaped tree unmocked.
  for (const subAgent of isBaseAgent(agent) ? agent.subAgents : []) {
    installMockToolCallback(subAgent, callback, restores);
  }
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
  const appName = resolveAppName(options.app, options.initialSession);
  const userId = options.initialSession?.user_id ?? DEFAULT_EVAL_USER_ID;

  const dispose = applyMockToolCallback(
    options.rootAgent,
    makeMockToolCallback(turns),
  );

  try {
    await sessionService.createSession({
      appName,
      userId,
      state: options.initialSession?.state ?? {},
      sessionId: options.sessionId,
    });

    const runner = new Runner({
      app: options.app,
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
