/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * ManagedAgent: driving a server-hosted managed agent.
 * See docs/guides/agents/managed_agent/index.md.
 *
 * Four shapes, all server-side:
 *   - a search agent built from an ADK built-in tool;
 *   - a code-execution agent built from a raw `Tool` config;
 *   - a remote-MCP agent whose bearer token is minted per turn;
 *   - a `single_turn` agent delegated to by a local `LlmAgent` coordinator.
 *
 * Running it needs credentials and an agent id; see the README next to this
 * file.
 */

import {
  AgentTool,
  GoogleSearchTool,
  LlmAgent,
  ManagedAgent,
  RemoteMcpServer,
} from '@google/adk';

const AGENT_ID =
  process.env['MANAGED_AGENT_ID'] ?? 'antigravity-preview-05-2026';

/** Answers questions that need fresh, grounded information. */
const searchAgent = new ManagedAgent({
  name: 'managed_search_agent',
  description: 'Answers questions that need fresh information from the web.',
  agentId: AGENT_ID,
  environment: {type: 'remote'},
  tools: [new GoogleSearchTool()],
});

/**
 * Answers computational questions by running code in the backend's sandbox.
 * `codeExecution` has no ADK tool class, so it is passed as a raw `Tool`.
 */
const codeExecutionAgent = new ManagedAgent({
  name: 'managed_code_execution_agent',
  description: 'Answers computational questions by running code server-side.',
  agentId: AGENT_ID,
  environment: {type: 'remote'},
  tools: [{codeExecution: {}}],
});

/**
 * Mints the bearer token the MCP server expects. A real deployment would call
 * its identity provider here; this sample reads one from the environment so it
 * type-checks and runs without extra setup.
 */
async function mintMcpToken(): Promise<string> {
  return process.env['MCP_BEARER_TOKEN'] ?? '';
}

const exampleMcpServer: RemoteMcpServer = {
  url: process.env['MCP_SERVER_URL'] ?? 'https://api.example.com/mcp',
  name: 'example',
  allowedTools: ['search'],
  // Called once per turn, so a short-lived token is always fresh.
  headerProvider: async () => ({
    Authorization: `Bearer ${await mintMcpToken()}`,
  }),
};

/** Calls tools on a remote MCP server that the backend connects to. */
const remoteMcpAgent = new ManagedAgent({
  name: 'managed_mcp_agent',
  description: 'Calls tools on a remote MCP server, server-side.',
  agentId: AGENT_ID,
  environment: {type: 'remote'},
  tools: [exampleMcpServer],
});

/** A specialist the root agent delegates a single summarization turn to. */
const summarizer = new ManagedAgent({
  name: 'managed_summarizer',
  description: 'Summarizes a passage in two sentences.',
  agentId: AGENT_ID,
  environment: {type: 'remote'},
  instruction: 'Summarize the input in exactly two sentences.',
});

/** Delegates to the managed specialists and composes the answer. */
export const rootAgent = new LlmAgent({
  name: 'managed_agent_coordinator',
  model: 'gemini-2.5-flash',
  description: 'Calls managed specialists as tools and composes the answer.',
  instruction:
    'Answer the user by delegating to the specialist tools. Use the search ' +
    'specialist for facts, the code specialist for computation, and the MCP ' +
    'specialist for the example service.',
  tools: [
    new AgentTool({agent: searchAgent}),
    new AgentTool({agent: codeExecutionAgent}),
    new AgentTool({agent: remoteMcpAgent}),
    new AgentTool({agent: summarizer}),
  ],
});
