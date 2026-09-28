/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Session} from '@google/adk';

const USER_AUTHOR = 'user';
const DEFAULT_AGENT_AUTHOR = 'agent';

/** A single tool invocation expected during a turn. */
export interface ExpectedToolUse {
  tool_name: string;
  tool_input: Record<string, unknown>;
}

/** A natural-language response emitted mid-turn by an agent or sub-agent. */
export interface IntermediateAgentResponse {
  author: string;
  text: string;
}

/** One user-initiated turn in the eval-set format. */
export interface EvalTurn {
  query: string;
  expected_tool_use: ExpectedToolUse[];
  expected_intermediate_agent_responses: IntermediateAgentResponse[];
  reference: string;
}

/**
 * Converts a session into the eval-set turn format that the ADK evaluation
 * tooling consumes.
 *
 * One record is emitted per user event that carries content. The record holds
 * the user's query, every tool call the agent made before the next user event,
 * the agent's intermediate text responses, and the agent's last text response
 * as the `reference`.
 *
 * The property names are `snake_case` because the records are serialised
 * verbatim into `.evalset.json` files that adk-python's tooling reads.
 *
 * @param session The session to convert.
 * @returns One eval turn per user-initiated turn, in session order.
 */
export function convertSessionToEvalFormat(
  session: Session | undefined,
): EvalTurn[] {
  const events = session?.events ?? [];
  const turns: EvalTurn[] = [];

  for (let i = 0; i < events.length; i++) {
    const event = events[i];
    if (event.author !== USER_AUTHOR || !event.content?.parts?.length) {
      continue;
    }

    const toolUses: ExpectedToolUse[] = [];
    const responses: IntermediateAgentResponse[] = [];

    // Scan from the positional index. The reference resolves the scan start
    // with `events.index(event)`, which finds the first structurally equal
    // event, so a repeated event restarts the scan at the wrong position.
    for (let j = i + 1; j < events.length; j++) {
      const next = events[j];
      // `||` rather than `??`: an empty-string author must also default to
      // 'agent', because Python's `or` replaces it too.
      const author = next.author || DEFAULT_AGENT_AUTHOR;
      if (author === USER_AUTHOR) {
        break;
      }
      // Length test, not a truthiness test: an empty `parts` array is falsy in
      // Python but truthy in JavaScript.
      if (!next.content?.parts?.length) {
        continue;
      }

      for (const part of next.content.parts) {
        if (part.functionCall) {
          toolUses.push({
            tool_name: part.functionCall.name || '',
            tool_input: part.functionCall.args || {},
          });
        } else if (part.text) {
          responses.push({author, text: part.text});
        }
      }
    }

    const last = responses[responses.length - 1];

    turns.push({
      query: event.content.parts[0].text || '',
      expected_tool_use: toolUses,
      expected_intermediate_agent_responses: responses.slice(0, -1),
      reference: last ? last.text : '',
    });
  }

  return turns;
}
