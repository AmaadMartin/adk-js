/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Tool} from '@google/genai';

import {BaseTool} from '../tools/base_tool.js';
import {
  convertToolUnionToTools,
  isLlmAgent,
  LlmAgent,
  ToolUnion,
} from './llm_agent.js';

/**
 * The information a host needs to describe one {@link LlmAgent} without
 * running it.
 *
 * Ported from `google/adk-python`
 * `src/google/adk/utils/agent_info.py::AgentInfo`. Named `LlmAgentInfo` rather
 * than `AgentInfo` because `@google/adk` already exports an unrelated
 * `AgentInfo` describing a remote agent-registry entry.
 */
export interface LlmAgentInfo {
  name: string;
  description: string;
  /** Empty when the agent's instruction is an `InstructionProvider`. */
  instruction: string;
  tools: Tool[];
  /** Names of this agent's direct `LlmAgent` children, in declaration order. */
  subAgents: string[];
}

/**
 * Resolves an agent's `tools` to the declarations a model would be given.
 *
 * Each returned `Tool` holds exactly one `FunctionDeclaration`, in input order,
 * with every toolset expanded in place. A tool that declares nothing is
 * omitted.
 *
 * Resolving a `BaseToolset` calls its `getTools()`, so a remote toolset (MCP,
 * OpenAPI) performs I/O here.
 *
 * Ported from `google/adk-python`
 * `src/google/adk/utils/agent_info.py::get_tools_info`.
 */
export async function getToolsInfo(tools: ToolUnion[]): Promise<Tool[]> {
  const resolved: BaseTool[] = [];
  for (const tool of tools) {
    resolved.push(...(await convertToolUnionToTools(tool)));
  }

  return resolved.flatMap((tool) => {
    const declaration = tool._getDeclaration();
    return declaration ? [{functionDeclarations: [declaration]}] : [];
  });
}

/**
 * Records `agent` and its `LlmAgent` descendants into `collected`, children
 * first.
 *
 * The `collected` map doubles as the visited guard: an agent reachable by two
 * paths is recorded once, and is still named by both parents.
 */
async function collectAgentInfo(
  agent: LlmAgent,
  collected: Map<string, LlmAgentInfo>,
): Promise<void> {
  if (collected.has(agent.name)) {
    return;
  }

  const subAgentNames: string[] = [];
  for (const subAgent of agent.subAgents) {
    if (isLlmAgent(subAgent)) {
      await collectAgentInfo(subAgent, collected);
      subAgentNames.push(subAgent.name);
    }
  }

  collected.set(agent.name, {
    name: agent.name,
    description: agent.description,
    instruction: typeof agent.instruction === 'string' ? agent.instruction : '',
    tools: await getToolsInfo(agent.tools),
    subAgents: subAgentNames,
  });
}

/**
 * Flattens an agent tree into a map of per-agent information, keyed by agent
 * name.
 *
 * Only `LlmAgent` edges are followed. A sub-agent of any other type is skipped
 * entirely: it is neither keyed nor named in its parent's `subAgents`, and its
 * own descendants stay invisible. Children are recorded before their parent.
 *
 * Ported from `google/adk-python`
 * `src/google/adk/utils/agent_info.py::get_agents_dict`.
 */
export async function getAgentsInfo(
  agent: LlmAgent,
): Promise<Record<string, LlmAgentInfo>> {
  const collected = new Map<string, LlmAgentInfo>();
  await collectAgentInfo(agent, collected);
  // `Object.fromEntries` defines own properties, so an agent legitimately
  // named `__proto__` becomes a real key instead of mutating the prototype.
  return Object.fromEntries(collected);
}
