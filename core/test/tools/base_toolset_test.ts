/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredentialTypes,
  BaseTool,
  BaseToolParams,
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
import {z} from 'zod/v4';

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

/** A tool with no function declaration. Mirrors adk-python's `_TestingTool`. */
class TestingTool extends BaseTool {
  constructor(params: BaseToolParams) {
    super(params);
  }

  async runAsync(): Promise<unknown> {
    return 'test result';
  }
}

/** A `TestingTool` carrying an extra own property, to prove copies keep it. */
class AnnotatedTool extends TestingTool {
  readonly customAttribute = 'custom_value';
}

/**
 * A toolset that returns its tools untouched, so `getToolsWithPrefix()` is the
 * only thing that can prefix them. Mirrors adk-python's `_TestingToolset`.
 */
class PlainToolset extends BaseToolset {
  constructor(
    private readonly tools: BaseTool[] = [],
    prefix?: string,
  ) {
    super([], prefix);
  }

  async getTools(): Promise<BaseTool[]> {
    return this.tools;
  }

  /** Mirrors `SkillToolset`, whose tool list changes within an invocation. */
  disableInvocationCache() {
    this.useInvocationCache = false;
  }
}

function readonlyContextFor(invocationId: string): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId,
      session: createSession({
        id: 'session-1',
        appName: 'test_app',
        userId: 'test_user',
      }),
      pluginManager: new PluginManager([]),
    }),
  );
}

describe('BaseToolset.getToolsWithPrefix', () => {
  it('leaves names unchanged when no prefix is configured', async () => {
    const toolset = new PlainToolset([
      new TestingTool({name: 'tool1', description: 'Test tool 1'}),
      new TestingTool({name: 'tool2', description: 'Test tool 2'}),
    ]);

    const tools = await toolset.getToolsWithPrefix();

    expect(tools.map((tool) => tool.name)).toEqual(['tool1', 'tool2']);
    expect(toolset.prefix).toBeUndefined();
  });

  it('prepends a configured prefix to every name', async () => {
    const toolset = new PlainToolset(
      [
        new TestingTool({name: 'tool1', description: 'Test tool 1'}),
        new TestingTool({name: 'tool2', description: 'Test tool 2'}),
      ],
      'custom',
    );

    const tools = await toolset.getToolsWithPrefix();

    expect(tools.map((tool) => tool.name)).toEqual([
      'custom_tool1',
      'custom_tool2',
    ]);
    expect(toolset.prefix).toBe('custom');
  });

  it('leaves names unchanged for an explicitly undefined prefix', async () => {
    const toolset = new PlainToolset(
      [new TestingTool({name: 'tool1', description: 'Test tool 1'})],
      undefined,
    );

    const tools = await toolset.getToolsWithPrefix();

    expect(tools.map((tool) => tool.name)).toEqual(['tool1']);
    expect(toolset.prefix).toBeUndefined();
  });

  it('treats an empty-string prefix as no prefix', async () => {
    const tool = new TestingTool({name: 'tool1', description: 'Test tool 1'});
    const toolset = new PlainToolset([tool], '');

    const tools = await toolset.getToolsWithPrefix();

    expect(tools).toHaveLength(1);
    expect(tools[0]).toBe(tool);
    expect(toolset.prefix).toBe('');
  });

  it('keeps the prefix readable after construction', () => {
    expect(new PlainToolset([], 'explicit').prefix).toBe('explicit');
    expect(new PlainToolset([], undefined).prefix).toBeUndefined();
  });

  it('returns copies that keep every other property of the original', async () => {
    const original = new AnnotatedTool({
      name: 'original',
      description: 'Original description',
      isLongRunning: true,
    });
    const toolset = new PlainToolset([original], 'test');

    const [copy] = await toolset.getToolsWithPrefix();

    expect(copy.name).toBe('test_original');
    expect(copy.description).toBe('Original description');
    expect(copy.isLongRunning).toBe(true);
    expect((copy as AnnotatedTool).customAttribute).toBe('custom_value');
    expect(original.name).toBe('original');
    expect(copy).not.toBe(original);
  });

  it('returns raw names from getTools() and prefixed copies from getToolsWithPrefix()', async () => {
    const toolset = new PlainToolset(
      [
        new TestingTool({name: 'test_tool1', description: 'Test tool 1'}),
        new TestingTool({name: 'test_tool2', description: 'Test tool 2'}),
      ],
      'prefix',
    );

    const originals = await toolset.getTools();
    expect(originals.map((tool) => tool.name)).toEqual([
      'test_tool1',
      'test_tool2',
    ]);

    const prefixed = await toolset.getToolsWithPrefix();
    expect(prefixed.map((tool) => tool.name)).toEqual([
      'prefix_test_tool1',
      'prefix_test_tool2',
    ]);

    expect(originals.map((tool) => tool.name)).toEqual([
      'test_tool1',
      'test_tool2',
    ]);
    expect(prefixed[0]).not.toBe(originals[0]);
    expect(prefixed[1]).not.toBe(originals[1]);
  });

  it('returns an empty list for an empty toolset with a prefix', async () => {
    const tools = await new PlainToolset([], 'test').getToolsWithPrefix();

    expect(tools).toEqual([]);
  });

  it('keeps the copy a BaseTool with its subclass behaviour intact', async () => {
    const original = new TestingTool({name: 'tool1', description: 'Test tool'});
    const toolset = new PlainToolset([original], 'test');

    const [copy] = await toolset.getToolsWithPrefix();

    expect(isBaseTool(copy)).toBe(true);
    expect(Object.getPrototypeOf(copy)).toBe(Object.getPrototypeOf(original));
    await expect(
      copy.runAsync({args: {}, toolContext: {} as Context}),
    ).resolves.toBe('test result');
  });

  it('returns undefined from a copy of a tool that has no declaration', async () => {
    const original = new TestingTool({name: 'tool1', description: 'Test tool'});
    const toolset = new PlainToolset([original], 'test');

    const [copy] = await toolset.getToolsWithPrefix();

    expect(copy.name).toBe('test_tool1');
    expect(copy._getDeclaration()).toBeUndefined();
  });
});

describe('BaseToolset.getToolsWithPrefix function declarations', () => {
  function greetTool(name = 'greet') {
    return new FunctionTool({
      name,
      description: 'A test function for checking prefixes.',
      parameters: z.object({param: z.string()}),
      execute: async ({param}: {param: string}) => `result: ${param}`,
    });
  }

  it('prefixes the declaration name and leaves the description alone', async () => {
    const toolset = new PlainToolset([greetTool()], 'prefix');

    const [copy] = await toolset.getToolsWithPrefix();
    const declaration = copy._getDeclaration();

    expect(copy.name).toBe('prefix_greet');
    expect(declaration?.name).toBe('prefix_greet');
    expect(declaration?.description).toBe(
      'A test function for checking prefixes.',
    );
  });

  it('does not mutate the declaration of the original tool', async () => {
    const original = greetTool();
    const toolset = new PlainToolset([original], 'prefix');

    await toolset.getToolsWithPrefix();

    expect(original._getDeclaration().name).toBe('greet');
  });

  it('gives each tool its own declaration', async () => {
    const toolset = new PlainToolset(
      [greetTool('tool_one'), greetTool('tool_two')],
      'test',
    );

    const [first, second] = await toolset.getToolsWithPrefix();

    expect(first._getDeclaration()?.name).toBe('test_tool_one');
    expect(second._getDeclaration()?.name).toBe('test_tool_two');
  });

  it('registers the prefixed name in the LLM request', async () => {
    const toolset = new PlainToolset([greetTool('test_function')], 'test');
    const [copy] = await toolset.getToolsWithPrefix();

    const llmRequest: LlmRequest = {
      contents: [],
      toolsDict: {},
      liveConnectConfig: {},
    };
    const toolContext = new Context({
      invocationContext: {session: {state: {}}} as unknown as InvocationContext,
    });

    await copy.processLlmRequest({toolContext, llmRequest});

    expect(llmRequest.toolsDict['test_test_function']).toBe(copy);
    const [declaredTool] = llmRequest.config?.tools ?? [];
    if (!declaredTool || !('functionDeclarations' in declaredTool)) {
      expect.fail('the LLM request carries no function declarations');
    }
    expect(declaredTool.functionDeclarations?.[0].name).toBe(
      'test_test_function',
    );
  });
});

describe('BaseToolset.getToolsWithPrefix caching', () => {
  it('does not prefix twice across calls', async () => {
    const original = new TestingTool({
      name: 'original',
      description: 'Original tool',
    });
    const toolset = new PlainToolset([original], 'test');

    const first = await toolset.getToolsWithPrefix();
    const second = await toolset.getToolsWithPrefix();

    expect(first.map((tool) => tool.name)).toEqual(['test_original']);
    expect(second.map((tool) => tool.name)).toEqual(['test_original']);
    expect(second[0]).toBe(first[0]);

    const raw = await toolset.getTools();
    expect(raw[0].name).toBe('original');
    expect(first[0]).not.toBe(raw[0]);
  });

  it('serves one invocation from the cache and rebuilds for the next', async () => {
    const toolset = new PlainToolset(
      [new TestingTool({name: 'tool1', description: 'Test tool 1'})],
      'test',
    );
    const first = readonlyContextFor('inv-1');

    const tools1 = await toolset.getToolsWithPrefix(first);
    const tools2 = await toolset.getToolsWithPrefix(first);
    expect(tools1.map((tool) => tool.name)).toEqual(['test_tool1']);
    expect(tools2).toBe(tools1);

    const tools3 = await toolset.getToolsWithPrefix(
      readonlyContextFor('inv-2'),
    );
    expect(tools3).not.toBe(tools1);
    expect(tools3.map((tool) => tool.name)).toEqual(['test_tool1']);
  });

  it('rebuilds on every call once a subclass disables the cache', async () => {
    const toolset = new PlainToolset(
      [new TestingTool({name: 'tool1', description: 'Test tool 1'})],
      'test',
    );
    const context = readonlyContextFor('inv-1');
    toolset.disableInvocationCache();

    const tools1 = await toolset.getToolsWithPrefix(context);
    const tools2 = await toolset.getToolsWithPrefix(context);

    expect(tools2).not.toBe(tools1);
  });

  it('leaves the cache untouched when getTools() throws', async () => {
    class FailingToolset extends BaseToolset {
      calls = 0;

      async getTools(): Promise<BaseTool[]> {
        this.calls++;
        throw new Error('listing failed');
      }
    }
    const toolset = new FailingToolset([], 'test');

    await expect(toolset.getToolsWithPrefix()).rejects.toThrow(
      'listing failed',
    );
    await expect(toolset.getToolsWithPrefix()).rejects.toThrow(
      'listing failed',
    );
    expect(toolset.calls).toBe(2);
  });
});

describe('BaseToolset subclass hooks', () => {
  it('closes without the subclass implementing close()', async () => {
    await expect(new PlainToolset().close()).resolves.toBeUndefined();
  });

  it('throws from fromConfig() naming the toolset class', () => {
    expect(() => PlainToolset.fromConfig({}, '/tmp/toolset.yaml')).toThrow(
      'fromConfig() not implemented for toolset: PlainToolset',
    );
  });

  it('returns no auth config at the base', () => {
    expect(new PlainToolset().getAuthConfig()).toBeUndefined();
  });

  it('returns the auth config a subclass supplies', () => {
    const authConfig: AuthConfig = {
      authScheme: {type: 'apiKey', name: 'key', in: 'header'},
      rawAuthCredential: {
        authType: AuthCredentialTypes.API_KEY,
        apiKey: 'secret',
      },
      credentialKey: 'test-key',
    };
    class AuthenticatedToolset extends PlainToolset {
      override getAuthConfig(): AuthConfig {
        return authConfig;
      }
    }

    expect(new AuthenticatedToolset().getAuthConfig()).toBe(authConfig);
  });
});
