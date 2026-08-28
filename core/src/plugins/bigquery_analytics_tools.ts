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
 * The target of a handoff, which decides `TRANSFER_A2A` against
 * `TRANSFER_AGENT`. A target the tree does not resolve stays the local kind:
 * the transfer is still local as far as this process can tell.
 */
function transferOrigin(
  toolArgs: Record<string, unknown>,
  agent: BaseAgent | undefined,
): ToolOrigin {
  const targetName = toolArgs[TRANSFER_TARGET_ARG];
  if (agent === undefined || typeof targetName !== 'string') {
    return ToolOrigin.TRANSFER_AGENT;
  }
  return isRemoteA2AAgent(findTransferTarget(agent, targetName))
    ? ToolOrigin.TRANSFER_A2A
    : ToolOrigin.TRANSFER_AGENT;
}

/**
 * The kind of agent an `AgentTool` reaches.
 *
 * `AgentTool` keeps its agent private, so the name is resolved against the
 * caller's tree, exactly as a handoff target is. `AgentTool` takes its name
 * from that agent, so the lookup is by the right name. An agent the tree does
 * not resolve stays the local kind, which is the same fallback a handoff uses.
 *
 * @param toolName The tool's name, which `AgentTool` takes from its agent.
 * @param agent The agent making the call.
 */
function agentToolOrigin(
  toolName: string,
  agent: BaseAgent | undefined,
): ToolOrigin {
  if (agent === undefined) {
    return ToolOrigin.SUB_AGENT;
  }
  return isRemoteA2AAgent(findTransferTarget(agent, toolName))
    ? ToolOrigin.A2A
    : ToolOrigin.SUB_AGENT;
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
    return transferOrigin(toolArgs, agent);
  }
  if (isAgentTool(tool)) {
    return agentToolOrigin(tool.name, agent);
  }
  if (isFunctionTool(tool)) {
    return ToolOrigin.LOCAL;
  }
  return ToolOrigin.UNKNOWN;
}
