/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AUTH_PREPROCESSOR,
  AuthCredentialTypes,
  createEvent,
  createSession,
  Event,
  InvocationContext,
  LlmAgent,
  PluginManager,
  ReadonlyContext,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

const CREDENTIAL_KEY = 'my-credential-key';
const API_KEY_SCHEME = {type: 'apiKey', in: 'header', name: 'X-API-Key'};
const SUPPLIED_CREDENTIAL = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'test-api-key',
};

function requestEvent(author: string): Event {
  return createEvent({
    invocationId: 'test-invocation-id',
    author,
    content: {
      role: 'model',
      parts: [
        {
          functionCall: {
            name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
            id: 'fc-1',
            args: {
              auth_config: {
                authScheme: API_KEY_SCHEME,
                credentialKey: CREDENTIAL_KEY,
              },
            },
          },
        },
      ],
    },
  });
}

function responseEvent(): Event {
  return createEvent({
    invocationId: 'test-invocation-id',
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
            id: 'fc-1',
            response: {exchangedAuthCredential: SUPPLIED_CREDENTIAL},
          },
        },
      ],
    },
  });
}

function makeInvocationContext(events: Event[]): InvocationContext {
  return new InvocationContext({
    invocationId: 'test-invocation-id',
    agent: new LlmAgent({name: 'test-agent', model: 'gemini-2.5-flash'}),
    session: createSession({
      id: 'test-session',
      appName: 'test-app',
      userId: 'test-user-id',
      events,
    }),
    pluginManager: new PluginManager(),
  });
}

async function drain(context: InvocationContext): Promise<void> {
  for await (const _ of AUTH_PREPROCESSOR.runAsync(context)) {
    // The processor emits no event on the paths under test.
  }
}

describe('AuthPreprocessor recording a resolved credential', () => {
  it('records the credential the client returned on the invocation', async () => {
    const context = makeInvocationContext([
      requestEvent('test-agent'),
      responseEvent(),
    ]);

    await drain(context);

    expect(new ReadonlyContext(context).getCredential(CREDENTIAL_KEY)).toEqual(
      SUPPLIED_CREDENTIAL,
    );
  });

  it('records nothing when no request from this agent matches the response', async () => {
    // The request is client-authored, so the preprocessor refuses it: a
    // caller must not seed the credential store under a key of its choosing.
    const context = makeInvocationContext([
      requestEvent('user'),
      responseEvent(),
    ]);

    await drain(context);

    expect(
      new ReadonlyContext(context).getCredential(CREDENTIAL_KEY),
    ).toBeUndefined();
  });

  it('leaves the credential store empty when the invocation has no auth response', async () => {
    const context = makeInvocationContext([
      createEvent({
        invocationId: 'test-invocation-id',
        author: 'user',
        content: {role: 'user', parts: [{text: 'hello'}]},
      }),
    ]);

    await drain(context);

    expect(context.credentialByKey).toEqual({});
  });
});
