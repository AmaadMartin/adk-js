/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  createSession,
  InMemorySessionService,
  InvocationContext,
  isFunctionTool,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  ToolboxToolset,
  ToolPredicate,
} from '@google/adk';
import {Type} from '@google/genai';
import {beforeEach, describe, expect, it, Mock, vi} from 'vitest';
import {z} from 'zod';
import {logger} from '../../src/utils/logger.js';
import {loadOptionalPeer} from '../../src/utils/optional_peer.js';

type OptionalPeerModule = typeof import('../../src/utils/optional_peer.js');

vi.mock('../../src/utils/optional_peer.js', async (importOriginal) => {
  const actual = await importOriginal<OptionalPeerModule>();
  return {...actual, loadOptionalPeer: vi.fn(actual.loadOptionalPeer)};
});

const {loadOptionalPeer: realLoadOptionalPeer} =
  await vi.importActual<OptionalPeerModule>('../../src/utils/optional_peer.js');

const sdk = vi.hoisted(() => ({
  constructedUrls: [] as string[],
  loadToolset: vi.fn<(name?: string) => Promise<FakeTool[]>>(),
  loadTool: vi.fn<(name: string) => Promise<FakeTool>>(),
}));

vi.mock('@toolbox-sdk/core', () => ({
  ToolboxClient: class {
    readonly loadToolset = sdk.loadToolset;
    readonly loadTool = sdk.loadTool;

    constructor(url: string) {
      sdk.constructedUrls.push(url);
    }
  },
}));

const SERVER_URL = 'http://toolbox.test:5000';

/**
 * A stand-in for the SDK's `ToolboxTool`: a callable carrying the three
 * accessors the toolset reads.
 */
type FakeTool = Mock<(args?: Record<string, unknown>) => Promise<string>> & {
  getName(): string;
  getDescription(): string;
  getParamSchema(): z.ZodObject<z.ZodRawShape>;
};

function createFakeTool(
  name: string,
  schema: z.ZodObject<z.ZodRawShape> = z.object({}),
): FakeTool {
  const call = vi.fn(
    async (args?: Record<string, unknown>) =>
      `${name} ran with ${JSON.stringify(args ?? {})}`,
  );
  return Object.assign(call, {
    getName: () => name,
    getDescription: () => `Tool ${name}`,
    getParamSchema: () => schema,
  });
}

function createInvocationContext(): InvocationContext {
  const agent = new LlmAgent({
    name: 'toolbox_agent',
    model: 'gemini-2.0-flash',
  });
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent,
    session: createSession({
      id: 'test-session',
      appName: 'toolbox_agent',
      userId: 'test-user',
    }),
    pluginManager: new PluginManager([]),
    sessionService: new InMemorySessionService(),
  });
}

/** A real tool context, for the tools returned by the toolset. */
function createToolContext(): Context {
  return new Context({invocationContext: createInvocationContext()});
}

/** A real readonly context, for the tools a predicate filter judges. */
function createReadonlyContext(): ReadonlyContext {
  return new ReadonlyContext(createInvocationContext());
}

describe('ToolboxToolset', () => {
  beforeEach(() => {
    sdk.constructedUrls.length = 0;
    sdk.loadToolset.mockReset();
    sdk.loadTool.mockReset();
    vi.mocked(loadOptionalPeer).mockClear();
  });

  it('loads every tool of a toolset', async () => {
    sdk.loadToolset.mockResolvedValue([
      createFakeTool('list-hotels'),
      createFakeTool('book-hotel'),
    ]);

    const toolset = new ToolboxToolset(SERVER_URL, {toolsetName: 'hotels'});
    const tools = await toolset.getTools();

    expect(sdk.loadToolset).toHaveBeenCalledExactlyOnceWith('hotels');
    expect(sdk.loadTool).not.toHaveBeenCalled();
    expect(tools.map((tool) => tool.name)).toEqual([
      'list-hotels',
      'book-hotel',
    ]);
    expect(tools.every(isFunctionTool)).toBe(true);
    expect(tools[0].description).toBe('Tool list-hotels');
  });

  it('loads individually named tools', async () => {
    sdk.loadTool.mockImplementation(async (name) => createFakeTool(name));

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['search-flights'],
    });
    const tools = await toolset.getTools();

    expect(sdk.loadTool).toHaveBeenCalledExactlyOnceWith('search-flights');
    expect(sdk.loadToolset).not.toHaveBeenCalled();
    expect(tools.map((tool) => tool.name)).toEqual(['search-flights']);
  });

  it('returns the toolset tools first, then the named ones in order', async () => {
    sdk.loadToolset.mockResolvedValue([
      createFakeTool('set-one'),
      createFakeTool('set-two'),
    ]);
    // The first name resolves last, so a passing assertion cannot be an
    // artefact of the resolution order.
    sdk.loadTool.mockImplementation(async (name) => {
      if (name === 'named-one') {
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      return createFakeTool(name);
    });

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotels',
      toolNames: ['named-one', 'named-two'],
    });
    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'set-one',
      'set-two',
      'named-one',
      'named-two',
    ]);
  });

  it('rejects a toolset that names nothing to load', () => {
    expect(() => new ToolboxToolset(SERVER_URL)).toThrow(
      'toolNames and toolsetName cannot both be empty',
    );
    expect(() => new ToolboxToolset(SERVER_URL, {})).toThrow(
      'toolNames and toolsetName cannot both be empty',
    );
    expect(() => new ToolboxToolset(SERVER_URL, {toolNames: []})).toThrow(
      'toolNames and toolsetName cannot both be empty',
    );
  });

  it('does no I/O until the tools are asked for', async () => {
    sdk.loadToolset.mockResolvedValue([]);

    const toolset = new ToolboxToolset(SERVER_URL, {toolsetName: 'hotels'});
    expect(sdk.constructedUrls).toEqual([]);

    await toolset.getTools();
    expect(sdk.constructedUrls).toEqual([SERVER_URL]);
  });

  it('creates one client per toolset, under sequential and concurrent calls', async () => {
    sdk.loadToolset.mockResolvedValue([createFakeTool('list-hotels')]);

    const sequential = new ToolboxToolset(SERVER_URL, {toolsetName: 'hotels'});
    await sequential.getTools();
    await sequential.getTools();
    expect(sdk.constructedUrls).toEqual([SERVER_URL]);

    const concurrent = new ToolboxToolset(SERVER_URL, {toolsetName: 'hotels'});
    await Promise.all([concurrent.getTools(), concurrent.getTools()]);
    expect(sdk.constructedUrls).toEqual([SERVER_URL, SERVER_URL]);
  });

  it('does not cache the tool list between calls', async () => {
    sdk.loadToolset
      .mockResolvedValueOnce([createFakeTool('list-hotels')])
      .mockResolvedValueOnce([
        createFakeTool('list-hotels'),
        createFakeTool('book-hotel'),
      ]);

    const toolset = new ToolboxToolset(SERVER_URL, {toolsetName: 'hotels'});

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'list-hotels',
    ]);
    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'list-hotels',
      'book-hotel',
    ]);
  });

  it('runs the remote tool with the validated arguments', async () => {
    const fake = createFakeTool('run-query', z.object({query: z.string()}));
    sdk.loadTool.mockResolvedValue(fake);

    const toolset = new ToolboxToolset(SERVER_URL, {toolNames: ['run-query']});
    const [tool] = await toolset.getTools();
    const result = await tool.runAsync({
      args: {query: 'SELECT 1'},
      toolContext: createToolContext(),
    });

    expect(fake).toHaveBeenCalledExactlyOnceWith({query: 'SELECT 1'});
    expect(result).toBe('run-query ran with {"query":"SELECT 1"}');
  });

  it('derives the declaration from the remote parameter schema', async () => {
    sdk.loadTool.mockResolvedValue(
      createFakeTool(
        'run-query',
        z.object({
          query: z.string().describe('The SQL to run'),
        }),
      ),
    );

    const toolset = new ToolboxToolset(SERVER_URL, {toolNames: ['run-query']});
    const [tool] = await toolset.getTools();
    const declaration = tool._getDeclaration();

    expect(declaration?.name).toBe('run-query');
    expect(declaration?.description).toBe('Tool run-query');
    expect(declaration?.parameters?.properties?.['query']).toMatchObject({
      type: Type.STRING,
      description: 'The SQL to run',
    });
    expect(declaration?.parameters?.required).toEqual(['query']);
  });

  it('propagates a server error unchanged', async () => {
    sdk.loadToolset.mockRejectedValue(new Error('unknown toolset "hotels"'));

    const toolset = new ToolboxToolset(SERVER_URL, {toolsetName: 'hotels'});

    await expect(toolset.getTools()).rejects.toThrow(
      new Error('unknown toolset "hotels"'),
    );
  });

  it('stays usable after close', async () => {
    sdk.loadToolset.mockResolvedValue([createFakeTool('list-hotels')]);

    const toolset = new ToolboxToolset(SERVER_URL, {toolsetName: 'hotels'});
    await expect(toolset.close()).resolves.toBeUndefined();

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'list-hotels',
    ]);
  });

  it('asks the shared loader for the toolbox package', async () => {
    sdk.loadToolset.mockResolvedValue([]);

    await new ToolboxToolset(SERVER_URL, {toolsetName: 'hotels'}).getTools();

    expect(loadOptionalPeer).toHaveBeenCalledWith(
      {packageName: '@toolbox-sdk/core', feature: 'ToolboxToolset'},
      expect.any(Function),
    );
  });

  it('names the package and the install command when it is missing', async () => {
    const notInstalled = Object.assign(
      new Error("Cannot find package '@toolbox-sdk/core'"),
      {code: 'ERR_MODULE_NOT_FOUND'},
    );
    // vi.mock cannot make an installed package unresolvable: vitest replaces a
    // factory that throws with an error of its own, which the loader is right
    // to pass through. Failing the import itself is what "not installed" is.
    vi.mocked(loadOptionalPeer).mockImplementationOnce((peer) =>
      realLoadOptionalPeer(peer, () => Promise.reject(notInstalled)),
    );

    const failure = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotels',
    }).getTools();

    await expect(failure).rejects.toThrow(
      /ToolboxToolset requires the optional peer dependency "@toolbox-sdk\/core"/,
    );
    await expect(failure).rejects.toThrow(/npm install @toolbox-sdk\/core/);
    await expect(failure).rejects.toMatchObject({cause: notInstalled});
  });

  it('prefixes the tool names, and still calls the remote tool', async () => {
    const remote = createFakeTool('book-hotel');
    sdk.loadToolset.mockResolvedValue([remote]);

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotels',
      prefix: 'travel',
    });
    const [tool] = await toolset.getTools();
    await tool.runAsync({args: {}, toolContext: createToolContext()});

    expect(tool.name).toBe('travel_book-hotel');
    expect(tool._getDeclaration()?.name).toBe('travel_book-hotel');
    expect(remote).toHaveBeenCalledExactlyOnceWith({});
  });

  it('keeps only the tools a name filter lists, matching the prefixed name', async () => {
    sdk.loadToolset.mockResolvedValue([
      createFakeTool('list-hotels'),
      createFakeTool('book-hotel'),
    ]);

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotels',
      prefix: 'travel',
      toolFilter: ['travel_book-hotel', 'list-hotels'],
    });

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'travel_book-hotel',
    ]);
  });

  it('keeps every tool when the name filter is empty', async () => {
    sdk.loadToolset.mockResolvedValue([
      createFakeTool('list-hotels'),
      createFakeTool('book-hotel'),
    ]);

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotels',
      toolFilter: [],
    });

    expect((await toolset.getTools()).map((tool) => tool.name)).toEqual([
      'list-hotels',
      'book-hotel',
    ]);
  });

  it('lets a predicate filter decide, given a context', async () => {
    sdk.loadToolset.mockResolvedValue([
      createFakeTool('list-hotels'),
      createFakeTool('book-hotel'),
    ]);
    const predicate = vi.fn<ToolPredicate>(
      (tool) => tool.name !== 'book-hotel',
    );
    const context = createReadonlyContext();

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotels',
      toolFilter: predicate,
    });

    expect((await toolset.getTools(context)).map((tool) => tool.name)).toEqual([
      'list-hotels',
    ]);
    expect(predicate).toHaveBeenCalledTimes(2);
    expect(predicate).toHaveBeenLastCalledWith(
      expect.objectContaining({name: 'book-hotel'}),
      context,
    );
  });

  it('keeps every tool and warns when a predicate filter has no context', async () => {
    sdk.loadToolset.mockResolvedValue([
      createFakeTool('list-hotels'),
      createFakeTool('book-hotel'),
    ]);
    const predicate = vi.fn<ToolPredicate>(() => false);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotels',
      toolFilter: predicate,
    });
    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'list-hotels',
      'book-hotel',
    ]);
    expect(predicate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining('The filter was not applied.'),
    );
    warn.mockRestore();
  });
});
