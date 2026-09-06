/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {isRemoteA2AAgent} from '../a2a/a2a_remote_agent.js';
import {BaseAgent} from '../agents/base_agent.js';
import {isAgentTool} from '../tools/agent_tool.js';
import {BaseTool} from '../tools/base_tool.js';
import {isFunctionTool} from '../tools/function_tool.js';
import {isMCPTool} from '../tools/mcp/mcp_tool.js';

/**
 * Where a tool call runs, written to the `tool_origin` key of a tool row's
 * `content`.
 *
 * The values are a wire contract shared with adk-python, so a query over a
 * dataset both SDKs write reads one vocabulary.
 */
export enum ToolOrigin {
  /** A function the application registered in this process. */
  LOCAL = 'LOCAL',
  /** A tool served by a Model Context Protocol server. */
  MCP = 'MCP',
  /** An agent reached over the Agent2Agent protocol, called as a tool. */
  A2A = 'A2A',
  /** An agent in this process, called as a tool. */
  SUB_AGENT = 'SUB_AGENT',
  /** A handoff to another agent in this process. */
  TRANSFER_AGENT = 'TRANSFER_AGENT',
  /** A handoff to an agent reached over the Agent2Agent protocol. */
  TRANSFER_A2A = 'TRANSFER_A2A',
  /** A tool of none of the above kinds. */
  UNKNOWN = 'UNKNOWN',
}

/**
 * The name `AgentTransferLlmRequestProcessor` gives the handoff tool, and the
 * argument it takes. adk-js builds that tool inline rather than declaring a
 * class, so the name is the only thing to classify it by.
 */
const TRANSFER_TOOL_NAME = 'transfer_to_agent';
const TRANSFER_TARGET_ARG = 'agentName';

/**
 * Finds a transfer target by name among the agents `agent` can reach: its own
 * sub-agents, its parent, then its peers.
 */
function findTransferTarget(
  agent: BaseAgent,
  targetName: string,
): BaseAgent | undefined {
  const sub = agent.subAgents.find((child) => child.name === targetName);
  if (sub !== undefined) {
    return sub;
  }
  const parent = agent.parentAgent;
  if (parent === undefined) {
    return undefined;
  }
  if (parent.name === targetName) {
    return parent;
  }
  return parent.subAgents.find(
    (peer) => peer.name === targetName && peer.name !== agent.name,
  );
}

/**
 * Whether the agent named by `targetName` is remote, as the `remote` or the
 * `local` origin.
 *
 * A handoff names its target in the call arguments. An `AgentTool` keeps its
 * agent private, so it names it by the tool name, which `AgentTool` takes from
 * that agent. Either way a name the tree does not resolve stays local: the
 * call is local as far as this process can tell.
 *
 * @param targetName The name to resolve, from a call argument or a tool name.
 * @param agent The agent making the call, whose tree resolves that name.
 * @param remote The origin to report for an agent behind the A2A protocol.
 * @param local The origin to report otherwise.
 */
function resolveOrigin(
  targetName: unknown,
  agent: BaseAgent | undefined,
  remote: ToolOrigin,
  local: ToolOrigin,
): ToolOrigin {
  if (agent === undefined || typeof targetName !== 'string') {
    return local;
  }
  return isRemoteA2AAgent(findTransferTarget(agent, targetName))
    ? remote
    : local;
}

/**
 * Classifies where a tool call runs.
 *
 * The order is load-bearing: the handoff tool is a `FunctionTool`, and an
 * `AgentTool` wrapping a remote agent is an `AgentTool` first.
 *
 * Type guards do the narrowing rather than `instanceof`, so a call still
 * classifies when the tool and this module come from two copies of the
 * package.
 *
 * @param tool The tool being called.
 * @param toolArgs The arguments of this call, which name a handoff target.
 * @param agent The agent making the call, whose tree resolves that target.
 */
export function getToolOrigin(
  tool: BaseTool,
  toolArgs: Record<string, unknown>,
  agent: BaseAgent | undefined,
): ToolOrigin {
  if (isMCPTool(tool)) {
    return ToolOrigin.MCP;
  }
  if (tool.name === TRANSFER_TOOL_NAME) {
    return resolveOrigin(
      toolArgs[TRANSFER_TARGET_ARG],
      agent,
      ToolOrigin.TRANSFER_A2A,
      ToolOrigin.TRANSFER_AGENT,
    );
  }
  if (isAgentTool(tool)) {
    return resolveOrigin(
      tool.name,
      agent,
      ToolOrigin.A2A,
      ToolOrigin.SUB_AGENT,
    );
  }
  if (isFunctionTool(tool)) {
    return ToolOrigin.LOCAL;
  }
  return ToolOrigin.UNKNOWN;
}
