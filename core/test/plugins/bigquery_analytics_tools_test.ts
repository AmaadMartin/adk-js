/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AgentTool,
  BaseAgent,
  BaseTool,
  FunctionTool,
  LlmAgent,
  MCPSessionManager,
  MCPTool,
  RemoteA2AAgent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {
  getToolOrigin,
  ToolOrigin,
} from '../../src/plugins/bigquery_analytics_tools.js';

/** The name `AgentTransferLlmRequestProcessor` gives the handoff tool. */
const TRANSFER_TOOL_NAME = 'transfer_to_agent';

/** A tool of no recognized kind: it extends `BaseTool` and nothing else. */
class PlainTool extends BaseTool {
  constructor() {
    super({name: 'plain', description: 'A tool of no known kind.'});
  }

  override async runAsync(): Promise<unknown> {
    return 'done';
  }
}

function localTool(name = 'lookup'): FunctionTool {
  return new FunctionTool({
    name,
    description: 'Looks something up.',
    execute: () => 'done',
  });
}

function mcpTool(): MCPTool {
  const sessions = new MCPSessionManager({
    type: 'StreamableHTTPConnectionParams',
    url: 'https://mcp.example.test/mcp',
  });
  return new MCPTool(
    {
      name: 'remote_lookup',
      description: 'Looks up remotely.',
      inputSchema: {type: 'object'},
    },
    sessions,
  );
}

function remoteAgent(name: string): RemoteA2AAgent {
  return new RemoteA2AAgent({
    name,
    description: 'An agent behind the A2A protocol.',
    agentCard: 'https://agent.example.test/.well-known/agent-card.json',
  });
}

function localAgent(name: string, subAgents: BaseAgent[] = []): LlmAgent {
  const agent = new LlmAgent({
    name,
    description: 'An agent in this process.',
    subAgents,
  });
  for (const child of subAgents) {
    child.parentAgent = agent;
  }
  return agent;
}

describe('getToolOrigin', () => {
  it('classifies a function tool as LOCAL', () => {
    expect(getToolOrigin(localTool(), {}, localAgent('root'))).toBe(
      ToolOrigin.LOCAL,
    );
  });

  it('classifies a Model Context Protocol tool as MCP', () => {
    expect(getToolOrigin(mcpTool(), {}, localAgent('root'))).toBe(
      ToolOrigin.MCP,
    );
  });

  it('classifies an agent tool wrapping a local agent as SUB_AGENT', () => {
    const tool = new AgentTool({agent: localAgent('helper')});
    expect(getToolOrigin(tool, {}, localAgent('root'))).toBe(
      ToolOrigin.SUB_AGENT,
    );
  });

  it('classifies an agent tool wrapping a remote agent as A2A', () => {
    const helper = remoteAgent('helper');
    const tool = new AgentTool({agent: helper});
    expect(getToolOrigin(tool, {}, localAgent('root', [helper]))).toBe(
      ToolOrigin.A2A,
    );
  });

  it('classifies an agent tool whose agent the tree cannot resolve as SUB_AGENT', () => {
    // AgentTool keeps its agent private, so an agent that is not also a
    // sub-agent, a parent or a peer cannot be told apart from a local one.
    const tool = new AgentTool({agent: remoteAgent('helper')});
    expect(getToolOrigin(tool, {}, localAgent('root'))).toBe(
      ToolOrigin.SUB_AGENT,
    );
  });

  it('classifies an agent tool as SUB_AGENT when there is no calling agent', () => {
    const tool = new AgentTool({agent: remoteAgent('helper')});
    expect(getToolOrigin(tool, {}, undefined)).toBe(ToolOrigin.SUB_AGENT);
  });

  it('classifies an unrecognized tool as UNKNOWN', () => {
    expect(getToolOrigin(new PlainTool(), {}, localAgent('root'))).toBe(
      ToolOrigin.UNKNOWN,
    );
  });

  it('classifies a handoff to a sub-agent as TRANSFER_AGENT', () => {
    const root = localAgent('root', [localAgent('child')]);
    const origin = getToolOrigin(
      localTool(TRANSFER_TOOL_NAME),
      {agentName: 'child'},
      root,
    );
    expect(origin).toBe(ToolOrigin.TRANSFER_AGENT);
  });

  it('classifies a handoff to a remote sub-agent as TRANSFER_A2A', () => {
    const root = localAgent('root', [remoteAgent('child')]);
    const origin = getToolOrigin(
      localTool(TRANSFER_TOOL_NAME),
      {agentName: 'child'},
      root,
    );
    expect(origin).toBe(ToolOrigin.TRANSFER_A2A);
  });

  it('resolves a handoff target that is the parent agent', () => {
    const child = localAgent('child');
    localAgent('root', [child]);
    const origin = getToolOrigin(
      localTool(TRANSFER_TOOL_NAME),
      {agentName: 'root'},
      child,
    );
    expect(origin).toBe(ToolOrigin.TRANSFER_AGENT);
  });

  it('resolves a handoff target that is a remote peer agent', () => {
    const caller = localAgent('caller');
    localAgent('root', [caller, remoteAgent('peer')]);
    const origin = getToolOrigin(
      localTool(TRANSFER_TOOL_NAME),
      {agentName: 'peer'},
      caller,
    );
    expect(origin).toBe(ToolOrigin.TRANSFER_A2A);
  });

  it('reports a handoff to a name the tree does not resolve as local', () => {
    const root = localAgent('root', [localAgent('child')]);
    const origin = getToolOrigin(
      localTool(TRANSFER_TOOL_NAME),
      {agentName: 'absent'},
      root,
    );
    expect(origin).toBe(ToolOrigin.TRANSFER_AGENT);
  });

  it('reports a handoff naming the calling agent itself as local', () => {
    const caller = localAgent('caller');
    localAgent('root', [caller]);
    const origin = getToolOrigin(
      localTool(TRANSFER_TOOL_NAME),
      {agentName: 'caller'},
      caller,
    );
    expect(origin).toBe(ToolOrigin.TRANSFER_AGENT);
  });

  it('reports a handoff whose target argument is not a string as local', () => {
    const root = localAgent('root', [remoteAgent('child')]);
    const origin = getToolOrigin(
      localTool(TRANSFER_TOOL_NAME),
      {agentName: 42},
      root,
    );
    expect(origin).toBe(ToolOrigin.TRANSFER_AGENT);
  });

  it('reports a handoff made without an agent as local', () => {
    const origin = getToolOrigin(
      localTool(TRANSFER_TOOL_NAME),
      {agentName: 'child'},
      undefined,
    );
    expect(origin).toBe(ToolOrigin.TRANSFER_AGENT);
  });
});
