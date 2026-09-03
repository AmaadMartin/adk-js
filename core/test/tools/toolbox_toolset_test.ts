/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Context,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  ToolboxToolset,
  createSession,
} from '@google/adk';
import {beforeEach, describe, expect, it, vi} from 'vitest';
import {z} from 'zod';
import {logger} from '../../src/utils/logger.js';

/** One recorded `loadToolset` or `loadTool` call. */
interface LoadCall {
  name?: string;
  authTokenGetters?: unknown;
  boundParams?: unknown;
}

/** One recorded `ToolboxClient` construction. */
interface ClientCall {
  url: string;
  session: unknown;
  headers: unknown;
  protocol: unknown;
  clientName: unknown;
  clientVersion: unknown;
}

/** The auth services a tool the fake server publishes still needs. */
interface FakeToolAuth {
  /** Auth-gated parameter name to the services that can satisfy it. */
  requiredAuthnParams?: Record<string, string[]>;
  /** Services the invocation itself needs. */
  requiredAuthzTokens?: string[];
}

/** A zero-argument token getter, as `@toolbox-sdk/core` calls them. */
type SdkTokenGetter = () => string | Promise<string>;

const sdk = vi.hoisted(() => {
  /** Recorded calls, and the tools the fake server publishes. */
  const state = {
    clientCalls: [] as ClientCall[],
    toolsetCalls: [] as LoadCall[],
    toolCalls: [] as LoadCall[],
    invocations: [] as Array<Record<string, unknown> | undefined>,
    /** The `<service>_token` headers each invocation resolved. */
    invocationTokens: [] as Array<Record<string, string>>,
    /** Auth requirements the fake server advertises, by tool name. */
    toolAuth: {} as Record<string, FakeToolAuth>,
    /** Set to make reading `ToolboxClient` throw, as a failed load would. */
    importError: undefined as Error | undefined,
    /** Set to make the next tool invocation reject. */
    invocationError: undefined as Error | undefined,
  };

  /**
   * A fake `ToolboxTool`, reproducing the contract the toolset relies on: the
   * three accessors, the auth requirements, and an `addAuthTokenGetters` that
   * returns a new tool, drops the services it satisfied, and rejects a getter
   * the tool does not need. The real SDK tool is a callable function object
   * too, and it resolves every getter into a `<service>_token` header when it
   * is invoked.
   */
  function fakeTool(
    name: string,
    auth: FakeToolAuth = {},
    getters: Record<string, SdkTokenGetter> = {},
  ) {
    const requiredAuthnParams = auth.requiredAuthnParams ?? {};
    const requiredAuthzTokens = auth.requiredAuthzTokens ?? [];
    const call = async (args?: Record<string, unknown>) => {
      const tokens: Record<string, string> = {};
      for (const [service, getter] of Object.entries(getters)) {
        tokens[`${service}_token`] = await getter();
      }
      state.invocations.push(args);
      state.invocationTokens.push(tokens);
      if (state.invocationError) {
        throw state.invocationError;
      }
      return `${name}:${JSON.stringify(args)}`;
    };
    return Object.assign(call, {
      getName: () => name,
      getDescription: () => `description of ${name}`,
      getParamSchema: () => z.object({city: z.string()}),
      requiredAuthnParams,
      requiredAuthzTokens,
      addAuthTokenGetters(added: Record<string, SdkTokenGetter>) {
        const needed = new Set([
          ...requiredAuthzTokens,
          ...Object.values(requiredAuthnParams).flat(),
        ]);
        const unused = Object.keys(added).filter(
          (service) => !needed.has(service),
        );
        if (unused.length > 0) {
          throw new Error(
            `Authentication source(s) \`${unused.join(', ')}\` unused by ` +
              `tool \`${name}\`.`,
          );
        }
        const remaining: FakeToolAuth = {
          requiredAuthnParams: Object.fromEntries(
            Object.entries(requiredAuthnParams).filter(
              ([, services]) => !services.some((service) => service in added),
            ),
          ),
          requiredAuthzTokens: requiredAuthzTokens.filter(
            (service) => !(service in added),
          ),
        };
        return fakeTool(name, remaining, {...getters, ...added});
      },
    });
  }

  class FakeToolboxClient {
    constructor(
      url: string,
      session: unknown,
      headers: unknown,
      protocol?: unknown,
      clientName?: unknown,
      clientVersion?: unknown,
    ) {
      state.clientCalls.push({
        url,
        session,
        headers,
        protocol,
        clientName,
        clientVersion,
      });
    }

    async loadToolset(
      name?: string,
      authTokenGetters?: unknown,
      boundParams?: unknown,
    ) {
      state.toolsetCalls.push({name, authTokenGetters, boundParams});
      return [
        fakeTool('search_hotels', state.toolAuth['search_hotels']),
        fakeTool('book_hotel', state.toolAuth['book_hotel']),
      ];
    }

    async loadTool(
      name: string,
      authTokenGetters?: unknown,
      boundParams?: unknown,
    ) {
      state.toolCalls.push({name, authTokenGetters, boundParams});
      return fakeTool(name, state.toolAuth[name]);
    }
  }

  return {state, FakeToolboxClient};
});

vi.mock('@toolbox-sdk/core', () => ({
  get ToolboxClient() {
    if (sdk.state.importError) {
      throw sdk.state.importError;
    }
    return sdk.FakeToolboxClient;
  },
}));

const SERVER_URL = 'http://127.0.0.1:5000';

/** Builds the error Node raises for an unresolvable ESM specifier. */
function moduleNotFound(specifier: string): Error {
  const err = new Error(
    `Cannot find package '${specifier}' imported from /app/index.js`,
  ) as Error & {code?: string};
  err.code = 'ERR_MODULE_NOT_FOUND';
  return err;
}

function readonlyContext(): ReadonlyContext {
  return new ReadonlyContext(
    new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({id: 'test-session', appName: 'test-app'}),
      pluginManager: new PluginManager(),
    }),
  );
}

function toolContext(): Context {
  return new Context({invocationContext: readonlyContext().invocationContext});
}

beforeEach(() => {
  sdk.state.clientCalls = [];
  sdk.state.toolsetCalls = [];
  sdk.state.toolCalls = [];
  sdk.state.invocations = [];
  sdk.state.invocationTokens = [];
  sdk.state.toolAuth = {};
  sdk.state.importError = undefined;
  sdk.state.invocationError = undefined;
});

describe('ToolboxToolset client', () => {
  it('builds one client from the server url and headers', async () => {
    const headers = {'X-Api-Key': () => 'secret'};
    const toolset = new ToolboxToolset(SERVER_URL, {
      additionalHeaders: headers,
    });

    await toolset.getTools();

    // With no clientOptions the SDK gets `null` for its session and
    // `undefined` for the rest, so its own defaults apply.
    expect(sdk.state.clientCalls).toEqual([
      {
        url: SERVER_URL,
        session: null,
        headers,
        protocol: undefined,
        clientName: undefined,
        clientVersion: undefined,
      },
    ]);
  });

  it('loads nothing until getTools is called', () => {
    new ToolboxToolset(SERVER_URL, {toolsetName: 'hotel-tools'});

    expect(sdk.state.clientCalls).toEqual([]);
    expect(sdk.state.toolsetCalls).toEqual([]);
  });

  it('reuses one client across getTools calls but re-reads the tools', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
    });

    await toolset.getTools();
    await toolset.getTools();

    expect(sdk.state.clientCalls).toHaveLength(1);
    expect(sdk.state.toolsetCalls).toHaveLength(2);
  });

  it('shares one client between concurrent first calls', async () => {
    const toolset = new ToolboxToolset(SERVER_URL);

    await Promise.all([toolset.getTools(), toolset.getTools()]);

    expect(sdk.state.clientCalls).toHaveLength(1);
  });
});

describe('ToolboxToolset tool selection', () => {
  it('loads only the named toolset when toolsetName is given', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
    });

    const tools = await toolset.getTools();

    expect(sdk.state.toolsetCalls.map((call) => call.name)).toEqual([
      'hotel-tools',
    ]);
    expect(sdk.state.toolCalls).toEqual([]);
    expect(tools.map((tool) => tool.name)).toEqual([
      'search_hotels',
      'book_hotel',
    ]);
    expect(tools.map((tool) => tool.description)).toEqual([
      'description of search_hotels',
      'description of book_hotel',
    ]);
  });

  it('loads each named tool in order when only toolNames is given', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel', 'cancel_booking'],
    });

    const tools = await toolset.getTools();

    expect(sdk.state.toolsetCalls).toEqual([]);
    expect(sdk.state.toolCalls.map((call) => call.name)).toEqual([
      'book_hotel',
      'cancel_booking',
    ]);
    expect(tools.map((tool) => tool.name)).toEqual([
      'book_hotel',
      'cancel_booking',
    ]);
  });

  it('puts the toolset tools before the named tools when both are given', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      toolNames: ['cancel_booking'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'search_hotels',
      'book_hotel',
      'cancel_booking',
    ]);
  });

  it('loads the default toolset when neither name is given', async () => {
    const toolset = new ToolboxToolset(SERVER_URL);

    const tools = await toolset.getTools();

    expect(sdk.state.toolsetCalls).toEqual([
      {name: undefined, authTokenGetters: undefined, boundParams: undefined},
    ]);
    expect(sdk.state.toolCalls).toEqual([]);
    expect(tools).toHaveLength(2);
  });

  it('loads the default toolset when toolNames is empty', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {toolNames: []});

    await toolset.getTools();

    expect(sdk.state.toolsetCalls.map((call) => call.name)).toEqual([
      undefined,
    ]);
  });

  it('keeps a tool that the toolset and toolNames both reach', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      toolNames: ['book_hotel'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'search_hotels',
      'book_hotel',
      'book_hotel',
    ]);
  });

  it('forwards boundParams to both load calls and no getters', async () => {
    const authTokenGetters = {'my-auth': () => 'token'};
    const boundParams = {tenantId: 'acme'};
    sdk.state.toolAuth = {book_hotel: {requiredAuthzTokens: ['my-auth']}};
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      toolNames: ['book_hotel'],
      authTokenGetters,
      boundParams,
    });

    await toolset.getTools();

    // The getters are bound per invocation instead, so the load calls carry
    // none. See 'ToolboxToolset auth token getters'.
    expect(sdk.state.toolsetCalls).toEqual([
      {name: 'hotel-tools', authTokenGetters: undefined, boundParams},
    ]);
    expect(sdk.state.toolCalls).toEqual([
      {name: 'book_hotel', authTokenGetters: undefined, boundParams},
    ]);
  });
});

describe('ToolboxToolset returned tools', () => {
  it('declares the name, description and parameter schema of the server tool', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
    });

    const [tool] = await toolset.getTools();

    expect(tool._getDeclaration()).toEqual({
      name: 'book_hotel',
      description: 'description of book_hotel',
      parameters: {
        type: 'OBJECT',
        properties: {city: {type: 'STRING'}},
        required: ['city'],
      },
    });
  });

  it('passes the model arguments to the server tool and returns its result', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
    });

    const [tool] = await toolset.getTools();
    const result = await tool.runAsync({
      args: {city: 'Basel'},
      toolContext: toolContext(),
    });

    expect(sdk.state.invocations).toEqual([{city: 'Basel'}]);
    expect(result).toBe('book_hotel:{"city":"Basel"}');
  });

  it('surfaces an error raised by the server tool', async () => {
    sdk.state.invocationError = new Error('tool unavailable');
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
    });

    const [tool] = await toolset.getTools();

    await expect(
      tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()}),
    ).rejects.toThrow('tool unavailable');
  });
});

describe('ToolboxToolset prefix and filter', () => {
  it('prefixes every tool name and still reaches the server tool', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      prefix: 'hotels',
    });

    const [tool] = await toolset.getTools();

    expect(tool.name).toBe('hotels_book_hotel');
    await tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()});
    expect(sdk.state.invocations).toEqual([{city: 'Basel'}]);
  });

  it('filters on the prefixed name for a string[] filter', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      prefix: 'hotels',
      toolFilter: ['hotels_book_hotel'],
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual(['hotels_book_hotel']);
  });

  it('applies a predicate filter against the context', async () => {
    const context = readonlyContext();
    const seen: string[] = [];
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      toolFilter: (tool, readonlyCtx) => {
        expect(readonlyCtx).toBe(context);
        seen.push(tool.name);
        return tool.name === 'book_hotel';
      },
    });

    const tools = await toolset.getTools(context);

    expect(seen).toEqual(['search_hotels', 'book_hotel']);
    expect(tools.map((tool) => tool.name)).toEqual(['book_hotel']);
  });

  it('returns every tool and warns when a predicate filter has no context', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      toolFilter: (tool) => tool.name === 'book_hotel',
    });

    const tools = await toolset.getTools();

    expect(tools).toHaveLength(2);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('without a ReadonlyContext'),
    );
    warn.mockRestore();
  });
});

describe('ToolboxToolset close', () => {
  it('is idempotent and lets a later getTools build a new client', async () => {
    const toolset = new ToolboxToolset(SERVER_URL);

    await toolset.getTools();
    await toolset.close();
    await toolset.close();
    await toolset.getTools();

    expect(sdk.state.clientCalls).toHaveLength(2);
  });
});

describe('ToolboxToolset optional peer', () => {
  // Reading `ToolboxClient` off the mocked module raises the error Node
  // raises for a package that is not installed, which is what the toolset
  // sees when `@toolbox-sdk/core` is absent.
  it('names the feature and the install command when the package is missing', async () => {
    sdk.state.importError = moduleNotFound('@toolbox-sdk/core');
    const toolset = new ToolboxToolset(SERVER_URL);

    const tools = toolset.getTools();

    await expect(tools).rejects.toThrow(/ToolboxToolset requires/);
    await expect(tools).rejects.toThrow(/npm install @toolbox-sdk\/core/);
  });

  it('rethrows an unrelated load failure unchanged', async () => {
    sdk.state.importError = new Error('the package itself is broken');
    const toolset = new ToolboxToolset(SERVER_URL);

    await expect(toolset.getTools()).rejects.toThrow(
      'the package itself is broken',
    );
  });
});
