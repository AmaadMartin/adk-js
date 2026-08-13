/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {beforeEach, describe, expect, it, vi} from 'vitest';

import {
  BaseTool,
  Context,
  createSession,
  InvocationContext,
  isBaseTool,
  isBaseToolset,
  PluginManager,
  ReadonlyContext,
  RunAsyncToolRequest,
  SequentialAgent,
  ToolboxAuthTokenGetter,
  ToolboxToolset,
} from '@google/adk';
import {FunctionDeclaration, Type} from '@google/genai';

const SERVER_URL = 'http://127.0.0.1:5000';

/**
 * Stands in for `@toolbox-sdk/adk`'s `ToolboxTool`, which is itself a
 * `BaseTool` wrapping a callable `@toolbox-sdk/core` tool. The real SDK is
 * never loaded: it imports `@google/adk` at module scope, which resolves to
 * the built `core/dist` and is absent on an unbuilt checkout.
 */
class FakeSdkTool extends BaseTool {
  /** The callable core tool, exposed so tests can assert how it was invoked. */
  readonly coreTool = vi.fn(
    async (args?: Record<string, unknown>): Promise<string> => {
      return `${this.name}:${JSON.stringify(args ?? {})}`;
    },
  );

  constructor(
    name: string,
    private readonly declaration: FunctionDeclaration | undefined,
  ) {
    super({name, description: `Description of ${name}`});
  }

  override _getDeclaration(): FunctionDeclaration | undefined {
    return this.declaration;
  }

  override async runAsync(request: RunAsyncToolRequest): Promise<unknown> {
    return this.coreTool(request.args);
  }
}

function createFakeSdkTool(
  toolName: string,
  declaration: FunctionDeclaration | undefined = {name: toolName},
): FakeSdkTool {
  return new FakeSdkTool(toolName, declaration);
}

const {clientConstructor, loadTool, loadToolset, MockToolboxClient} =
  vi.hoisted(() => {
    const clientConstructor =
      vi.fn<
        (
          url: string,
          session: unknown,
          clientHeaders: Record<string, string> | undefined,
        ) => void
      >();
    const loadToolset =
      vi.fn<
        (
          name?: string,
          authTokenGetters?: Record<string, ToolboxAuthTokenGetter>,
          boundParams?: Record<string, unknown>,
        ) => Promise<FakeSdkTool[]>
      >();
    const loadTool =
      vi.fn<
        (
          name: string,
          authTokenGetters?: Record<string, ToolboxAuthTokenGetter>,
          boundParams?: Record<string, unknown>,
        ) => Promise<FakeSdkTool>
      >();

    class MockToolboxClient {
      readonly loadToolset = loadToolset;
      readonly loadTool = loadTool;

      constructor(
        url: string,
        session: unknown,
        clientHeaders: Record<string, string> | undefined,
      ) {
        clientConstructor(url, session, clientHeaders);
      }
    }

    return {clientConstructor, loadTool, loadToolset, MockToolboxClient};
  });

vi.mock('@toolbox-sdk/adk', () => ({ToolboxClient: MockToolboxClient}));

/** Builds a real `Context` backed by real ADK plumbing (no stubs). */
function createRealContext(): Context {
  return new Context({invocationContext: createRealInvocationContext()});
}

function createRealInvocationContext(): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new SequentialAgent({name: 'toolbox_test_agent'}),
    session: createSession({id: 'test-session', appName: 'test-app'}),
    pluginManager: new PluginManager([]),
  });
}

describe('ToolboxToolset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadToolset.mockResolvedValue([]);
  });

  it('loads every tool on the server when no selector is given', async () => {
    loadToolset.mockResolvedValue([
      createFakeSdkTool('search-hotels-by-name'),
      createFakeSdkTool('book-hotel'),
    ]);

    const toolset = new ToolboxToolset(SERVER_URL);
    const tools = await toolset.getTools();

    expect(isBaseToolset(toolset)).toBe(true);
    expect(loadToolset).toHaveBeenCalledTimes(1);
    expect(loadToolset).toHaveBeenCalledWith(undefined, undefined, undefined);
    expect(loadTool).not.toHaveBeenCalled();
    expect(tools.map((tool) => tool.name)).toEqual([
      'search-hotels-by-name',
      'book-hotel',
    ]);
    expect(tools.map((tool) => tool.description)).toEqual([
      'Description of search-hotels-by-name',
      'Description of book-hotel',
    ]);
    expect(tools.map((tool) => isBaseTool(tool))).toEqual([true, true]);
  });

  it('loads the toolset named by toolsetName', async () => {
    loadToolset.mockResolvedValue([createFakeSdkTool('search-hotels-by-name')]);

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'my-toolset',
    });
    const tools = await toolset.getTools();

    expect(loadToolset).toHaveBeenCalledWith(
      'my-toolset',
      undefined,
      undefined,
    );
    expect(loadTool).not.toHaveBeenCalled();
    expect(tools.map((tool) => tool.name)).toEqual(['search-hotels-by-name']);
  });

  it('loads individually named tools without listing the whole server', async () => {
    loadTool.mockImplementation(async (name) => createFakeSdkTool(name));

    const toolset = new ToolboxToolset(SERVER_URL, {toolNames: ['a', 'b']});
    const tools = await toolset.getTools();

    expect(loadToolset).not.toHaveBeenCalled();
    expect(loadTool).toHaveBeenCalledTimes(2);
    expect(loadTool).toHaveBeenNthCalledWith(1, 'a', undefined, undefined);
    expect(loadTool).toHaveBeenNthCalledWith(2, 'b', undefined, undefined);
    expect(tools.map((tool) => tool.name)).toEqual(['a', 'b']);
  });

  it('treats an empty toolNames array as no selector at all', async () => {
    loadToolset.mockResolvedValue([createFakeSdkTool('search-hotels-by-name')]);

    const toolset = new ToolboxToolset(SERVER_URL, {toolNames: []});
    const tools = await toolset.getTools();

    expect(loadToolset).toHaveBeenCalledWith(undefined, undefined, undefined);
    expect(loadTool).not.toHaveBeenCalled();
    expect(tools.map((tool) => tool.name)).toEqual(['search-hotels-by-name']);
  });

  it('unions toolsetName with toolNames, toolset tools first', async () => {
    loadToolset.mockResolvedValue([createFakeSdkTool('from-toolset')]);
    loadTool.mockImplementation(async (name) => createFakeSdkTool(name));

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'my-toolset',
      toolNames: ['named-tool'],
    });
    const tools = await toolset.getTools();

    expect(loadToolset).toHaveBeenCalledTimes(1);
    expect(loadTool).toHaveBeenCalledTimes(1);
    expect(tools.map((tool) => tool.name)).toEqual([
      'from-toolset',
      'named-tool',
    ]);
  });

  it('forwards auth token getters without ever resolving them', async () => {
    const getToken = vi.fn(() => 'id-token');
    const authTokenGetters = {'my-google-auth': getToken};
    loadToolset.mockResolvedValue([createFakeSdkTool('from-toolset')]);
    loadTool.mockImplementation(async (name) => createFakeSdkTool(name));

    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'my-toolset',
      toolNames: ['named-tool'],
      authTokenGetters,
    });
    await toolset.getTools();

    expect(loadToolset.mock.calls[0][1]).toBe(authTokenGetters);
    expect(loadTool.mock.calls[0][1]).toBe(authTokenGetters);
    expect(getToken).not.toHaveBeenCalled();
  });

  it('forwards literal and callable bound params without resolving them', async () => {
    const getUserId = vi.fn(() => 'user-1');
    const boundParams = {userId: getUserId, tenant: 'acme'};
    const declaration: FunctionDeclaration = {
      name: 'search-hotels-by-name',
      description: 'Search hotels',
      parameters: {
        type: Type.OBJECT,
        properties: {name: {type: Type.STRING}},
      },
    };
    loadToolset.mockResolvedValue([
      createFakeSdkTool('search-hotels-by-name', declaration),
    ]);

    const toolset = new ToolboxToolset(SERVER_URL, {boundParams});
    const [tool] = await toolset.getTools();

    expect(loadToolset.mock.calls[0][2]).toBe(boundParams);
    expect(getUserId).not.toHaveBeenCalled();
    expect(tool._getDeclaration()).toBe(declaration);
  });

  it('constructs the client with the server url and additional headers', async () => {
    const additionalHeaders = {'X-Request-Source': 'adk-js'};

    const toolset = new ToolboxToolset(SERVER_URL, {additionalHeaders});
    await toolset.getTools();

    expect(clientConstructor).toHaveBeenCalledWith(
      SERVER_URL,
      null,
      additionalHeaders,
    );
  });

  it('creates the client lazily and reuses it across getTools calls', async () => {
    const toolset = new ToolboxToolset(SERVER_URL);
    expect(clientConstructor).not.toHaveBeenCalled();

    await toolset.getTools();
    await toolset.getTools();

    expect(clientConstructor).toHaveBeenCalledTimes(1);
    expect(loadToolset).toHaveBeenCalledTimes(2);
  });

  it('returns the SDK tool unwrapped, so runAsync reaches the core callable', async () => {
    const sdkTool = createFakeSdkTool('search-hotels-by-name');
    loadToolset.mockResolvedValue([sdkTool]);

    const toolset = new ToolboxToolset(SERVER_URL);
    const [tool] = await toolset.getTools();
    const args = {name: 'Hilton'};
    const result = await tool.runAsync({
      args,
      toolContext: createRealContext(),
    });

    expect(sdkTool.coreTool).toHaveBeenCalledTimes(1);
    expect(sdkTool.coreTool).toHaveBeenCalledWith(args);
    expect(result).toBe('search-hotels-by-name:{"name":"Hilton"}');
  });

  it('returns the SDK tool unwrapped, so an absent declaration stays absent', async () => {
    // Constructed directly: passing `undefined` to createFakeSdkTool would
    // fall back to its default declaration.
    loadToolset.mockResolvedValue([
      new FakeSdkTool('no-declaration', undefined),
    ]);

    const toolset = new ToolboxToolset(SERVER_URL);
    const [tool] = await toolset.getTools();

    expect(tool._getDeclaration()).toBeUndefined();
  });

  it('closes cleanly before and after tools have been loaded', async () => {
    const toolset = new ToolboxToolset(SERVER_URL);

    await expect(toolset.close()).resolves.toBeUndefined();
    await toolset.getTools();
    await expect(toolset.close()).resolves.toBeUndefined();
  });

  it('accepts and ignores a ReadonlyContext', async () => {
    loadToolset.mockResolvedValue([createFakeSdkTool('search-hotels-by-name')]);

    const toolset = new ToolboxToolset(SERVER_URL);
    const withoutContext = await toolset.getTools();
    const withContext = await toolset.getTools(
      new ReadonlyContext(createRealInvocationContext()),
    );

    expect(withContext.map((tool) => tool.name)).toEqual(
      withoutContext.map((tool) => tool.name),
    );
  });

  it('propagates server failures from the SDK unwrapped', async () => {
    const failure = new Error('toolbox server returned 503');
    loadToolset.mockRejectedValue(failure);

    const toolset = new ToolboxToolset(SERVER_URL);

    await expect(toolset.getTools()).rejects.toBe(failure);
  });
});

describe('ToolboxToolset without the optional @toolbox-sdk/adk peer', () => {
  it('reports the missing package and attaches the import failure', async () => {
    vi.resetModules();
    const importFailure = new Error("Cannot find module '@toolbox-sdk/adk'");
    vi.doMock('@toolbox-sdk/adk', () => {
      throw importFailure;
    });

    const {ToolboxToolset: FreshToolboxToolset} = await import('@google/adk');
    const toolset = new FreshToolboxToolset(SERVER_URL);

    await expect(toolset.getTools()).rejects.toThrow(
      "ToolboxToolset requires the '@toolbox-sdk/adk' package. " +
        'Install it with `npm install @toolbox-sdk/adk`.',
    );
    // The import failure is preserved as `cause`. Vitest interposes its own
    // error when a mock factory throws, so the original sits one level deeper.
    await expect(toolset.getTools()).rejects.toHaveProperty(
      'cause.cause',
      importFailure,
    );
  });
});
