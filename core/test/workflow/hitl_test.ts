/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Schema, Type} from '@google/genai';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {z as z3} from 'zod/v3';
import {z as z4} from 'zod/v4';
import {
  AuthCredential,
  AuthCredentialTypes,
} from '../../src/auth/auth_credential.js';
import {AuthScheme} from '../../src/auth/auth_schemes.js';
import {AuthConfig} from '../../src/auth/auth_tool.js';
import type {Event} from '../../src/events/event.js';
import {State} from '../../src/sessions/state.js';
import {
  isRequestInput,
  RequestInput,
} from '../../src/workflow/request_input.js';
import {
  createRequestInputEvent,
  createRequestInputResponse,
  getRequestInputInterruptIds,
  hasAuthCredential,
  hasRequestInputFunctionCall,
  processAuthResume,
  REQUEST_INPUT_FUNCTION_CALL_NAME,
} from '../../src/workflow/utils/hitl_utils.js';

/** Extracts the first function-call args from an event. */
function firstFunctionCall(event: Event) {
  return event.content?.parts?.[0]?.functionCall;
}

describe('RequestInput', () => {
  it('auto-generates an interrupt id when omitted', () => {
    const ri = new RequestInput();
    expect(typeof ri.interruptId).toBe('string');
    expect(ri.interruptId.length).toBeGreaterThan(0);
    expect(ri.payload).toBeUndefined();
    expect(ri.message).toBeUndefined();
    expect(ri.responseSchema).toBeUndefined();
  });

  it('keeps the provided fields', () => {
    const ri = new RequestInput({
      interruptId: 'i1',
      payload: {a: 1},
      message: 'm',
    });
    expect(ri.interruptId).toBe('i1');
    expect(ri.payload).toEqual({a: 1});
    expect(ri.message).toBe('m');
  });
});

describe('isRequestInput', () => {
  it('recognizes a RequestInput instance', () => {
    expect(isRequestInput(new RequestInput())).toBe(true);
  });

  it('rejects look-alikes and non-objects', () => {
    expect(isRequestInput({interruptId: 'x'})).toBe(false);
    expect(isRequestInput(null)).toBe(false);
    expect(isRequestInput('i1')).toBe(false);
  });
});

describe('createRequestInputEvent', () => {
  it('builds an interrupt event with a request_input function call', () => {
    const ri = new RequestInput({
      interruptId: 'i1',
      message: 'pick',
      payload: {x: 1},
    });
    const event = createRequestInputEvent(ri);
    const fc = firstFunctionCall(event);

    expect(fc?.name).toBe(REQUEST_INPUT_FUNCTION_CALL_NAME);
    expect(fc?.id).toBe('i1');
    expect(fc?.args).toMatchObject({
      interruptId: 'i1',
      message: 'pick',
      payload: {x: 1},
      responseSchema: null,
    });
    expect(event.longRunningToolIds).toEqual(['i1']);
    expect(hasRequestInputFunctionCall(event)).toBe(true);
    expect(getRequestInputInterruptIds(event)).toEqual(['i1']);
  });

  it('converts a Zod v4 responseSchema to a JSON schema', () => {
    const ri = new RequestInput({
      responseSchema: z4.object({answer: z4.string()}),
    });
    const args = firstFunctionCall(createRequestInputEvent(ri))?.args as Record<
      string,
      unknown
    >;
    expect(args.responseSchema).toMatchObject({type: 'object'});
  });

  it('converts a Zod v3 responseSchema to a JSON schema', () => {
    const ri = new RequestInput({
      responseSchema: z3.object({answer: z3.string()}),
    });
    const args = firstFunctionCall(createRequestInputEvent(ri))?.args as Record<
      string,
      unknown
    >;
    expect(args.responseSchema).toMatchObject({type: 'object'});
  });

  it('passes a genai Schema responseSchema through as-is', () => {
    const schema: Schema = {
      type: Type.OBJECT,
      properties: {answer: {type: Type.STRING}},
    };
    const ri = new RequestInput({responseSchema: schema});
    const args = firstFunctionCall(createRequestInputEvent(ri))?.args as Record<
      string,
      unknown
    >;
    expect(args.responseSchema).toEqual(schema);
  });
});

describe('createRequestInputResponse', () => {
  it('builds a function-response part for the interrupt', () => {
    const part = createRequestInputResponse('i1', {value: 5});
    expect(part.functionResponse).toEqual({
      id: 'i1',
      name: REQUEST_INPUT_FUNCTION_CALL_NAME,
      response: {value: 5},
    });
  });
});

describe('auth gate', () => {
  const apiKeyConfig = (): AuthConfig => ({
    credentialKey: 'testKey',
    authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
  });

  it('reports no credential for an empty state', () => {
    expect(hasAuthCredential(apiKeyConfig(), new State())).toBe(false);
  });

  it('stores an API-key credential from a plain resume value', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({responseData: 'my-key', authConfig, state});

    expect(hasAuthCredential(authConfig, state)).toBe(true);
    expect(state.get('temp:testKey')).toEqual({
      authType: 'apiKey',
      apiKey: 'my-key',
    });
  });
});

describe('auth gate resume payload binding', () => {
  const webFlowCredential: AuthCredential = {
    authType: AuthCredentialTypes.API_KEY,
    apiKey: 'from-web-flow',
  };

  const frozenApiKeyScheme: AuthScheme = {
    type: 'apiKey',
    name: 'testKey',
    in: 'header',
  };

  const apiKeyConfig = (authScheme: AuthScheme = frozenApiKeyScheme) => ({
    credentialKey: 'testKey',
    authScheme,
    rawAuthCredential: {authType: AuthCredentialTypes.API_KEY},
  });

  const oauth2Config = (tokenUrl: string): AuthConfig => ({
    credentialKey: 'oauthKey',
    authScheme: {
      type: 'oauth2',
      flows: {clientCredentials: {tokenUrl, scopes: {}}},
    },
    rawAuthCredential: {
      authType: AuthCredentialTypes.OAUTH2,
      oauth2: {clientId: 'id', clientSecret: 'secret'},
    },
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('accepts a payload that echoes the requested scheme', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
        credentialKey: 'testKey',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.get('temp:testKey')).toEqual(webFlowCredential);
  });

  it('ignores a credentialKey supplied by the payload', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
        credentialKey: 'attacker',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.has('temp:attacker')).toBe(false);
    expect(state.get('temp:testKey')).toEqual(webFlowCredential);
  });

  it('rejects a payload whose authScheme contradicts the frozen one', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: {type: 'apiKey', name: 'testKey', in: 'query'},
        credentialKey: 'testKey',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.has('temp:testKey')).toBe(false);
  });

  it('rejects a payload that adds a field to the frozen scheme', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: {
          type: 'apiKey',
          name: 'testKey',
          in: 'header',
          description: 'x',
        },
        credentialKey: 'testKey',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.has('temp:testKey')).toBe(false);
  });

  it('rejects a non-object authScheme', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: 'apiKey',
        credentialKey: 'testKey',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.has('temp:testKey')).toBe(false);
  });

  it('accepts a payload whose scheme drops a field the request left undefined', async () => {
    const authConfig = apiKeyConfig({
      type: 'apiKey',
      name: 'testKey',
      in: 'header',
      description: undefined,
    });
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
        credentialKey: 'testKey',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.get('temp:testKey')).toEqual(webFlowCredential);
  });

  it('accepts a payload whose scheme sets a field to undefined', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: {
          type: 'apiKey',
          name: 'testKey',
          in: 'header',
          description: undefined,
        },
        credentialKey: 'testKey',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.get('temp:testKey')).toEqual(webFlowCredential);
  });

  it('accepts a payload that omits the authScheme', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: undefined,
        credentialKey: 'testKey',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.get('temp:testKey')).toEqual(webFlowCredential);
  });

  it('accepts a payload whose authScheme is null', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: null,
        credentialKey: 'testKey',
        exchangedAuthCredential: webFlowCredential,
      },
      authConfig,
      state,
    });

    expect(state.get('temp:testKey')).toEqual(webFlowCredential);
  });

  it('rejects a payload with no exchangedAuthCredential', async () => {
    const authConfig = apiKeyConfig();
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: {type: 'apiKey', name: 'testKey', in: 'header'},
        credentialKey: 'testKey',
      },
      authConfig,
      state,
    });

    expect(state.has('temp:testKey')).toBe(false);
  });

  it('never contacts a token endpoint named by the payload', async () => {
    // A token response the exchanger would accept, so an unbound resume is
    // caught by the assertions below and never reaches the network.
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify({access_token: 'stolen'}), {
        status: 200,
        headers: {'content-type': 'application/json'},
      }),
    );
    const authConfig = oauth2Config('https://legit.example/token');
    const state = new State();

    await processAuthResume({
      responseData: {
        authScheme: {
          type: 'oauth2',
          flows: {
            clientCredentials: {
              tokenUrl: 'https://attacker.invalid/token',
              scopes: {},
            },
          },
        },
        credentialKey: 'oauthKey',
        exchangedAuthCredential: {
          authType: AuthCredentialTypes.OAUTH2,
          oauth2: {clientId: 'id', clientSecret: 'secret'},
        },
      },
      authConfig,
      state,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(state.has('temp:oauthKey')).toBe(false);
  });

  it('still stores a credential from a plain resume object', async () => {
    const authConfig: AuthConfig = {
      credentialKey: 'bearerKey',
      authScheme: {type: 'http', scheme: 'bearer'},
    };
    const state = new State();
    const credential: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {token: 'plain'}},
    };

    await processAuthResume({responseData: credential, authConfig, state});

    expect(state.get('temp:bearerKey')).toEqual(credential);
  });
});
