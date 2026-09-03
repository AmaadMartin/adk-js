/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {LlmAgent} from '../agents/llm_agent.js';
import {BaseLlm} from '../models/base_llm.js';

import {AgentTool} from './agent_tool.js';
import {GoogleSearchTool} from './google_search_tool.js';

/**
 * Builds a sub-agent whose only tool is Google Search.
 *
 * @param model The model the sub-agent runs on, normally the parent's.
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
    tools: [new GoogleSearchTool()],
  });
}

/**
 * A tool that wraps a sub-agent whose only tool is Google Search.
 *
 * A model accepts one built-in tool per request, so an agent cannot carry
 * Google Search alongside other tools. Delegating the search to a sub-agent
 * keeps both available. This is a workaround, and it goes away once the model
 * accepts both.
 */
export class GoogleSearchAgentTool extends AgentTool {
  constructor(agent: LlmAgent) {
    super({agent});
  }
}
