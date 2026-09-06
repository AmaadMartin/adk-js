/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredential,
  AuthCredentialTypes,
  BaseTool,
  Context,
  InMemoryCredentialService,
  InvocationContext,
  PluginManager,
  ReadonlyContext,
  ToolboxCredentialStrategy,
  ToolboxHeaderValue,
  ToolboxToolset,
  createSession,
} from '@google/adk';
import axios from 'axios';
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
    /** The client headers each invocation resolved. */
    invocationHeaders: [] as Array<Record<string, string>>,
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
    clientHeaders: Record<string, string | SdkTokenGetter> = {},
  ) {
    const requiredAuthnParams = auth.requiredAuthnParams ?? {};
    const requiredAuthzTokens = auth.requiredAuthzTokens ?? [];
    const call = async (args?: Record<string, unknown>) => {
      const tokens: Record<string, string> = {};
      for (const [service, getter] of Object.entries(getters)) {
        tokens[`${service}_token`] = await getter();
      }
      const headers: Record<string, string> = {};
      for (const [header, value] of Object.entries(clientHeaders)) {
        headers[header] = typeof value === 'function' ? await value() : value;
      }
      state.invocations.push(args);
      state.invocationTokens.push(tokens);
      state.invocationHeaders.push(headers);
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
        return fakeTool(name, remaining, {...getters, ...added}, clientHeaders);
      },
    });
  }

  class FakeToolboxClient {
    private readonly clientHeaders: Record<string, string | SdkTokenGetter>;

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
      this.clientHeaders = (headers ?? {}) as Record<
        string,
        string | SdkTokenGetter
      >;
    }

    async loadToolset(
      name?: string,
      authTokenGetters?: unknown,
      boundParams?: unknown,
    ) {
      state.toolsetCalls.push({name, authTokenGetters, boundParams});
      return [this.build('search_hotels'), this.build('book_hotel')];
    }

    async loadTool(
      name: string,
      authTokenGetters?: unknown,
      boundParams?: unknown,
    ) {
      state.toolCalls.push({name, authTokenGetters, boundParams});
      return this.build(name);
    }

    /** The SDK gives every loaded tool the client's headers. */
    private build(name: string) {
      return fakeTool(name, state.toolAuth[name], {}, this.clientHeaders);
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
  sdk.state.invocationHeaders = [];
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

/** The credential key the toolset derives from the server url. */
const USER_IDENTITY_KEY = `toolbox_user_identity_${SERVER_URL}`;

const USER_CREDENTIALS = ToolboxCredentialStrategy.userIdentity({
  clientId: 'client',
  clientSecret: 'secret',
});

/** A consented OAuth2 credential, as the client returns it. */
function consented(oauth2: {
  accessToken?: string;
  idToken?: string;
}): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

/** A tool context that can request, load and save credentials. */
function credentialToolContext(
  options: {
    credentialService?: InMemoryCredentialService;
    sessionState?: Record<string, unknown>;
  } = {},
): Context {
  return new Context({
    invocationContext: new InvocationContext({
      invocationId: 'test-invocation',
      session: createSession({
        id: 'test-session',
        appName: 'test-app',
        state: options.sessionState,
      }),
      pluginManager: new PluginManager(),
      credentialService: options.credentialService,
    }),
    functionCallId: 'call-1',
  });
}

/** Resolves one header the toolset gave the client. */
async function clientHeader(name: string): Promise<string> {
  const headers = sdk.state.clientCalls[0].headers as Record<
    string,
    ToolboxHeaderValue
  >;
  const value = headers[name];
  return typeof value === 'function' ? value() : value;
}

/** Loads the single tool a toolset publishes. */
async function loadOneTool(toolset: ToolboxToolset): Promise<BaseTool> {
  const [tool] = await toolset.getTools();
  return tool;
}

describe('ToolboxToolset auth token getters', () => {
  beforeEach(() => {
    sdk.state.toolAuth = {book_hotel: {requiredAuthzTokens: ['my-auth']}};
  });

  it('passes the live tool context to the getter', async () => {
    const seen: Context[] = [];
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      authTokenGetters: {
        'my-auth': (toolContext) => {
          seen.push(toolContext);
          return String(toolContext.state.get('idToken'));
        },
      },
    });
    const context = credentialToolContext({
      sessionState: {idToken: 'from-state'},
    });

    const tool = await loadOneTool(toolset);
    await tool.runAsync({args: {city: 'Basel'}, toolContext: context});

    expect(seen).toEqual([context]);
    expect(sdk.state.invocationTokens).toEqual([
      {'my-auth_token': 'from-state'},
    ]);
  });

  it('still accepts a getter that takes no arguments', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      authTokenGetters: {'my-auth': () => 'static-token'},
    });

    const tool = await loadOneTool(toolset);
    await tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()});

    expect(sdk.state.invocationTokens).toEqual([
      {'my-auth_token': 'static-token'},
    ]);
  });

  it('awaits an asynchronous getter', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      authTokenGetters: {'my-auth': async () => 'awaited-token'},
    });

    const tool = await loadOneTool(toolset);
    await tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()});

    expect(sdk.state.invocationTokens).toEqual([
      {'my-auth_token': 'awaited-token'},
    ]);
  });

  it('binds only the services the tool declares', async () => {
    sdk.state.toolAuth = {
      search_hotels: {requiredAuthzTokens: ['my-auth']},
      book_hotel: {requiredAuthnParams: {userId: ['other-auth']}},
    };
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      authTokenGetters: {
        'my-auth': () => 'first-token',
        'other-auth': () => 'second-token',
      },
    });

    const tools = await toolset.getTools();
    for (const tool of tools) {
      await tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()});
    }

    // A getter the tool does not declare is dropped; passing it would make
    // the SDK reject the binding.
    expect(sdk.state.invocationTokens).toEqual([
      {'my-auth_token': 'first-token'},
      {'other-auth_token': 'second-token'},
    ]);
  });

  it('gives two concurrent invocations their own token', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      authTokenGetters: {
        'my-auth': (toolContext) => String(toolContext.state.get('idToken')),
      },
    });

    const tool = await loadOneTool(toolset);
    await Promise.all([
      tool.runAsync({
        args: {city: 'Basel'},
        toolContext: credentialToolContext({sessionState: {idToken: 'alice'}}),
      }),
      tool.runAsync({
        args: {city: 'Bern'},
        toolContext: credentialToolContext({sessionState: {idToken: 'bob'}}),
      }),
    ]);

    expect(sdk.state.invocationTokens).toEqual(
      expect.arrayContaining([
        {'my-auth_token': 'alice'},
        {'my-auth_token': 'bob'},
      ]),
    );
  });

  it('runs a tool that needs no auth without binding anything', async () => {
    sdk.state.toolAuth = {search_hotels: {requiredAuthzTokens: ['my-auth']}};
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      authTokenGetters: {'my-auth': () => 'first-token'},
    });

    const [, bookHotel] = await toolset.getTools();
    const result = await bookHotel.runAsync({
      args: {city: 'Basel'},
      toolContext: toolContext(),
    });

    expect(result).toBe('book_hotel:{"city":"Basel"}');
    expect(sdk.state.invocationTokens).toEqual([{}]);
  });

  it('propagates an error a getter throws', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      authTokenGetters: {
        'my-auth': () => {
          throw new Error('the token store is down');
        },
      },
    });

    const tool = await loadOneTool(toolset);

    await expect(
      tool.runAsync({args: {city: 'Basel'}, toolContext: toolContext()}),
    ).rejects.toThrow('the token store is down');
  });
});

describe('ToolboxToolset unused auth token getters', () => {
  it('names the toolset when no loaded tool needs the getter', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      authTokenGetters: {'my-auth': () => 'token'},
    });

    await expect(toolset.getTools()).rejects.toThrow(
      "Validation failed for toolset 'hotel-tools': unused auth tokens " +
        'could not be applied to any tool: my-auth.',
    );
  });

  it('names the list of tools when only toolNames is given', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      authTokenGetters: {'my-auth': () => 'token'},
    });

    await expect(toolset.getTools()).rejects.toThrow(
      "Validation failed for list of tools 'book_hotel': unused auth tokens " +
        'could not be applied to any tool: my-auth.',
    );
  });

  it('names the default toolset when neither name is given', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      authTokenGetters: {'b-auth': () => 'token', 'a-auth': () => 'token'},
    });

    await expect(toolset.getTools()).rejects.toThrow(
      "Validation failed for list of tools 'default': unused auth tokens " +
        'could not be applied to any tool: a-auth, b-auth.',
    );
  });

  it('accepts a getter that only the other load call needs', async () => {
    sdk.state.toolAuth = {cancel_booking: {requiredAuthzTokens: ['my-auth']}};
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
      toolNames: ['cancel_booking'],
      authTokenGetters: {'my-auth': () => 'token'},
    });

    const tools = await toolset.getTools();

    expect(tools.map((tool) => tool.name)).toEqual([
      'search_hotels',
      'book_hotel',
      'cancel_booking',
    ]);
  });

  it('runs no validation when no getters are configured', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolsetName: 'hotel-tools',
    });

    await expect(toolset.getTools()).resolves.toHaveLength(2);
  });
});

describe('ToolboxToolset credentials', () => {
  it('sends a manual token in the Authorization header', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      credentials: ToolboxCredentialStrategy.manualToken('tok'),
    });

    await toolset.getTools();

    expect(await clientHeader('Authorization')).toBe('Bearer tok');
  });

  it('sends an api key in its header', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      credentials: ToolboxCredentialStrategy.apiKey('key', 'X-Custom'),
    });

    await toolset.getTools();

    expect(await clientHeader('X-Custom')).toBe('key');
  });

  it('sends the access token of a manual credentials source', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      credentials: ToolboxCredentialStrategy.manualCredentials({
        getAccessToken: async () => ({token: 'from-source'}),
      }),
    });

    await toolset.getTools();

    expect(await clientHeader('Authorization')).toBe('Bearer from-source');
  });

  it('sends a workload identity token through a per-request getter', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      credentials: ToolboxCredentialStrategy.workloadIdentity('aud'),
    });

    await toolset.getTools();

    const headers = sdk.state.clientCalls[0].headers as Record<string, unknown>;
    expect(typeof headers['Authorization']).toBe('function');
  });

  it('adds no header for a toolbox identity and keeps additionalHeaders', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      additionalHeaders: {'X-Tenant': 'acme'},
      credentials: ToolboxCredentialStrategy.toolboxIdentity(),
    });

    await toolset.getTools();

    expect(sdk.state.clientCalls[0].headers).toEqual({'X-Tenant': 'acme'});
  });

  it('lets the credential win a header name collision', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      additionalHeaders: {Authorization: 'Bearer from-headers'},
      credentials: ToolboxCredentialStrategy.manualToken('from-credential'),
    });

    await toolset.getTools();

    expect(await clientHeader('Authorization')).toBe('Bearer from-credential');
  });

  it('validates the credential on the first getTools, not in the constructor', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      credentials: {type: ToolboxCredentialStrategy.manualToken('x').type},
    });

    await expect(toolset.getTools()).rejects.toThrow(
      'token is required for MANUAL_TOKEN',
    );
  });
});

describe('ToolboxToolset USER_IDENTITY', () => {
  beforeEach(() => {
    sdk.state.toolAuth = {book_hotel: {requiredAuthzTokens: ['my-auth']}};
  });

  it('asks for consent and does not invoke the tool', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: USER_CREDENTIALS,
    });
    const context = credentialToolContext();

    const tool = await loadOneTool(toolset);
    const result = await tool.runAsync({
      args: {city: 'Basel'},
      toolContext: context,
    });

    expect(result).toEqual({
      error:
        'OAuth2 Credentials required for book_hotel. A consent link has ' +
        'been generated for the user. Do NOT attempt to run this tool ' +
        'again until the user confirms they have logged in.',
    });
    expect(Object.keys(context.eventActions.requestedAuthConfigs)).toEqual([
      'call-1',
    ]);
    expect(sdk.state.invocations).toEqual([]);
  });

  it('sends the stored token as the client header and the service token', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = credentialToolContext({credentialService});
    await credentialService.saveCredential(
      {
        authScheme: {type: 'oauth2', flows: {}},
        exchangedAuthCredential: consented({accessToken: 'user-access'}),
        credentialKey: USER_IDENTITY_KEY,
      },
      context,
    );
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: USER_CREDENTIALS,
    });

    const tool = await loadOneTool(toolset);
    await tool.runAsync({args: {city: 'Basel'}, toolContext: context});

    expect(sdk.state.invocationTokens).toEqual([
      {'my-auth_token': 'user-access'},
    ]);
    expect(sdk.state.invocations).toEqual([{city: 'Basel'}]);
  });

  it('sends the user access token as the client header for the invocation', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = credentialToolContext({credentialService});
    await credentialService.saveCredential(
      {
        authScheme: {type: 'oauth2', flows: {}},
        exchangedAuthCredential: consented({
          accessToken: 'user-access',
          idToken: 'user-id',
        }),
        credentialKey: USER_IDENTITY_KEY,
      },
      context,
    );
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: USER_CREDENTIALS,
    });

    const tool = await loadOneTool(toolset);
    await tool.runAsync({args: {city: 'Basel'}, toolContext: context});

    // The header getter is resolved inside the invocation, so it reads the
    // token of the user this invocation belongs to.
    expect(sdk.state.invocationHeaders).toEqual([
      {Authorization: 'Bearer user-access'},
    ]);
  });

  it('sends an empty user header outside any invocation', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: USER_CREDENTIALS,
    });

    await toolset.getTools();

    expect(await clientHeader('Authorization')).toBe('');
  });

  it('prefers the id token over the access token for the service', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = credentialToolContext({credentialService});
    await credentialService.saveCredential(
      {
        authScheme: {type: 'oauth2', flows: {}},
        exchangedAuthCredential: consented({
          accessToken: 'user-access',
          idToken: 'user-id',
        }),
        credentialKey: USER_IDENTITY_KEY,
      },
      context,
    );
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: USER_CREDENTIALS,
    });

    const tool = await loadOneTool(toolset);
    await tool.runAsync({args: {city: 'Basel'}, toolContext: context});

    expect(sdk.state.invocationTokens).toEqual([{'my-auth_token': 'user-id'}]);
  });

  it('writes a credential found in the session back to the service', async () => {
    const credentialService = new InMemoryCredentialService();
    const context = credentialToolContext({
      credentialService,
      sessionState: {
        [`temp:${USER_IDENTITY_KEY}`]: consented({accessToken: 'from-session'}),
      },
    });
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: USER_CREDENTIALS,
    });

    const tool = await loadOneTool(toolset);
    await tool.runAsync({args: {city: 'Basel'}, toolContext: context});

    const stored = await credentialService.loadCredential(
      {
        authScheme: {type: 'oauth2', flows: {}},
        credentialKey: USER_IDENTITY_KEY,
      },
      context,
    );
    expect(stored?.oauth2?.accessToken).toBe('from-session');
    expect(sdk.state.invocationTokens).toEqual([
      {'my-auth_token': 'from-session'},
    ]);
  });

  it('runs the tool even when saving the credential fails', async () => {
    const credentialService = new InMemoryCredentialService();
    vi.spyOn(credentialService, 'saveCredential').mockRejectedValue(
      new Error('the credential store is full'),
    );
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => {});
    const context = credentialToolContext({
      credentialService,
      sessionState: {
        [`temp:${USER_IDENTITY_KEY}`]: consented({accessToken: 'from-session'}),
      },
    });
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: USER_CREDENTIALS,
    });

    const tool = await loadOneTool(toolset);
    const result = await tool.runAsync({
      args: {city: 'Basel'},
      toolContext: context,
    });

    expect(result).toBe('book_hotel:{"city":"Basel"}');
    expect(debug).toHaveBeenCalledWith(
      expect.stringContaining('the credential store is full'),
    );
    debug.mockRestore();
  });

  it('runs a tool that needs no auth without asking for consent', async () => {
    sdk.state.toolAuth = {};
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: USER_CREDENTIALS,
    });
    const context = credentialToolContext();

    const tool = await loadOneTool(toolset);
    const result = await tool.runAsync({
      args: {city: 'Basel'},
      toolContext: context,
    });

    expect(result).toBe('book_hotel:{"city":"Basel"}');
    expect(context.eventActions.requestedAuthConfigs).toEqual({});
  });

  it('rejects a user identity with no client id on a tool that needs auth', async () => {
    const toolset = new ToolboxToolset(SERVER_URL, {
      toolNames: ['book_hotel'],
      credentials: {type: USER_CREDENTIALS.type, clientSecret: 'secret'},
    });

    const tool = await loadOneTool(toolset);

    await expect(
      tool.runAsync({
        args: {city: 'Basel'},
        toolContext: credentialToolContext(),
      }),
    ).rejects.toThrow('USER_IDENTITY requires clientId and clientSecret');
  });
});

describe('ToolboxToolset clientOptions', () => {
  it('forwards every option to the SDK client constructor', async () => {
    const session = axios.create();
    const toolset = new ToolboxToolset(SERVER_URL, {
      clientOptions: {
        session,
        protocol: '2025-06-18',
        clientName: 'my-agent',
        clientVersion: '9.9.9',
      },
    });

    await toolset.getTools();

    expect(sdk.state.clientCalls).toEqual([
      {
        url: SERVER_URL,
        session,
        headers: {},
        protocol: '2025-06-18',
        clientName: 'my-agent',
        clientVersion: '9.9.9',
      },
    ]);
  });
});
