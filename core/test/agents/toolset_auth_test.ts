/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  BaseCredentialService,
  BaseTool,
  BaseToolset,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  LoopAgent,
  PluginManager,
  ReadonlyContext,
  Session,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';

import {
  resolveToolsetAuth,
  TOOLSET_AUTH_PREPROCESSOR,
} from '../../src/agents/toolset_auth.js';
import {logger} from '../../src/utils/logger.js';

const TOOLSET_AUTH_PREFIX = '_adk_toolset_auth_';

class MockTool extends BaseTool {
  constructor(name: string) {
    super({name, description: 'Mock tool'});
  }

  async runAsync(): Promise<unknown> {
    return 'mock';
  }
}

/**
 * A tool that declares an auth config but is not a toolset. Toolset auth must
 * ignore it, so the resolver has to filter on `isBaseToolset` rather than on
 * the presence of the method.
 */
class AuthDeclaringTool extends MockTool {
  getAuthConfig(): AuthConfig {
    return createOAuth2AuthConfig('tool_key');
  }
}

class MockToolset extends BaseToolset {
  constructor(
    private readonly authConfig?: AuthConfig,
    private readonly tools: BaseTool[] = [],
  ) {
    super([]);
  }

  override getAuthConfig(): AuthConfig | undefined {
    return this.authConfig;
  }

  async getTools(_context?: ReadonlyContext): Promise<BaseTool[]> {
    return this.tools;
  }

  async close(): Promise<void> {}
}

/** A credential service whose store is unreachable. */
class ThrowingCredentialService implements BaseCredentialService {
  async loadCredential(): Promise<AuthCredential | undefined> {
    throw new Error('credential store unavailable');
  }

  async saveCredential(): Promise<void> {}
}

function createOAuth2AuthConfig(credentialKey = 'test_key'): AuthConfig {
  return {
    credentialKey,
    authScheme: {
      type: 'oauth2',
      flows: {
        authorizationCode: {
          authorizationUrl: 'https://example.com/auth',
          tokenUrl: 'https://example.com/token',
          scopes: {'read': 'Read access'},
        },
      },
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'test_client_id',
        clientSecret: 'test_client_secret',
      },
    },
  };
}

function createCredential(accessToken: string): AuthCredential {
  return {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {accessToken},
  };
}

function makeSession(state: Record<string, unknown> = {}): Session {
  return createSession({
    id: 'test-session-id',
    appName: 'test-app',
    userId: 'test-user',
    state,
  });
}

function createInvocationContext(options?: {
  state?: Record<string, unknown>;
  credentialService?: BaseCredentialService;
}): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation-id',
    agent: new LlmAgent({name: 'test_agent', model: 'test_model'}),
    session: makeSession(options?.state),
    pluginManager: new PluginManager(),
    credentialService: options?.credentialService,
  });
}

async function collect(
  generator: AsyncGenerator<Event, void, void>,
): Promise<Event[]> {
  const events: Event[] = [];
  for await (const event of generator) {
    events.push(event);
  }
  return events;
}

function functionCallIds(event: Event): unknown[] {
  return event.content!.parts!.map(
    (part) => part.functionCall!.args!['function_call_id'],
  );
}

describe('resolveToolsetAuth', () => {
  let invocationContext: InvocationContext;

  beforeEach(() => {
    invocationContext = createInvocationContext();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('yields nothing when the agent declares no tools', async () => {
    const events = await collect(resolveToolsetAuth(invocationContext, []));

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
    expect(invocationContext.credentialByKey).toEqual({});
  });

  it('skips a toolset that declares no auth config', async () => {
    const toolset = new MockToolset(undefined, [new MockTool('tool1')]);

    const events = await collect(
      resolveToolsetAuth(invocationContext, [toolset]),
    );

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
    expect(invocationContext.credentialByKey).toEqual({});
  });

  it('skips a tool that declares an auth config but is not a toolset', async () => {
    const tool = new AuthDeclaringTool('tool1');

    const events = await collect(resolveToolsetAuth(invocationContext, [tool]));

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
    expect(invocationContext.credentialByKey).toEqual({});
  });

  it('parks a credential the credential service already holds', async () => {
    const credential = createCredential('stored_token');
    const credentialService: BaseCredentialService = {
      loadCredential: vi.fn().mockResolvedValue(credential),
      saveCredential: vi.fn(),
    };
    invocationContext = createInvocationContext({credentialService});
    const authConfig = createOAuth2AuthConfig();
    const toolset = new MockToolset(authConfig);

    const events = await collect(
      resolveToolsetAuth(invocationContext, [toolset]),
    );

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
    expect(invocationContext.credentialByKey['test_key']).toBe(credential);
    // The toolset's own config must stay untouched: an application shares one
    // toolset instance across users and sessions.
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
    expect(credentialService.saveCredential).not.toHaveBeenCalled();
  });

  it('parks a credential recovered from the client auth response', async () => {
    const credential = createCredential('response_token');
    invocationContext = createInvocationContext({
      state: {'temp:test_key': credential},
    });
    const authConfig = createOAuth2AuthConfig();
    const toolset = new MockToolset(authConfig);

    const events = await collect(
      resolveToolsetAuth(invocationContext, [toolset]),
    );

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
    expect(invocationContext.credentialByKey['test_key']).toEqual(credential);
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('saves a recovered credential through the credential service', async () => {
    const credential = createCredential('response_token');
    const credentialService: BaseCredentialService = {
      loadCredential: vi.fn().mockResolvedValue(undefined),
      saveCredential: vi.fn(),
    };
    invocationContext = createInvocationContext({
      state: {'temp:test_key': credential},
      credentialService,
    });
    const authConfig = createOAuth2AuthConfig();
    const toolset = new MockToolset(authConfig);

    const events = await collect(
      resolveToolsetAuth(invocationContext, [toolset]),
    );

    expect(events).toEqual([]);
    expect(credentialService.saveCredential).toHaveBeenCalledTimes(1);
    const savedConfig = vi.mocked(credentialService.saveCredential).mock
      .calls[0][0];
    expect(savedConfig).not.toBe(authConfig);
    expect(savedConfig.exchangedAuthCredential).toEqual(credential);
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('requests a credential and ends the invocation when none is available', async () => {
    const authConfig = createOAuth2AuthConfig();
    const toolset = new MockToolset(authConfig);

    const events = await collect(
      resolveToolsetAuth(invocationContext, [toolset]),
    );

    expect(events).toHaveLength(1);
    expect(invocationContext.endInvocation).toBe(true);

    const event = events[0];
    expect(event.author).toBe('test_agent');
    expect(event.content!.parts).toHaveLength(1);

    const functionCall = event.content!.parts![0].functionCall!;
    expect(functionCall.name).toBe('adk_request_credential');
    expect(functionCall.args!['function_call_id']).toBe(
      `${TOOLSET_AUTH_PREFIX}test_key`,
    );
    expect(event.longRunningToolIds).toEqual([functionCall.id]);

    // The request carries an authorization URI the client can send the user to.
    const requestedConfig = functionCall.args!['auth_config'] as AuthConfig;
    expect(requestedConfig.exchangedAuthCredential!.oauth2!.authUri).toContain(
      'https://example.com/auth',
    );
    expect(authConfig.exchangedAuthCredential).toBeUndefined();
  });

  it('requests one credential per distinct credential key', async () => {
    const toolsets = [
      new MockToolset(createOAuth2AuthConfig('key_a')),
      new MockToolset(createOAuth2AuthConfig('key_b')),
    ];

    const events = await collect(
      resolveToolsetAuth(invocationContext, toolsets),
    );

    expect(events).toHaveLength(1);
    expect(functionCallIds(events[0])).toEqual([
      `${TOOLSET_AUTH_PREFIX}key_a`,
      `${TOOLSET_AUTH_PREFIX}key_b`,
    ]);
    expect(events[0].longRunningToolIds).toHaveLength(2);
  });

  it('collapses two toolsets that share one credential key into one request', async () => {
    const toolsets = [
      new MockToolset(createOAuth2AuthConfig('shared_key')),
      new MockToolset(createOAuth2AuthConfig('shared_key')),
    ];

    const events = await collect(
      resolveToolsetAuth(invocationContext, toolsets),
    );

    expect(events).toHaveLength(1);
    expect(events[0].content!.parts).toHaveLength(1);
  });

  it('requests only the unresolved toolset and keeps the resolved one', async () => {
    const credential = createCredential('resolved_token');
    invocationContext = createInvocationContext({
      state: {'temp:resolved_key': credential},
    });
    const toolsets = [
      new MockToolset(createOAuth2AuthConfig('resolved_key')),
      new MockToolset(createOAuth2AuthConfig('pending_key')),
    ];

    const events = await collect(
      resolveToolsetAuth(invocationContext, toolsets),
    );

    expect(events).toHaveLength(1);
    expect(functionCallIds(events[0])).toEqual([
      `${TOOLSET_AUTH_PREFIX}pending_key`,
    ]);
    expect(invocationContext.credentialByKey['resolved_key']).toEqual(
      credential,
    );
    expect(invocationContext.endInvocation).toBe(true);
  });

  describe('when credential resolution throws', () => {
    let warn: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      warn = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      invocationContext = createInvocationContext({
        credentialService: new ThrowingCredentialService(),
      });
    });

    it('warns and treats the toolset as unresolved', async () => {
      const toolset = new MockToolset(createOAuth2AuthConfig());

      const events = await collect(
        resolveToolsetAuth(invocationContext, [toolset]),
      );

      expect(warn).toHaveBeenCalledWith(
        'Failed to get auth credential for toolset test_key: credential store unavailable',
      );
      expect(events).toHaveLength(1);
      expect(invocationContext.endInvocation).toBe(true);
    });

    it('keeps resolving the remaining toolsets', async () => {
      const toolsets = [
        new MockToolset(createOAuth2AuthConfig('first_key')),
        new MockToolset(createOAuth2AuthConfig('second_key')),
      ];

      const events = await collect(
        resolveToolsetAuth(invocationContext, toolsets),
      );

      expect(warn).toHaveBeenCalledTimes(2);
      expect(functionCallIds(events[0])).toEqual([
        `${TOOLSET_AUTH_PREFIX}first_key`,
        `${TOOLSET_AUTH_PREFIX}second_key`,
      ]);
    });

    it('reports a thrown non-Error value', async () => {
      const credentialService: BaseCredentialService = {
        loadCredential: vi.fn().mockRejectedValue('store offline'),
        saveCredential: vi.fn(),
      };
      invocationContext = createInvocationContext({credentialService});
      const toolset = new MockToolset(createOAuth2AuthConfig());

      await collect(resolveToolsetAuth(invocationContext, [toolset]));

      expect(warn).toHaveBeenCalledWith(
        'Failed to get auth credential for toolset test_key: store offline',
      );
    });
  });

  it('propagates a malformed OAuth2 config as a programming error', async () => {
    const authConfig = createOAuth2AuthConfig();
    delete authConfig.rawAuthCredential;
    const toolset = new MockToolset(authConfig);

    await expect(
      collect(resolveToolsetAuth(invocationContext, [toolset])),
    ).rejects.toThrow('Auth Scheme oauth2 requires authCredential.');
  });
});

describe('ToolsetAuthPreprocessor', () => {
  it('resolves the auth of the agent it runs for', async () => {
    const invocationContext = createInvocationContext();
    invocationContext.agent = new LlmAgent({
      name: 'test_agent',
      model: 'test_model',
      tools: [new MockToolset(createOAuth2AuthConfig())],
    });

    const events = await collect(
      TOOLSET_AUTH_PREPROCESSOR.runAsync(invocationContext),
    );

    expect(events).toHaveLength(1);
    expect(invocationContext.endInvocation).toBe(true);
  });

  it('does nothing for an agent that is not an LlmAgent', async () => {
    const invocationContext = createInvocationContext();
    invocationContext.agent = new LoopAgent({name: 'loop_agent'});

    const events = await collect(
      TOOLSET_AUTH_PREPROCESSOR.runAsync(invocationContext),
    );

    expect(events).toEqual([]);
    expect(invocationContext.endInvocation).toBe(false);
  });
});
