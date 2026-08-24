/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  FunctionNode,
  getAgentsInfo,
  getToolsInfo,
  LlmAgent,
  ReadonlyContext,
  RoutedAgent,
} from '@google/adk';
import {FunctionDeclaration, Tool, Type} from '@google/genai';
import {describe, expect, it} from 'vitest';

/** A tool that records how many times its declaration was requested. */
class CountingTool extends BaseTool {
  declarationCalls = 0;
  private readonly declared: boolean;

  constructor(name: string, declared = true) {
    super({name, description: `${name} description`});
    this.declared = declared;
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    this.declarationCalls++;
    if (!this.declared) {
      return undefined;
    }
    return {name: this.name, description: this.description};
  }

  override async runAsync(): Promise<unknown> {
    return {};
  }
}

/** A toolset resolving to a fixed list of tools. */
class CountingToolset extends BaseToolset {
  constructor(private readonly tools: BaseTool[]) {
    super([]);
  }

  override async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools;
  }

  override async close(): Promise<void> {}
}

/** The name of the single declaration each returned `Tool` carries. */
function declarationNames(tools: Tool[]): Array<string | undefined> {
  return tools.map((tool) => tool.functionDeclarations?.[0]?.name);
}

describe('getToolsInfo', () => {
  it('requests each resolved tool declaration exactly once', async () => {
    const declared = new CountingTool('declared_tool');
    const undeclared = new CountingTool('undeclared_tool', false);
    const inToolset = new CountingTool('toolset_tool');

    const toolsInfo = await getToolsInfo([
      declared,
      undeclared,
      new CountingToolset([inToolset]),
    ]);

    expect(declared.declarationCalls).toBe(1);
    expect(undeclared.declarationCalls).toBe(1);
    expect(inToolset.declarationCalls).toBe(1);
    expect(toolsInfo).toEqual([
      {
        functionDeclarations: [
          {name: 'declared_tool', description: 'declared_tool description'},
        ],
      },
      {
        functionDeclarations: [
          {name: 'toolset_tool', description: 'toolset_tool description'},
        ],
      },
    ]);
  });

  it('returns an empty list for empty input', async () => {
    expect(await getToolsInfo([])).toEqual([]);
  });

  it('wraps each declaration in its own tool, in input order', async () => {
    const toolsInfo = await getToolsInfo([
      new CountingTool('alpha'),
      new CountingTool('beta'),
    ]);

    expect(declarationNames(toolsInfo)).toEqual(['alpha', 'beta']);
    expect(toolsInfo.map((tool) => tool.functionDeclarations?.length)).toEqual([
      1, 1,
    ]);
  });

  it('flattens a toolset into its tools, in place', async () => {
    const toolset = new CountingToolset([
      new CountingTool('inner_one'),
      new CountingTool('inner_two'),
    ]);

    const toolsInfo = await getToolsInfo([new CountingTool('outer'), toolset]);

    expect(declarationNames(toolsInfo)).toEqual([
      'outer',
      'inner_one',
      'inner_two',
    ]);
  });

  it('omits a tool that declares nothing', async () => {
    const toolsInfo = await getToolsInfo([
      new CountingTool('hidden', false),
      new CountingTool('visible'),
    ]);

    expect(declarationNames(toolsInfo)).toEqual(['visible']);
  });

  it('wraps a node as a tool and reports its declaration', async () => {
    const node = new FunctionNode('node_target', () => 'done', {
      description: 'a node exposed as a tool',
      inputSchema: {
        type: Type.OBJECT,
        properties: {text: {type: Type.STRING}},
      },
    });

    const toolsInfo = await getToolsInfo([node]);

    expect(declarationNames(toolsInfo)).toEqual(['node_target']);
    expect(toolsInfo[0].functionDeclarations?.[0].description).toBe(
      'a node exposed as a tool',
    );
  });

  it('propagates an error raised while resolving a toolset', async () => {
    class FailingToolset extends BaseToolset {
      constructor() {
        super([]);
      }

      override async getTools(): Promise<BaseTool[]> {
        throw new Error('toolset unavailable');
      }

      override async close(): Promise<void> {}
    }

    await expect(getToolsInfo([new FailingToolset()])).rejects.toThrow(
      'toolset unavailable',
    );
  });
});

describe('getAgentsInfo', () => {
  it('reports a single agent with no sub-agents', async () => {
    const agent = new LlmAgent({
      name: 'root',
      description: 'the root',
      instruction: 'be helpful',
    });

    const agents = await getAgentsInfo(agent);

    expect(Object.keys(agents)).toEqual(['root']);
    expect(agents['root'].name).toBe('root');
    expect(agents['root'].description).toBe('the root');
    expect(agents['root'].instruction).toBe('be helpful');
    expect(agents['root'].subAgents).toEqual([]);
    expect(agents['root'].tools).toEqual([]);
  });

  it('includes transitively nested agents', async () => {
    const grandchild = new LlmAgent({name: 'grandchild'});
    const child = new LlmAgent({name: 'child', subAgents: [grandchild]});
    const root = new LlmAgent({name: 'root', subAgents: [child]});

    const agents = await getAgentsInfo(root);

    expect(new Set(Object.keys(agents))).toEqual(
      new Set(['root', 'child', 'grandchild']),
    );
  });

  it('records only the direct children of each agent', async () => {
    const grandchild = new LlmAgent({name: 'grandchild'});
    const child = new LlmAgent({name: 'child', subAgents: [grandchild]});
    const sibling = new LlmAgent({name: 'sibling'});
    const root = new LlmAgent({name: 'root', subAgents: [child, sibling]});

    const agents = await getAgentsInfo(root);

    expect(agents['root'].subAgents).toEqual(['child', 'sibling']);
    expect(agents['child'].subAgents).toEqual(['grandchild']);
    expect(agents['grandchild'].subAgents).toEqual([]);
  });

  it('reports each agent own tools without inheriting a child tools', async () => {
    const child = new LlmAgent({
      name: 'child',
      tools: [new CountingTool('child_tool')],
    });
    const root = new LlmAgent({
      name: 'root',
      tools: [new CountingTool('root_tool')],
      subAgents: [child],
    });

    const agents = await getAgentsInfo(root);

    expect(declarationNames(agents['root'].tools)).toEqual(['root_tool']);
    expect(declarationNames(agents['child'].tools)).toEqual(['child_tool']);
  });

  it('skips a sub-agent that is not an LlmAgent', async () => {
    const buried = new LlmAgent({name: 'buried'});
    const routed = new RoutedAgent({
      name: 'routed',
      agents: [buried],
      router: () => 'buried',
    });
    const root = new LlmAgent({name: 'root', subAgents: [routed]});

    const agents = await getAgentsInfo(root);

    expect(Object.keys(agents)).toEqual(['root']);
    expect(agents['root'].subAgents).toEqual([]);
  });

  it('records a child before its parent', async () => {
    const grandchild = new LlmAgent({name: 'grandchild'});
    const child = new LlmAgent({name: 'child', subAgents: [grandchild]});
    const root = new LlmAgent({name: 'root', subAgents: [child]});

    const agents = await getAgentsInfo(root);

    expect(Object.keys(agents)).toEqual(['grandchild', 'child', 'root']);
  });

  it('resolves an agent reachable by two paths exactly once', async () => {
    const sharedTool = new CountingTool('shared_tool');
    const shared = new LlmAgent({name: 'shared', tools: [sharedTool]});
    const a = new LlmAgent({name: 'a'});
    const b = new LlmAgent({name: 'b'});
    const root = new LlmAgent({name: 'root', subAgents: [a, b]});
    // Pushing bypasses the constructor parent check, which rejects a second
    // parent; the reference guards against the same double reachability.
    a.subAgents.push(shared);
    b.subAgents.push(shared);

    const agents = await getAgentsInfo(root);

    // The visited guard stops the second path from re-resolving the subtree,
    // which for a remote toolset would be a second round of I/O.
    expect(sharedTool.declarationCalls).toBe(1);
    expect(Object.keys(agents).filter((name) => name === 'shared')).toEqual([
      'shared',
    ]);
    expect(agents['a'].subAgents).toEqual(['shared']);
    expect(agents['b'].subAgents).toEqual(['shared']);
  });

  it('reports an empty instruction for an instruction provider', async () => {
    const agent = new LlmAgent({
      name: 'root',
      instruction: async () => 'dynamic',
    });

    const agents = await getAgentsInfo(agent);

    expect(agents['root'].instruction).toBe('');
  });

  it('keys an agent named __proto__ as an own property', async () => {
    const agent = new LlmAgent({name: '__proto__'});

    const agents = await getAgentsInfo(agent);

    expect(Object.keys(agents)).toEqual(['__proto__']);
    expect(Object.getPrototypeOf(agents)).toBe(Object.prototype);
  });
});
