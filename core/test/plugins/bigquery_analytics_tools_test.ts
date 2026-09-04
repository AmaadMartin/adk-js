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
import {type FunctionDeclaration, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';
import {
  extractToolDeclarations,
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

/** A tool returning whatever declaration a test hands it. */
class DeclaredTool extends BaseTool {
  constructor(
    params: {name: string; description: string},
    private readonly declaration: FunctionDeclaration | undefined,
  ) {
    super(params);
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  override async runAsync(): Promise<unknown> {
    return 'done';
  }
}

/** A tool whose declaration throws, as a built-in tool's can. */
class UndeclarableTool extends BaseTool {
  constructor() {
    super({name: 'undeclarable', description: 'Cannot describe itself.'});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    throw new Error('no declaration available');
  }

  override async runAsync(): Promise<unknown> {
    return 'done';
  }
}

/**
 * Ported from adk-python
 * tests/unittests/plugins/test_bigquery_agent_analytics_plugin.py @ main
 * (`_extract_tool_declarations`).
 */
describe('extractToolDeclarations', () => {
  it('emits the name and description of every tool, in registration order', () => {
    expect(
      extractToolDeclarations({
        lookup: localTool('lookup'),
        remote_lookup: mcpTool(),
      }),
    ).toEqual([
      {
        name: 'lookup',
        description: 'Looks something up.',
        parameters: {type: Type.OBJECT, properties: {}},
      },
      {
        name: 'remote_lookup',
        description: 'Looks up remotely.',
        parameters: {type: Type.OBJECT, properties: {}},
      },
    ]);
  });

  it('prefers parametersJsonSchema over parameters', () => {
    const tool = new DeclaredTool(
      {name: 'search', description: 'Searches.'},
      {
        name: 'search',
        parametersJsonSchema: {
          type: 'object',
          properties: {q: {type: 'string'}},
        },
        parameters: {type: Type.OBJECT},
      },
    );
    expect(extractToolDeclarations({search: tool})[0].parameters).toEqual({
      type: 'object',
      properties: {q: {type: 'string'}},
    });
  });

  it('falls back to parameters when the declaration has no JSON schema', () => {
    const tool = new DeclaredTool(
      {name: 'search', description: 'Searches.'},
      {
        name: 'search',
        parameters: {type: Type.OBJECT},
      },
    );
    expect(extractToolDeclarations({search: tool})[0].parameters).toEqual({
      type: Type.OBJECT,
    });
  });

  it('omits parameters when the declaration carries neither shape', () => {
    const tool = new DeclaredTool(
      {name: 'search', description: 'Searches.'},
      {
        name: 'search',
      },
    );
    expect(extractToolDeclarations({search: tool})[0]).toEqual({
      name: 'search',
      description: 'Searches.',
    });
  });

  it("takes the declaration's description when the tool has none", () => {
    const tool = new DeclaredTool(
      {name: 'search', description: ''},
      {
        name: 'search',
        description: 'Described by the declaration.',
      },
    );
    expect(extractToolDeclarations({search: tool})[0].description).toBe(
      'Described by the declaration.',
    );
  });

  it('omits the description when neither the tool nor its declaration has one', () => {
    const tool = new DeclaredTool(
      {name: 'search', description: ''},
      {
        name: 'search',
        description: '',
      },
    );
    expect(extractToolDeclarations({search: tool})[0]).toEqual({
      name: 'search',
    });
  });

  it('falls back to the map key when the tool name is falsy', () => {
    const tool = new DeclaredTool(
      {name: '', description: 'Unnamed.'},
      undefined,
    );
    expect(extractToolDeclarations({registered_as: tool})[0].name).toBe(
      'registered_as',
    );
  });

  it('keeps a tool whose declaration throws, and every tool beside it', () => {
    expect(
      extractToolDeclarations({
        undeclarable: new UndeclarableTool(),
        lookup: localTool('lookup'),
      }),
    ).toEqual([
      {name: 'undeclarable', description: 'Cannot describe itself.'},
      {
        name: 'lookup',
        description: 'Looks something up.',
        parameters: {type: Type.OBJECT, properties: {}},
      },
    ]);
  });

  it('emits nothing for a request offering no tools', () => {
    expect(extractToolDeclarations({})).toEqual([]);
  });
});
