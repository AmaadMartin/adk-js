/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  BaseTool,
  BaseToolset,
  Context,
  InvocationContext,
  LlmRequest,
  PluginManager,
  ReadonlyContext,
  ToolPredicate,
  createSession,
  isBaseTool,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

class DummyTool extends BaseTool {
  constructor(name: string) {
    super({name, description: 'Dummy tool'});
  }
  _getDeclaration() {
    return {name: this.name, description: this.description};
  }

  async runAsync(): Promise<unknown> {
    return 'dummy';
  }
}

class DummyToolset extends BaseToolset {
  constructor(prefix?: string) {
    super([], prefix);
  }

  async getTools(): Promise<BaseTool[]> {
    const rawTools = [new DummyTool('tool1'), new DummyTool('tool2')];
    return rawTools.map((tool) => {
      return new DummyTool(
        this.prefix ? `${this.prefix}_${tool.name}` : tool.name,
      );
    });
  }

  async close(): Promise<void> {}
}

class FilteringToolset extends BaseToolset {
  constructor(toolFilter: ToolPredicate | string[]) {
    super(toolFilter);
  }

  async getTools(context?: ReadonlyContext): Promise<BaseTool[]> {
    const rawTools = [new DummyTool('tool1'), new DummyTool('tool2')];
    if (!context) {
      return rawTools;
    }
    return rawTools.filter((tool) => this.isToolSelected(tool, context));
  }

  async close(): Promise<void> {}
}

describe('BaseToolset.isToolSelected', () => {
  const context = {} as unknown as ReadonlyContext;

  it('selects all tools when the toolFilter is an empty array', async () => {
    const toolset = new FilteringToolset([]);
    const tools = await toolset.getTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(['tool1', 'tool2']);
  });

  it('selects only the named tools for a non-empty string[] filter', async () => {
    const toolset = new FilteringToolset(['tool2']);
    const tools = await toolset.getTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(['tool2']);
  });

  it('applies a ToolPredicate filter', async () => {
    const toolset = new FilteringToolset((tool) => tool.name === 'tool1');
    const tools = await toolset.getTools(context);
    expect(tools.map((tool) => tool.name)).toEqual(['tool1']);
  });
});

describe('BaseToolset integration with LLM Request', () => {
  it('No prefix means the tool names match original names', async () => {
    const toolset = new DummyToolset();
    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('tool1');
    expect(tools[1].name).toBe('tool2');
  });

  it('Toolsets with a configured prefix correctly prefix names', async () => {
    const toolset = new DummyToolset('myprefix');
    const tools = await toolset.getTools();
    expect(tools.length).toBe(2);
    expect(tools[0].name).toBe('myprefix_tool1');
    expect(tools[1].name).toBe('myprefix_tool2');
  });

  it('Multiple toolsets with no prefix and conflicting tool names cause an error', async () => {
    const toolset1 = new DummyToolset();
    const toolset2 = new DummyToolset(); // will emit tool1 and tool2 again

    const tools1 = await toolset1.getTools();
    const tools2 = await toolset2.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    // Set up dummy context
    const context = new Context({
      invocationContext: {session: {state: {}}} as unknown as InvocationContext,
    });

    for (const tool of tools1) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    // Attempting to add tools from toolset2 should fail on the first duplicate ('tool1')
    await expect(async () => {
      for (const tool of tools2) {
        await tool.processLlmRequest({toolContext: context, llmRequest});
      }
    }).rejects.toThrow('Duplicate tool name: tool1');
  });

  it('Multiple toolsets with separate prefixes and conflicting tool names do not cause an error', async () => {
    const toolset1 = new DummyToolset('prefixA');
    const toolset2 = new DummyToolset('prefixB');

    const tools1 = await toolset1.getTools();
    const tools2 = await toolset2.getTools();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const context = new Context({
      invocationContext: {session: {state: {}}} as unknown as InvocationContext,
    });

    for (const tool of tools1) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    for (const tool of tools2) {
      await tool.processLlmRequest({toolContext: context, llmRequest});
    }

    const toolKeys = Object.keys(llmRequest.toolsDict);
    expect(toolKeys.length).toBe(4);
    expect(toolKeys).toContain('prefixA_tool1');
    expect(toolKeys).toContain('prefixA_tool2');
    expect(toolKeys).toContain('prefixB_tool1');
    expect(toolKeys).toContain('prefixB_tool2');
  });
});

/**
 * A tool that reports its declaration name from the name it was constructed
 * with, so a prefixed declaration name can only come from the base class.
 */
class PlainTool extends BaseTool {
  readonly serverName: string;

  constructor(
    private readonly declaredName: string,
    isLongRunning = false,
  ) {
    super({
      name: declaredName,
      description: `Tool ${declaredName}`,
      isLongRunning,
    });
    this.serverName = `server-of-${declaredName}`;
  }

  override _getDeclaration() {
    return {name: this.declaredName, description: this.description};
  }

  async runAsync(): Promise<unknown> {
    return this.serverName;
  }
}

function isPlainTool(tool: BaseTool): tool is PlainTool {
  return 'serverName' in tool;
}

/** A tool that keeps the `BaseTool` default of having no declaration. */
class UndeclaredTool extends BaseTool {
  constructor(name: string) {
    super({name, description: 'Undeclared tool'});
  }

  async runAsync(): Promise<unknown> {
    return 'undeclared';
  }
}

/** A toolset that returns the tools it was given and counts the listings. */
class RecordingToolset extends BaseToolset {
  getToolsCalls = 0;

  constructor(
    private readonly rawTools: BaseTool[],
    prefix?: string,
  ) {
    super([], prefix);
  }

  override async getTools(): Promise<BaseTool[]> {
    this.getToolsCalls++;
    return this.rawTools;
  }

  async close(): Promise<void> {}
}

/** A toolset whose tool list may change within a single invocation. */
class UncachedToolset extends RecordingToolset {
  constructor(rawTools: BaseTool[], prefix?: string) {
    super(rawTools, prefix);
    this.useInvocationCache = false;
  }
}

function invocationContext(invocationId: string): InvocationContext {
  return new InvocationContext({
    invocationId,
    session: createSession({
      id: 'test-session',
      events: [],
      appName: 'test-app',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager(),
  });
}

function readonlyContext(invocationId: string): ReadonlyContext {
  return new ReadonlyContext(invocationContext(invocationId));
}

describe('BaseToolset.getToolsWithPrefix', () => {
  it('leaves tool names unchanged when no prefix is configured', async () => {
    const toolset = new RecordingToolset([
      new PlainTool('tool1'),
      new PlainTool('tool2'),
    ]);

    const tools = await toolset.getToolsWithPrefix();

    expect(tools.map((tool) => tool.name)).toEqual(['tool1', 'tool2']);
  });

  it('prefixes tool names when a prefix is configured', async () => {
    const toolset = new RecordingToolset(
      [new PlainTool('tool1'), new PlainTool('tool2')],
      'myprefix',
    );

    const tools = await toolset.getToolsWithPrefix();

    expect(tools.map((tool) => tool.name)).toEqual([
      'myprefix_tool1',
      'myprefix_tool2',
    ]);
  });

  it('treats an empty string prefix as no prefix', async () => {
    const toolset = new RecordingToolset([new PlainTool('tool1')], '');

    const tools = await toolset.getToolsWithPrefix();

    expect(tools.map((tool) => tool.name)).toEqual(['tool1']);
  });

  it('prefixes the function declaration name as well as the tool name', async () => {
    const toolset = new RecordingToolset([new PlainTool('tool1')], 'myprefix');

    const [tool] = await toolset.getToolsWithPrefix();

    expect(tool._getDeclaration()?.name).toBe('myprefix_tool1');
    expect(tool._getDeclaration()?.name).toBe(tool.name);
  });

  it('keeps an undefined declaration undefined', async () => {
    const toolset = new RecordingToolset(
      [new UndeclaredTool('tool1')],
      'myprefix',
    );

    const [tool] = await toolset.getToolsWithPrefix();

    expect(tool.name).toBe('myprefix_tool1');
    expect(tool._getDeclaration()).toBeUndefined();
  });

  it('does not mutate the tools returned by getTools', async () => {
    const original = new PlainTool('tool1');
    const toolset = new RecordingToolset([original], 'myprefix');

    const [tool] = await toolset.getToolsWithPrefix();

    expect(tool).not.toBe(original);
    expect(original.name).toBe('tool1');
    expect(original._getDeclaration().name).toBe('tool1');
  });

  it('preserves the tool identity, description and subclass fields', async () => {
    const toolset = new RecordingToolset(
      [new PlainTool('tool1', true)],
      'myprefix',
    );

    const [tool] = await toolset.getToolsWithPrefix();

    expect(isBaseTool(tool)).toBe(true);
    expect(tool.description).toBe('Tool tool1');
    expect(tool.isLongRunning).toBe(true);
    if (!isPlainTool(tool)) {
      expect.fail('the prefixed copy lost its subclass fields');
    }
    expect(tool.serverName).toBe('server-of-tool1');
  });

  it('does not prefix twice over repeated calls', async () => {
    const toolset = new RecordingToolset([new PlainTool('tool1')], 'myprefix');

    await toolset.getToolsWithPrefix();
    const tools = await toolset.getToolsWithPrefix();

    expect(tools.map((tool) => tool.name)).toEqual(['myprefix_tool1']);
  });

  it('returns an empty list for an empty toolset', async () => {
    const toolset = new RecordingToolset([], 'myprefix');

    expect(await toolset.getToolsWithPrefix()).toEqual([]);
  });

  it('lists the tools once per invocation', async () => {
    const toolset = new RecordingToolset([new PlainTool('tool1')], 'myprefix');
    const context = readonlyContext('invocation-1');

    const first = await toolset.getToolsWithPrefix(context);
    const second = await toolset.getToolsWithPrefix(context);

    expect(toolset.getToolsCalls).toBe(1);
    expect(second).toBe(first);
  });

  it('lists the tools again for a new invocation', async () => {
    const toolset = new RecordingToolset([new PlainTool('tool1')], 'myprefix');

    const first = await toolset.getToolsWithPrefix(
      readonlyContext('invocation-1'),
    );
    const second = await toolset.getToolsWithPrefix(
      readonlyContext('invocation-2'),
    );

    expect(toolset.getToolsCalls).toBe(2);
    expect(second).not.toBe(first);
  });

  it('lists the tools on every call when the invocation cache is off', async () => {
    const toolset = new UncachedToolset([new PlainTool('tool1')], 'myprefix');
    const context = readonlyContext('invocation-1');

    const first = await toolset.getToolsWithPrefix(context);
    const second = await toolset.getToolsWithPrefix(context);

    expect(toolset.getToolsCalls).toBe(2);
    expect(second).not.toBe(first);
    expect(second.map((tool) => tool.name)).toEqual(['myprefix_tool1']);
  });

  it('lets a prefix disambiguate the same tool name from two toolsets', async () => {
    const docsToolset = new RecordingToolset([new PlainTool('search')], 'docs');
    const webToolset = new RecordingToolset([new PlainTool('search')]);
    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const context = new Context({
      invocationContext: invocationContext('invocation-1'),
    });

    for (const toolset of [webToolset, docsToolset]) {
      for (const tool of await toolset.getToolsWithPrefix()) {
        await tool.processLlmRequest({toolContext: context, llmRequest});
      }
    }

    expect(Object.keys(llmRequest.toolsDict)).toEqual([
      'search',
      'docs_search',
    ]);
  });
});
