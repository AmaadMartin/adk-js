/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Regression tests for the binding between an `adk_request_credential` request
 * and the response that answers it.
 *
 * Threat model, as in the HITL confirmation tests: an actor that can write
 * messages into a live session — a malicious A2A peer, a second client on a
 * shared context, anything that reaches `/run` — but that is not the human the
 * credential belongs to and cannot author model turns.
 *
 * The request is raised by the agent and says what is being collected: which
 * scheme, from which authorization server, under which key. The response is
 * written by the client and should carry one thing only — the credential
 * material the user obtained. These tests probe what happens when the response
 * tries to redefine the question instead of answering it.
 *
 * Unlike `auth_preprocessor_test.ts`, the real `AuthHandler` and the real
 * OAuth2 exchanger run here, against a stubbed `fetch`. The assertions are
 * about what lands in session state and where the exchange was sent, because
 * that is what a waiting tool goes on to use.
 */

import {
  AUTH_PREPROCESSOR,
  AuthCredentialTypes,
  Event,
  InvocationContext,
  createEvent,
} from '@google/adk';
import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {REQUEST_CREDENTIAL_FUNCTION_CALL_NAME} from '../../src/agents/functions.js';
import {AuthCredential} from '../../src/auth/auth_credential.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import {bindCredentialResponse} from '../../src/auth/credential_response_binding.js';

// Resuming the waiting tool is a separate concern; stub it so each test is
// about the credential that gets stored. `AuthHandler` is deliberately left
// alone — it is the thing under test here.
vi.mock('../../src/agents/functions.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    handleFunctionCallsAsync: vi
      .fn()
      .mockResolvedValue({id: 'resumedTool', author: 'agent'}),
  };
});

const LLM_AGENT_SYMBOL = Symbol.for('google.adk.llmAgent');

const ISSUER_TOKEN_URL = 'https://issuer.example.com/token';
const ATTACKER_TOKEN_URL = 'https://attacker.example.com/token';
const CREDENTIAL_KEY = 'issuer-credential';

/** The OAuth2 scheme the agent asks against. */
function oauth2Scheme(tokenUrl = ISSUER_TOKEN_URL) {
  return {
    type: 'oauth2',
    flows: {
      authorizationCode: {
        authorizationUrl: 'https://issuer.example.com/auth',
        tokenUrl,
        scopes: {'read': 'read'},
      },
    },
  };
}

/**
 * The request the agent raises, as `AuthHandler.generateAuthRequest` builds it
 * for an authorization-code flow: the scheme, the client identity, and an
 * `authUri` carrying the CSRF `state` the client is expected to echo back.
 */
function pendingOAuthRequest(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    credentialKey: CREDENTIAL_KEY,
    authScheme: oauth2Scheme() as AuthConfig['authScheme'],
    rawAuthCredential: {
      authType: 'oauth2',
      oauth2: {clientId: 'real-client', clientSecret: 'real-secret'},
    } as unknown as AuthCredential,
    exchangedAuthCredential: {
      authType: 'oauth2',
      oauth2: {
        clientId: 'real-client',
        clientSecret: 'real-secret',
        redirectUri: 'https://app.example.com/callback',
        state: 'server-issued-state',
        authUri:
          'https://issuer.example.com/auth?state=server-issued-state&client_id=real-client',
      },
    } as unknown as AuthCredential,
    ...overrides,
  };
}

/**
 * The request an agent raises when no redirect is pending: the client identity
 * the agent registered, and nothing for the client to echo back. Mirrors
 * `requested_oauth2` in adk-python's `test_store_auth_merges_oauth2_fields`.
 */
function unpinnedOAuthRequest(): AuthConfig {
  return {
    credentialKey: CREDENTIAL_KEY,
    authScheme: oauth2Scheme() as AuthConfig['authScheme'],
    exchangedAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        clientId: 'real-client',
        clientSecret: 'real-secret',
        redirectUri: 'https://app.example.com/callback',
        codeVerifier: 'request-verifier',
        tokenEndpointAuthMethod: 'client_secret_post',
      },
    },
  };
}

/** The same request, plus a token the agent is already holding. */
function unpinnedOAuthRequestWithToken(): AuthConfig {
  const request = unpinnedOAuthRequest();
  return {
    ...request,
    exchangedAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {
        ...request.exchangedAuthCredential?.oauth2,
        accessToken: 'agent-token',
      },
    },
  };
}

/**
 * A session in which `request` was raised by the agent and `response` came back
 * from the client, plus the state object the credential will land in.
 */
function sessionAnswering(request: AuthConfig, response: unknown) {
  const state: Record<string, unknown> = {};
  const invocationContext = {
    agent: {
      [LLM_AGENT_SYMBOL]: true,
      name: 'agent',
      canonicalTools: vi.fn().mockResolvedValue([{name: 'securedTool'}]),
      canonicalBeforeToolCallbacks: [],
      canonicalAfterToolCallbacks: [],
    },
    session: {
      state,
      events: [
        createEvent({
          author: 'agent',
          content: {
            parts: [
              {functionCall: {id: 'toolFc1', name: 'securedTool', args: {}}},
            ],
          },
        }),
        createEvent({
          author: 'agent',
          content: {
            parts: [
              {
                functionCall: {
                  id: 'authFc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  args: {authConfig: request, functionCallId: 'toolFc1'},
                },
              },
            ],
          },
        }),
        createEvent({
          author: 'user',
          content: {
            parts: [
              {
                functionResponse: {
                  id: 'authFc1',
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: response as Record<string, unknown>,
                },
              },
            ],
          },
        }),
      ] as Event[],
    },
  } as unknown as InvocationContext;

  return {invocationContext, state};
}

/** Runs the preprocessor to completion, returning any error it raised. */
async function resume(invocationContext: InvocationContext): Promise<unknown> {
  const yielded: Event[] = [];
  try {
    for await (const event of AUTH_PREPROCESSOR.runAsync(invocationContext)) {
      // Drained rather than asserted on: the resumed tool call is stubbed, and
      // these tests are about the credential that reached state before it.
      yielded.push(event);
    }
    return undefined;
  } catch (e) {
    return e;
  }
}

/** The credential the waiting tool will read. */
function storedCredential(state: Record<string, unknown>) {
  return state[`temp:${CREDENTIAL_KEY}`] as AuthCredential | undefined;
}

describe('credential response binding', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({access_token: 'issuer-token', expires_in: 3600}),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The request says "oauth2, from this issuer". The scheme decides whether the
  // credential is exchanged or stored as-is, so a response that gets to restate
  // it decides that too.
  it('ignores an auth scheme supplied by the response', async () => {
    const {invocationContext, state} = sessionAnswering(pendingOAuthRequest(), {
      authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
      exchangedAuthCredential: {authType: 'apiKey', apiKey: 'attacker-key'},
    });

    await resume(invocationContext);

    expect(storedCredential(state)?.apiKey).toBeUndefined();
  });

  // A response carrying a ready-made token short-circuits the exchanger. The
  // agent asked for an authorization code, so a token is not an answer to it —
  // and having no answer at all, the response is refused outright rather than
  // carried as far as the exchanger.
  it('does not store an access token in place of an authorization code', async () => {
    const {invocationContext, state} = sessionAnswering(pendingOAuthRequest(), {
      authScheme: oauth2Scheme(),
      exchangedAuthCredential: {
        authType: 'oauth2',
        oauth2: {accessToken: 'attacker-token'},
      },
    });

    const error = await resume(invocationContext);

    expect(error).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storedCredential(state)).toBeUndefined();
  });

  // The token endpoint lives in the scheme, so a response that restates the
  // scheme picks where the exchange POSTs the client secret.
  it('exchanges against the token endpoint from the request', async () => {
    const {invocationContext} = sessionAnswering(pendingOAuthRequest(), {
      authScheme: oauth2Scheme(ATTACKER_TOKEN_URL),
      exchangedAuthCredential: {
        authType: 'oauth2',
        oauth2: {
          clientId: 'real-client',
          clientSecret: 'real-secret',
          state: 'server-issued-state',
          authResponseUri:
            'https://app.example.com/callback?code=abc&state=server-issued-state',
        },
      },
    });

    await resume(invocationContext);

    const endpoints = fetchMock.mock.calls.map((call) => call[0]);
    expect(endpoints).not.toContain(ATTACKER_TOKEN_URL);
  });

  // The CSRF check compares the state in `authResponseUri` against the state on
  // the credential. Both arriving in the same response makes it a comparison
  // the sender controls on both sides.
  it('checks the returned state against the state the agent issued', async () => {
    const {invocationContext, state} = sessionAnswering(pendingOAuthRequest(), {
      authScheme: oauth2Scheme(),
      exchangedAuthCredential: {
        authType: 'oauth2',
        oauth2: {
          clientId: 'real-client',
          clientSecret: 'real-secret',
          state: 'attacker-state',
          authResponseUri:
            'https://app.example.com/callback?code=stolen&state=attacker-state',
        },
      },
    });

    const error = await resume(invocationContext);

    expect(error).toBeDefined();
    expect(storedCredential(state)).toBeUndefined();
  });

  // `credentialKey` is where the credential is filed, and so which tool picks
  // it up. It was pinned from the request only when the request had one.
  it('refuses a request that names no credential key', async () => {
    const request = pendingOAuthRequest();
    delete (request as Partial<AuthConfig>).credentialKey;
    const {invocationContext, state} = sessionAnswering(request, {
      credentialKey: 'attacker-chosen-key',
      authScheme: {type: 'apiKey', in: 'header', name: 'X-API-Key'},
      exchangedAuthCredential: {authType: 'apiKey', apiKey: 'attacker-key'},
    });

    await resume(invocationContext);

    expect(state['temp:attacker-chosen-key']).toBeUndefined();
  });

  // The legitimate flow has to keep working: the client answers with the
  // redirect it received, and the code in it is exchanged for a real token.
  it('exchanges an authorization code the client answers with', async () => {
    const {invocationContext, state} = sessionAnswering(pendingOAuthRequest(), {
      exchangedAuthCredential: {
        authType: 'oauth2',
        oauth2: {
          authResponseUri:
            'https://app.example.com/callback?code=real-code&state=server-issued-state',
        },
      },
    });

    await resume(invocationContext);

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(ISSUER_TOKEN_URL);
    expect(storedCredential(state)?.oauth2?.accessToken).toBe('issuer-token');
  });

  // An API-key scheme has no exchange: the credential in the response is the
  // whole answer, and pinning must not get in the way of storing it.
  it('stores the credential for a scheme with no exchange', async () => {
    const request: AuthConfig = {
      credentialKey: CREDENTIAL_KEY,
      authScheme: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      } as AuthConfig['authScheme'],
    };
    const {invocationContext, state} = sessionAnswering(request, {
      authScheme: request.authScheme,
      exchangedAuthCredential: {authType: 'apiKey', apiKey: 'user-key'},
    });

    await resume(invocationContext);

    expect(storedCredential(state)?.apiKey).toBe('user-key');
  });

  // With no redirect pending the client answers with a bare code, and only the
  // request knows the client identity the exchange has to authenticate with.
  it('exchanges an unpinned request with the client identity from the request', async () => {
    const {invocationContext, state} = sessionAnswering(
      unpinnedOAuthRequest(),
      {
        exchangedAuthCredential: {
          authType: 'oauth2',
          oauth2: {authCode: 'user-code'},
        },
      },
    );

    const error = await resume(invocationContext);

    expect(error).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe(ISSUER_TOKEN_URL);
    const tokenRequest = new URLSearchParams(
      String(fetchMock.mock.calls[0][1].body),
    );
    expect(tokenRequest.get('client_id')).toBe('real-client');
    expect(tokenRequest.get('client_secret')).toBe('real-secret');
    expect(tokenRequest.get('code')).toBe('user-code');
    expect(storedCredential(state)?.oauth2?.accessToken).toBe('issuer-token');
  });
});

// The cases above drive the binder through the preprocessor, which is how it is
// reached in production. These cover the shapes a client can send that the
// preprocessor path does not exercise on its own.
describe('bindCredentialResponse', () => {
  it('reads a snake_case response', () => {
    const bound = bindCredentialResponse(pendingOAuthRequest(), {
      'exchanged_auth_credential': {
        'oauth2': {
          'auth_response_uri':
            'https://app.example.com/callback?code=snake&state=server-issued-state',
        },
      },
    });

    expect(bound?.exchangedAuthCredential?.oauth2?.authResponseUri).toContain(
      'code=snake',
    );
  });

  it('accepts an authorization code sent on its own', () => {
    const bound = bindCredentialResponse(pendingOAuthRequest(), {
      exchangedAuthCredential: {oauth2: {authCode: 'bare-code'}},
    });

    expect(bound?.exchangedAuthCredential?.oauth2?.authCode).toBe('bare-code');
  });

  // The pinned values are the ones the exchanger authenticates and CSRF-checks
  // with, so a response restating them must not win.
  it('keeps the client identity and state from the request', () => {
    const bound = bindCredentialResponse(pendingOAuthRequest(), {
      exchangedAuthCredential: {
        oauth2: {
          clientId: 'attacker-client',
          clientSecret: 'attacker-secret',
          state: 'attacker-state',
          authCode: 'code',
        },
      },
    });

    expect(bound?.exchangedAuthCredential?.oauth2).toMatchObject({
      clientId: 'real-client',
      clientSecret: 'real-secret',
      state: 'server-issued-state',
    });
  });

  it('refuses an answer field that is not a string', () => {
    expect(
      bindCredentialResponse(pendingOAuthRequest(), {
        exchangedAuthCredential: {oauth2: {authCode: {nested: 'object'}}},
      }),
    ).toBeUndefined();
  });

  it('returns nothing when the response carries no credential', () => {
    expect(
      bindCredentialResponse(pendingOAuthRequest(), {authScheme: 'anything'}),
    ).toBeUndefined();
  });

  it('returns nothing when the credential is not an object', () => {
    expect(
      bindCredentialResponse(unpinnedOAuthRequest(), {
        exchangedAuthCredential: 'nope',
      }),
    ).toBeUndefined();
  });

  // The shape the nit on #775 named: a credential is present, but nothing in it
  // answers the pending authorization-code flow.
  it('refuses a credential that answers nothing', () => {
    expect(
      bindCredentialResponse(pendingOAuthRequest(), {
        exchangedAuthCredential: {
          authType: 'oauth2',
          oauth2: {redirectUri: 'https://app.example.com/callback'},
        },
      }),
    ).toBeUndefined();
  });

  // The other path is unaffected: with no authorization code pending, the
  // supplied credential is the answer and carries no code fields at all.
  it('still accepts a credential when no authorization code is pending', () => {
    const request: AuthConfig = {
      credentialKey: CREDENTIAL_KEY,
      authScheme: {
        type: 'apiKey',
        in: 'header',
        name: 'X-API-Key',
      } as AuthConfig['authScheme'],
    };

    const bound = bindCredentialResponse(request, {
      exchangedAuthCredential: {authType: 'apiKey', apiKey: 'user-key'},
    });

    expect(bound?.exchangedAuthCredential?.apiKey).toBe('user-key');
  });

  // Ported from adk-python's `_merge_credential_oauth2_fields`. The client
  // holds the material the user obtained; the request holds the identity the
  // agent registered, and the exchanger needs both.
  describe('unpinned OAuth2 backfill', () => {
    it('backfills the client identity the response left out', () => {
      const bound = bindCredentialResponse(unpinnedOAuthRequest(), {
        exchangedAuthCredential: {
          authType: 'oauth2',
          oauth2: {accessToken: 'client-token'},
        },
      });

      expect(bound?.exchangedAuthCredential?.oauth2).toStrictEqual({
        accessToken: 'client-token',
        clientId: 'real-client',
        clientSecret: 'real-secret',
        redirectUri: 'https://app.example.com/callback',
        codeVerifier: 'request-verifier',
        tokenEndpointAuthMethod: 'client_secret_post',
      });
    });

    it('keeps a field the response supplied', () => {
      const bound = bindCredentialResponse(unpinnedOAuthRequest(), {
        exchangedAuthCredential: {
          authType: 'oauth2',
          oauth2: {redirectUri: 'https://client.example.com/callback'},
        },
      });

      expect(bound?.exchangedAuthCredential?.oauth2?.redirectUri).toBe(
        'https://client.example.com/callback',
      );
    });

    // Backfilling a field the client sent in snake_case would leave the same
    // value under two keys, and every consumer reads the camelCase one.
    it('treats a snake_case field as supplied', () => {
      const bound = bindCredentialResponse(unpinnedOAuthRequest(), {
        exchangedAuthCredential: {
          authType: 'oauth2',
          oauth2: {'client_id': 'client-supplied'},
        },
      });

      const oauth2 = bound?.exchangedAuthCredential?.oauth2;
      if (!oauth2) {
        expect.fail('expected the response to bind');
      }
      expect(Object.keys(oauth2)).not.toContain('clientId');
    });

    it('adds no key for a field the request left empty', () => {
      const request: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: oauth2Scheme() as AuthConfig['authScheme'],
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'real-client'},
        },
      };

      const bound = bindCredentialResponse(request, {
        exchangedAuthCredential: {authType: 'oauth2', oauth2: {authCode: 'x'}},
      });

      expect(bound?.exchangedAuthCredential?.oauth2).toStrictEqual({
        authCode: 'x',
        clientId: 'real-client',
      });
    });

    it("takes the request's oauth2 when the response carries none", () => {
      const bound = bindCredentialResponse(unpinnedOAuthRequest(), {
        exchangedAuthCredential: {authType: 'oauth2'},
      });

      expect(bound?.exchangedAuthCredential?.oauth2).toStrictEqual(
        unpinnedOAuthRequest().exchangedAuthCredential?.oauth2,
      );
    });

    it("takes the request's oauth2 when the response sends a null one", () => {
      const bound = bindCredentialResponse(unpinnedOAuthRequest(), {
        exchangedAuthCredential: {authType: 'oauth2', oauth2: null},
      });

      expect(bound?.exchangedAuthCredential?.oauth2).toStrictEqual(
        unpinnedOAuthRequest().exchangedAuthCredential?.oauth2,
      );
    });

    // A token from the request is the agent's, not the user's, and the
    // exchanger returns early on any token it finds.
    it('does not backfill a token from the request', () => {
      const bound = bindCredentialResponse(unpinnedOAuthRequestWithToken(), {
        exchangedAuthCredential: {authType: 'oauth2', oauth2: {authCode: 'x'}},
      });

      expect(
        bound?.exchangedAuthCredential?.oauth2?.accessToken,
      ).toBeUndefined();
    });

    // The same rule with nothing to merge into: a response carrying no oauth2
    // gets the listed fields, not the request's whole block.
    it('copies no token when the response carries no oauth2', () => {
      const bound = bindCredentialResponse(unpinnedOAuthRequestWithToken(), {
        exchangedAuthCredential: {authType: 'oauth2'},
      });

      expect(bound?.exchangedAuthCredential?.oauth2).toStrictEqual(
        unpinnedOAuthRequest().exchangedAuthCredential?.oauth2,
      );
    });

    // The request is read back out of an event in session history.
    it('does not mutate the request', () => {
      const request = unpinnedOAuthRequest();
      const requestOAuth2 = request.exchangedAuthCredential?.oauth2;

      const bound = bindCredentialResponse(request, {
        exchangedAuthCredential: {
          authType: 'oauth2',
          oauth2: {authCode: 'x'},
        },
      });

      expect(request.exchangedAuthCredential?.oauth2).toStrictEqual(
        unpinnedOAuthRequest().exchangedAuthCredential?.oauth2,
      );
      expect(bound?.exchangedAuthCredential?.oauth2).not.toBe(requestOAuth2);
    });

    it('leaves a request with no OAuth2 credential alone', () => {
      const request: AuthConfig = {
        credentialKey: CREDENTIAL_KEY,
        authScheme: {
          type: 'apiKey',
          in: 'header',
          name: 'X-API-Key',
        } as AuthConfig['authScheme'],
      };

      const bound = bindCredentialResponse(request, {
        exchangedAuthCredential: {authType: 'apiKey', apiKey: 'user-key'},
      });

      expect(bound?.exchangedAuthCredential).toStrictEqual({
        authType: 'apiKey',
        apiKey: 'user-key',
      });
    });

    it('refuses a response whose oauth2 is not an object', () => {
      expect(
        bindCredentialResponse(unpinnedOAuthRequest(), {
          exchangedAuthCredential: {authType: 'oauth2', oauth2: 'nope'},
        }),
      ).toBeUndefined();
    });
  });
});
