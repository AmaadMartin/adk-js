/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '../agents/llm_agent.js';
import {BaseLlm} from '../models/base_llm.js';

import {AgentTool} from './agent_tool.js';
import {GOOGLE_SEARCH} from './google_search_tool.js';

/**
 * Builds a sub-agent whose only tool is `google_search`.
 *
 * @param model The model the sub-agent runs on.
 * @returns An agent named `google_search_agent`.
 */
export function createGoogleSearchAgent(model: string | BaseLlm): LlmAgent {
  return new LlmAgent({
    name: 'google_search_agent',
    model,
    description:
      'An agent for performing Google search using the `google_search` tool',
    instruction: `
        You are a specialized Google search agent.

        When given a search query, use the \`google_search\` tool to find the related information.
      `,
    tools: [GOOGLE_SEARCH],
  });
}

/**
 * A tool that wraps a sub-agent whose only tool is `google_search`.
 *
 * A Gemini 1.x request rejects `google_search` beside any other tool. Wrapping
 * the search in a sub-agent keeps it alone on its own request, so the caller
 * can hold other tools. The tool publishes the sub-agent's grounding metadata
 * to the caller's state, so a citation survives the hop.
 *
 * This is a workaround. Remove it once the workaround is no longer needed.
 */
export class GoogleSearchAgentTool extends AgentTool {
  constructor(agent: LlmAgent) {
    super({agent, propagateGroundingMetadata: true});
  }
}
