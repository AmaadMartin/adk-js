/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  CredentialExchangeError,
  Event,
  InvocationContext,
  LlmAgent,
  OAuth2Auth,
  PluginManager,
  createEvent,
  createSession,
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

const FROZEN_NONCE = 'adk-issued-nonce';
const TOKEN_URL = 'https://oauth2.example.com/token';
const REDIRECT_URI = 'https://app.example.com/callback';
const ISSUED_TOKEN = 'issued-token';

const OAUTH2_SCHEME: AuthScheme = {
  type: 'oauth2',
  flows: {
    authorizationCode: {
      authorizationUrl: 'https://auth.example.com/authorize',
      tokenUrl: TOKEN_URL,
      scopes: {},
    },
  },
};

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  in: 'header',
  name: 'X-API-Key',
};

/** Every OAuth2 field the tool configured or ADK minted. */
const TOOL_OWNED_OAUTH2: OAuth2Auth = {
  clientId: 'adk-client',
  clientSecret: 'adk-secret',
  redirectUri: REDIRECT_URI,
  codeVerifier: 'adk-verifier',
  state: FROZEN_NONCE,
  authUri: `https://auth.example.com/authorize?state=${FROZEN_NONCE}`,
  nonce: 'adk-nonce',
  audience: 'adk-audience',
  tokenEndpointAuthMethod: 'client_secret_post',
};

/** The same fields as {@link TOOL_OWNED_OAUTH2}, under attacker control. */
const ATTACKER_OWNED_OAUTH2: OAuth2Auth = {
  clientId: 'attacker-client',
  clientSecret: 'attacker-secret',
  redirectUri: 'https://attacker.example.com/callback',
  codeVerifier: 'attacker-verifier',
  state: 'attacker-state',
  authUri: 'https://attacker.example.com/authorize',
  nonce: 'attacker-nonce',
  audience: 'attacker-audience',
  tokenEndpointAuthMethod: 'none',
};

const FROZEN_OAUTH2_CONFIG: AuthConfig = {
  credentialKey: 'testKey',
  authScheme: OAUTH2_SCHEME,
  rawAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: {
      clientId: 'adk-client',
      clientSecret: 'adk-secret',
      redirectUri: REDIRECT_URI,
      codeVerifier: 'adk-verifier',
    },
  },
  exchangedAuthCredential: {
    authType: AuthCredentialTypes.OAUTH2,
    oauth2: TOOL_OWNED_OAUTH2,
  },
};

const FROZEN_API_KEY_CONFIG: AuthConfig = {
  credentialKey: 'testKey',
  authScheme: API_KEY_SCHEME,
};

const RESUME_API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'user-value',
};

function oauth2Credential(oauth2: OAuth2Auth): AuthCredential {
  return {authType: AuthCredentialTypes.OAUTH2, oauth2};
}

function toolCallEvent(): Event {
  return createEvent({
    author: 'agent',
    content: {
      role: 'model',
      parts: [{functionCall: {id: 'toolFc1', name: 'someTool', args: {}}}],
    },
  });
}

function credentialRequestEvent(authConfig: AuthConfig): Event {
  return createEvent({
    author: 'agent',
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            id: 'fc1',
            name: REQUEST_EUC_FUNCTION_CALL_NAME,
            args: {authConfig, functionCallId: 'toolFc1'},
          },
        },
      ],
    },
  });
}

function resumeEvent(response: Record<string, unknown>): Event {
  return createEvent({
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id: 'fc1',
            name: REQUEST_EUC_FUNCTION_CALL_NAME,
            response,
          },
        },
      ],
    },
  });
}

function createContext(
  frozenAuthConfig: AuthConfig,
  response: Record<string, unknown>,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation',
    agent: new LlmAgent({name: 'test_agent', model: 'gemini-2.5-flash'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user',
      events: [
        toolCallEvent(),
        credentialRequestEvent(frozenAuthConfig),
        resumeEvent(response),
      ],
    }),
    pluginManager: new PluginManager([]),
  });
}

async function runPreprocessor(context: InvocationContext): Promise<Event[]> {
  const yielded: Event[] = [];
  for await (const event of AUTH_PREPROCESSOR.runAsync(context)) {
    yielded.push(event);
  }
  return yielded;
}

function tokenRequestBody(
  fetchSpy: MockInstance<typeof globalThis.fetch>,
): URLSearchParams {
  expect(fetchSpy).toHaveBeenCalledTimes(1);
  const [url, init] = fetchSpy.mock.calls[0];
  expect(url).toBe(TOKEN_URL);
  const body = init?.body;
  if (typeof body !== 'string') {
    expect.fail('the token request must carry a form-encoded string body');
  }
  return new URLSearchParams(body);
}

describe('AuthPreprocessor OAuth2 resume binding', () => {
  let fetchSpy: MockInstance<typeof globalThis.fetch>;

  beforeEach(() => {
    vi.mocked(handleFunctionCallsAsync).mockResolvedValue(
      createEvent({id: 'resumedToolEvent', author: 'agent'}),
    );
    fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(
        async () =>
          new Response(
            JSON.stringify({access_token: ISSUED_TOKEN, expires_in: 3600}),
            {status: 200, headers: {'content-type': 'application/json'}},
          ),
      );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a resume whose returned state is not the issued nonce', async () => {
    const context = createContext(FROZEN_OAUTH2_CONFIG, {
      exchangedAuthCredential: oauth2Credential({
        ...ATTACKER_OWNED_OAUTH2,
        authResponseUri: `${REDIRECT_URI}?code=attacker-code&state=attacker-state`,
      }),
    });

    await expect(runPreprocessor(context)).rejects.toThrow(
      'State mismatch detected',
    );
    expect(context.session.state['temp:testKey']).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('posts the frozen client credentials, not the resumed ones', async () => {
    const context = createContext(FROZEN_OAUTH2_CONFIG, {
      exchangedAuthCredential: oauth2Credential({
        ...ATTACKER_OWNED_OAUTH2,
        state: FROZEN_NONCE,
        authResponseUri: `${REDIRECT_URI}?code=good-code&state=${FROZEN_NONCE}`,
      }),
    });

    await runPreprocessor(context);

    const body = tokenRequestBody(fetchSpy);
    expect(body.get('client_id')).toBe('adk-client');
    expect(body.get('client_secret')).toBe('adk-secret');
    expect(body.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(body.get('code_verifier')).toBe('adk-verifier');
    expect(body.get('code')).toBe('good-code');
  });

  it('exchanges a resume that returns the issued nonce', async () => {
    const context = createContext(FROZEN_OAUTH2_CONFIG, {
      exchangedAuthCredential: oauth2Credential({
        authResponseUri: `${REDIRECT_URI}?code=good-code&state=${FROZEN_NONCE}`,
      }),
    });

    const yielded = await runPreprocessor(context);

    expect(yielded.map((event) => event.id)).toEqual(['resumedToolEvent']);
    expect(context.session.state['temp:testKey']).toMatchObject({
      oauth2: {accessToken: ISSUED_TOKEN, state: FROZEN_NONCE},
    });
  });

  it('exchanges a resume that carries only an authorization code', async () => {
    const context = createContext(FROZEN_OAUTH2_CONFIG, {
      exchangedAuthCredential: oauth2Credential({authCode: 'resume-code'}),
    });

    await runPreprocessor(context);

    const body = tokenRequestBody(fetchSpy);
    expect(body.get('code')).toBe('resume-code');
    expect(body.get('client_secret')).toBe('adk-secret');
  });

  it('stores the tokens of a client that ran the exchange itself', async () => {
    const context = createContext(FROZEN_OAUTH2_CONFIG, {
      exchangedAuthCredential: oauth2Credential({
        accessToken: 'client-token',
        refreshToken: 'client-refresh',
        expiresAt: 1780000000000,
      }),
    });

    await runPreprocessor(context);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(context.session.state['temp:testKey']).toMatchObject({
      oauth2: {
        accessToken: 'client-token',
        refreshToken: 'client-refresh',
        expiresAt: 1780000000000,
        clientSecret: 'adk-secret',
      },
    });
  });

  it('rejects a resume that carries no credential at all', async () => {
    const context = createContext(FROZEN_OAUTH2_CONFIG, {});

    await expect(runPreprocessor(context)).rejects.toThrow(
      CredentialExchangeError,
    );
    expect(context.session.state['temp:testKey']).toBeUndefined();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('stores a non-oauth2 resume credential unchanged', async () => {
    const context = createContext(FROZEN_API_KEY_CONFIG, {
      exchangedAuthCredential: RESUME_API_KEY_CREDENTIAL,
    });

    await runPreprocessor(context);

    expect(context.session.state['temp:testKey']).toEqual(
      RESUME_API_KEY_CREDENTIAL,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
