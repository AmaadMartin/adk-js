/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  BaseTool,
  BaseToolset,
  Context,
  createSession,
  FunctionTool,
  InvocationContext,
  isBaseTool,
  LlmRequest,
  PluginManager,
  ReadonlyContext,
  ToolPredicate,
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

/** A tool carrying a subclass field, so a copy can be checked for it. */
class TaggedTool extends BaseTool {
  constructor(
    name: string,
    readonly tag: string,
  ) {
    super({name, description: `Tool ${name}`, isLongRunning: true});
  }

  override _getDeclaration() {
    return {name: this.name, description: this.description};
  }

  async runAsync(): Promise<unknown> {
    return `ran ${this.tag}`;
  }
}

/** A toolset returning exactly the tools it was given, counting each listing. */
class RecordingToolset extends BaseToolset {
  getToolsCalls = 0;

  constructor(
    private readonly tools: BaseTool[],
    prefix?: string,
  ) {
    super([], prefix);
  }

  async getTools(): Promise<BaseTool[]> {
    this.getToolsCalls++;
    return this.tools;
  }
}

class UncachedToolset extends RecordingToolset {
  constructor(tools: BaseTool[], prefix?: string) {
    super(tools, prefix);
    this.useInvocationCache = false;
  }
}

const TOOLSET_AUTH_CONFIG: AuthConfig = {
  authScheme: {type: 'apiKey', name: 'key', in: 'header'},
  credentialKey: 'toolset-key',
};

class AuthenticatedToolset extends RecordingToolset {
  override getAuthConfig(): AuthConfig | undefined {
    return TOOLSET_AUTH_CONFIG;
  }
}

function makeReadonlyContext(invocationId: string): ReadonlyContext {
  return new ReadonlyContext(makeInvocationContext(invocationId));
}

function makeInvocationContext(invocationId: string): InvocationContext {
  return new InvocationContext({
    invocationId,
    session: createSession({id: 'session-1', appName: 'app', userId: 'user-1'}),
    pluginManager: new PluginManager([]),
  });
}

function makeLlmRequest(): LlmRequest {
  return {contents: [], toolsDict: {}, liveConnectConfig: {}};
}

describe('BaseToolset.getToolsWithPrefix', () => {
  it('returns the original tools when no prefix is configured', async () => {
    const tools = [new TaggedTool('tool1', 'a'), new TaggedTool('tool2', 'b')];
    const toolset = new RecordingToolset(tools);

    const listed = await toolset.getToolsWithPrefix();

    expect(listed).toBe(tools);
    expect(listed.map((tool) => tool.name)).toEqual(['tool1', 'tool2']);
  });

  it('prefixes every tool name with the configured prefix', async () => {
    const toolset = new RecordingToolset(
      [new TaggedTool('tool1', 'a'), new TaggedTool('tool2', 'b')],
      'custom',
    );

    const listed = await toolset.getToolsWithPrefix();

    expect(listed.map((tool) => tool.name)).toEqual([
      'custom_tool1',
      'custom_tool2',
    ]);
  });

  it('leaves names unchanged when the prefix is undefined', async () => {
    const toolset = new RecordingToolset(
      [new TaggedTool('tool1', 'a')],
      undefined,
    );

    const listed = await toolset.getToolsWithPrefix();

    expect(toolset.prefix).toBeUndefined();
    expect(listed[0].name).toBe('tool1');
  });

  it('treats an empty-string prefix as no prefix', async () => {
    const toolset = new RecordingToolset([new TaggedTool('tool1', 'a')], '');

    const listed = await toolset.getToolsWithPrefix();

    expect(listed[0].name).toBe('tool1');
  });

  it('exposes the prefix it was constructed with', () => {
    expect(new RecordingToolset([], 'my_prefix').prefix).toBe('my_prefix');
  });

  it('copies the tool rather than renaming it', async () => {
    const original = new TaggedTool('tool1', 'a');
    const toolset = new RecordingToolset([original], 'custom');

    const [copy] = await toolset.getToolsWithPrefix();

    expect(copy).not.toBe(original);
    expect(copy.name).toBe('custom_tool1');
    expect(copy.description).toBe('Tool tool1');
    expect(copy.isLongRunning).toBe(true);
    expect((copy as TaggedTool).tag).toBe('a');
    expect(original.name).toBe('tool1');
  });

  it('keeps getTools unprefixed while getToolsWithPrefix prefixes', async () => {
    const original = new TaggedTool('tool1', 'a');
    const toolset = new RecordingToolset([original], 'custom');

    const raw = await toolset.getTools();
    const prefixed = await toolset.getToolsWithPrefix();

    expect(raw.map((tool) => tool.name)).toEqual(['tool1']);
    expect(prefixed.map((tool) => tool.name)).toEqual(['custom_tool1']);
    expect(original.name).toBe('tool1');
  });

  it('returns an empty list for an empty toolset with a prefix', async () => {
    const toolset = new RecordingToolset([], 'custom');

    expect(await toolset.getToolsWithPrefix()).toEqual([]);
  });

  it('prefixes the function declaration name and keeps its description', async () => {
    const tool = new FunctionTool({
      name: 'forecast',
      description: 'Returns the forecast',
      execute: async () => 'sunny',
    });
    const toolset = new RecordingToolset([tool], 'weather');

    const [copy] = await toolset.getToolsWithPrefix();
    const declaration = copy._getDeclaration();

    expect(declaration?.name).toBe('weather_forecast');
    expect(declaration?.description).toBe('Returns the forecast');
  });

  it('registers the prefixed name in the llm request', async () => {
    const toolset = new RecordingToolset(
      [new TaggedTool('tool1', 'a')],
      'custom',
    );
    const llmRequest = makeLlmRequest();
    const toolContext = new Context({
      invocationContext: makeInvocationContext('inv-1'),
    });

    const [copy] = await toolset.getToolsWithPrefix();
    await copy.processLlmRequest({toolContext, llmRequest});

    expect(Object.keys(llmRequest.toolsDict)).toEqual(['custom_tool1']);
    const declaredTool = llmRequest.config?.tools?.[0];
    if (!declaredTool || !('functionDeclarations' in declaredTool)) {
      expect.fail('the request carries no function declarations');
    }
    expect(declaredTool.functionDeclarations?.[0].name).toBe('custom_tool1');
  });

  it('gives each tool its own prefixed declaration', async () => {
    const toolset = new RecordingToolset(
      [new TaggedTool('tool1', 'a'), new TaggedTool('tool2', 'b')],
      'custom',
    );

    const listed = await toolset.getToolsWithPrefix();

    expect(listed.map((tool) => tool._getDeclaration()?.name)).toEqual([
      'custom_tool1',
      'custom_tool2',
    ]);
  });

  it('does not prefix twice across calls in one invocation', async () => {
    const toolset = new RecordingToolset(
      [new TaggedTool('tool1', 'a')],
      'custom',
    );
    const context = makeReadonlyContext('inv-1');

    const [first] = await toolset.getToolsWithPrefix(context);
    const [second] = await toolset.getToolsWithPrefix(context);

    expect(second).toBe(first);
    expect(second.name).toBe('custom_tool1');
  });

  it('leaves the original declaration unprefixed', async () => {
    const original = new TaggedTool('tool1', 'a');
    const toolset = new RecordingToolset([original], 'custom');

    await toolset.getToolsWithPrefix();

    expect(original._getDeclaration()?.name).toBe('tool1');
  });

  it('keeps the prototype of the copied tool', async () => {
    const original = new TaggedTool('tool1', 'a');
    const toolset = new RecordingToolset([original], 'custom');
    const toolContext = new Context({
      invocationContext: makeInvocationContext('inv-1'),
    });

    const [copy] = await toolset.getToolsWithPrefix();

    expect(isBaseTool(copy)).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Object.getPrototypeOf(original));
    expect(await copy.runAsync({args: {}, toolContext})).toBe('ran a');
  });

  it('returns undefined for a tool that declares nothing', async () => {
    class UndeclaredTool extends BaseTool {
      constructor() {
        super({name: 'silent', description: 'no declaration'});
      }
      async runAsync(): Promise<unknown> {
        return undefined;
      }
    }
    const toolset = new RecordingToolset([new UndeclaredTool()], 'custom');

    const [copy] = await toolset.getToolsWithPrefix();

    expect(copy.name).toBe('custom_silent');
    expect(copy._getDeclaration()).toBeUndefined();
  });
});

describe('BaseToolset invocation cache', () => {
  it('serves the same array for the same invocation', async () => {
    const toolset = new RecordingToolset(
      [new TaggedTool('tool1', 'a')],
      'custom',
    );
    const context = makeReadonlyContext('inv-1');

    const first = await toolset.getToolsWithPrefix(context);
    const second = await toolset.getToolsWithPrefix(context);

    expect(second).toBe(first);
    expect(toolset.getToolsCalls).toBe(1);
  });

  it('recomputes for a different invocation', async () => {
    const toolset = new RecordingToolset(
      [new TaggedTool('tool1', 'a')],
      'custom',
    );

    const first = await toolset.getToolsWithPrefix(
      makeReadonlyContext('inv-1'),
    );
    const second = await toolset.getToolsWithPrefix(
      makeReadonlyContext('inv-2'),
    );

    expect(second).not.toBe(first);
    expect(toolset.getToolsCalls).toBe(2);
  });

  it('caches two context-less calls under the same key', async () => {
    const toolset = new RecordingToolset(
      [new TaggedTool('tool1', 'a')],
      'custom',
    );

    const first = await toolset.getToolsWithPrefix();
    const second = await toolset.getToolsWithPrefix();

    expect(second).toBe(first);
    expect(toolset.getToolsCalls).toBe(1);
  });

  it('recomputes every call when the subclass opts out', async () => {
    const toolset = new UncachedToolset(
      [new TaggedTool('tool1', 'a')],
      'custom',
    );
    const context = makeReadonlyContext('inv-1');

    const first = await toolset.getToolsWithPrefix(context);
    const second = await toolset.getToolsWithPrefix(context);

    expect(second).not.toBe(first);
    expect(toolset.getToolsCalls).toBe(2);
  });
});

describe('BaseToolset extension hooks', () => {
  it('closes without throwing when the subclass does not override close', async () => {
    await expect(new RecordingToolset([]).close()).resolves.toBeUndefined();
  });

  it('throws from fromConfig, naming the subclass', () => {
    expect(() => RecordingToolset.fromConfig({}, '/tmp/toolset.yaml')).toThrow(
      'fromConfig() not implemented for toolset: RecordingToolset',
    );
  });

  it('returns no auth config by default', () => {
    expect(new RecordingToolset([]).getAuthConfig()).toBeUndefined();
  });

  it('returns the auth config an overriding subclass declares', () => {
    expect(new AuthenticatedToolset([]).getAuthConfig()).toBe(
      TOOLSET_AUTH_CONFIG,
    );
  });
});
