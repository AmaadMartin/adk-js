/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Exposes ADK sub-agents to an Antigravity harness as client tools.
 *
 * The harness runs the Antigravity agent's loop over plain tools, not ADK
 * nodes, and binds them once per conversation rather than once per turn. Each
 * call therefore runs the ADK child in isolation — its own `Runner` and an
 * in-memory session — and returns only its final text. Close to ADK's own
 * `AgentTool`, except that code-execution output and executable code are not
 * returned.
 */

import {createUserContent} from '@google/genai';

import {BaseAgent} from '../../agents/base_agent.js';
import {Runner} from '../../runner/runner.js';
import {InMemorySessionService} from '../../sessions/in_memory_session_service.js';
import {finalModelText} from './event_converter.js';
import {AntigravityTool} from './sdk_types.js';

const SUB_AGENT_USER_ID = 'antigravity_sub_agent';

/**
 * Wraps `child` as a client tool answering with its final text.
 *
 * @param child The ADK agent to run. Each call runs it once, in a fresh
 *     session.
 * @returns A tool carrying `child`'s name and description. It answers with the
 *     child's last user-visible text, falling back to the child's last error
 *     message and then to `''` — never `undefined`. Whatever the child throws
 *     propagates to the caller, unlike `AgentTool`, which reports failures as
 *     an error string.
 */
export function makeSubAgentTool(child: BaseAgent): AntigravityTool {
  return {
    // What the Antigravity model reads: the ADK child's name becomes the tool
    // name it calls, and the child's description the tool description.
    name: child.name,
    description: child.description,
    run: (request: string) => runSubAgent(child, request),
  };
}

/** Runs `child` once against `request` and returns its answer. */
async function runSubAgent(child: BaseAgent, request: string): Promise<string> {
  const runner = new Runner({
    appName: child.name,
    agent: child,
    sessionService: new InMemorySessionService(),
  });
  const session = await runner.sessionService.createSession({
    appName: child.name,
    userId: SUB_AGENT_USER_ID,
  });

  let lastText: string | undefined;
  let lastError: string | undefined;
  for await (const event of runner.runAsync({
    userId: SUB_AGENT_USER_ID,
    sessionId: session.id,
    newMessage: createUserContent(request),
  })) {
    if (event.errorMessage) {
      lastError = event.errorMessage;
    }
    // Not filtered by author: a composite ADK child yields its own sub-agents'
    // events under their names, still part of its answer.
    const text = finalModelText(event);
    if (text !== undefined) {
      lastText = text;
    }
  }
  // A blocked or cut-off turn carries an error and no content at all, which the
  // Antigravity model must tell apart from a silent ADK child.
  return lastText || lastError || '';
}
