/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  Event,
  InvocationContext,
  LlmAgent,
  Logger,
  PluginManager,
  createEvent,
  createSession,
  getLogger,
} from '@google/adk';
import {
  MockInstance,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  REQUEST_EUC_FUNCTION_CALL_NAME,
  handleFunctionCallsAsync,
} from '../../src/agents/functions.js';

vi.mock('../../src/agents/functions.js', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/agents/functions.js')>();
  return {...original, handleFunctionCallsAsync: vi.fn()};
});

const REQUESTED_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

const ATTACKER_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://attacker.example.com/auth',
      tokenUrl: 'https://attacker.example.com/token',
      scopes: {},
    },
  },
};

const USER_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'user-value',
};

const ATTACKER_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'attacker-value',
};

function requestCredentialEvent(
  author: string,
  fcId: string,
  args: Record<string, unknown>,
): Event {
  return createEvent({
    author,
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {id: fcId, name: REQUEST_EUC_FUNCTION_CALL_NAME, args},
        },
      ],
    },
  });
}

function toolCallEvent(...toolFcIds: string[]): Event {
  return createEvent({
    author: 'agent',
    content: {
      role: 'model',
      parts: toolFcIds.map((id) => ({
        functionCall: {id, name: 'someTool', args: {}},
      })),
    },
  });
}

function resumeEvent(
  responses: Array<{fcId: string; response?: Record<string, unknown>}>,
): Event {
  return createEvent({
    author: 'user',
    content: {
      role: 'user',
      parts: responses.map(({fcId, response}) => ({
        functionResponse: {
          id: fcId,
          name: REQUEST_EUC_FUNCTION_CALL_NAME,
          response,
        },
      })),
    },
  });
}

function createContext(events: Event[]): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events,
    }),
    pluginManager: new PluginManager([]),
  });
}

async function collectEvents(context: InvocationContext): Promise<Event[]> {
  const yielded: Event[] = [];
  for await (const event of AUTH_PREPROCESSOR.runAsync(context)) {
    yielded.push(event);
  }
  return yielded;
}

describe('AuthPreprocessor credential binding', () => {
  let fetchSpy: MockInstance<typeof globalThis.fetch>;
  let warnSpy: MockInstance<Logger['warn']>;

  beforeEach(() => {
    vi.mocked(handleFunctionCallsAsync).mockResolvedValue(
      createEvent({id: 'resumedToolEvent', author: 'agent'}),
    );
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new Error('no network in unit tests'));
    warnSpy = vi.spyOn(getLogger(), 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a resume whose authScheme differs from the requested one', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: ATTACKER_SCHEME,
            exchangedAuthCredential: ATTACKER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toBeUndefined();
    expect(yielded).toHaveLength(0);
    expect(handleFunctionCallsAsync).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('fc1'));
    expect(warnSpy).not.toHaveBeenCalledWith(
      expect.stringContaining('attacker-value'),
    );
  });

  it('rejects a resume that adds a field to the requested authScheme', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: {...REQUESTED_SCHEME, description: 'x'},
            exchangedAuthCredential: ATTACKER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toBeUndefined();
    expect(yielded).toHaveLength(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a resume whose authScheme is not an object', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: 'apiKey',
            exchangedAuthCredential: ATTACKER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toBeUndefined();
    expect(yielded).toHaveLength(0);
  });

  it('rejects a resume authScheme when the request froze none', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey'},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: REQUESTED_SCHEME,
            exchangedAuthCredential: ATTACKER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toBeUndefined();
    expect(yielded).toHaveLength(0);
  });

  it('stores the credential when the resume echoes the requested authScheme', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: {...REQUESTED_SCHEME},
            exchangedAuthCredential: USER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toEqual(USER_CREDENTIAL);
    expect(yielded).toHaveLength(1);
  });

  it('stores the credential when the resume omits the authScheme', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {fcId: 'fc1', response: {exchangedAuthCredential: USER_CREDENTIAL}},
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toEqual(USER_CREDENTIAL);
    expect(yielded).toHaveLength(1);
  });

  it('stores the credential when the resume nulls the authScheme', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: null,
            exchangedAuthCredential: USER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toEqual(USER_CREDENTIAL);
    expect(yielded).toHaveLength(1);
  });

  it('stores the credential when the resume scheme drops a field to undefined', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: {...REQUESTED_SCHEME, name: undefined},
            exchangedAuthCredential: USER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toEqual(USER_CREDENTIAL);
    expect(yielded).toHaveLength(1);
  });

  it('ignores a credentialKey supplied by the resume', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            credentialKey: 'attackerKey',
            exchangedAuthCredential: USER_CREDENTIAL,
          },
        },
      ]),
    ]);

    await collectEvents(context);

    expect(context.session.state['temp:testKey']).toEqual(USER_CREDENTIAL);
    expect(context.session.state['temp:attackerKey']).toBeUndefined();
  });

  it('ignores a resume for a function call id that was never requested', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            credentialKey: 'default_openapi_key',
            authScheme: REQUESTED_SCHEME,
            exchangedAuthCredential: ATTACKER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(
      Object.keys(context.session.state).filter((key) =>
        key.startsWith('temp:'),
      ),
    ).toEqual([]);
    expect(yielded).toHaveLength(0);
  });

  it('ignores a credential request authored by the user', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('user', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: REQUESTED_SCHEME,
            exchangedAuthCredential: ATTACKER_CREDENTIAL,
          },
        },
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toBeUndefined();
    expect(yielded).toHaveLength(0);
    expect(handleFunctionCallsAsync).not.toHaveBeenCalled();
  });

  it('stores nothing and does not throw when the resume carries no response', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      resumeEvent([{fcId: 'fc1'}]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toBeUndefined();
    expect(yielded).toHaveLength(1);
  });

  it('resumes nothing when the request names no tool call', async () => {
    const context = createContext([
      toolCallEvent('toolFc1'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'testKey', authScheme: REQUESTED_SCHEME},
      }),
      resumeEvent([
        {fcId: 'fc1', response: {exchangedAuthCredential: USER_CREDENTIAL}},
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:testKey']).toEqual(USER_CREDENTIAL);
    expect(yielded).toHaveLength(0);
    expect(handleFunctionCallsAsync).not.toHaveBeenCalled();
  });

  it('stores a toolset credential without resuming a tool', async () => {
    const context = createContext([
      toolCallEvent('_adk_toolset_auth_someToolset'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'toolsetKey', authScheme: REQUESTED_SCHEME},
        functionCallId: '_adk_toolset_auth_someToolset',
      }),
      resumeEvent([
        {fcId: 'fc1', response: {exchangedAuthCredential: USER_CREDENTIAL}},
      ]),
    ]);

    const yielded = await collectEvents(context);

    expect(context.session.state['temp:toolsetKey']).toEqual(USER_CREDENTIAL);
    expect(yielded).toHaveLength(0);
    expect(handleFunctionCallsAsync).not.toHaveBeenCalled();
  });

  it('rejects only the tampered id when one resume turn answers two requests', async () => {
    const context = createContext([
      toolCallEvent('toolFc1', 'toolFc2'),
      requestCredentialEvent('agent', 'fc1', {
        authConfig: {credentialKey: 'key1', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc1',
      }),
      requestCredentialEvent('agent', 'fc2', {
        authConfig: {credentialKey: 'key2', authScheme: REQUESTED_SCHEME},
        functionCallId: 'toolFc2',
      }),
      resumeEvent([
        {
          fcId: 'fc1',
          response: {
            authScheme: ATTACKER_SCHEME,
            exchangedAuthCredential: ATTACKER_CREDENTIAL,
          },
        },
        {fcId: 'fc2', response: {exchangedAuthCredential: USER_CREDENTIAL}},
      ]),
    ]);

    await collectEvents(context);

    expect(context.session.state['temp:key1']).toBeUndefined();
    expect(context.session.state['temp:key2']).toEqual(USER_CREDENTIAL);
    expect(handleFunctionCallsAsync).toHaveBeenCalledTimes(1);
    expect(
      vi.mocked(handleFunctionCallsAsync).mock.calls[0][0].filters,
    ).toEqual(new Set(['toolFc2']));
  });
});
