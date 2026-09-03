/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {AgentCard} from '@a2a-js/sdk';
import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  AuthScheme,
  BaseCredentialService,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  Session,
} from '@google/adk';
import {describe, expect, it, vi} from 'vitest';
import {
  buildAuthInterceptors,
  deriveCredentialKey,
  namesItsOwnCredentialKey,
  resolveAuthCredential,
} from '../../src/a2a/a2a_remote_agent_auth.js';
import {InvocationContext} from '../../src/agents/invocation_context.js';
import {PluginManager} from '../../src/plugins/plugin_manager.js';

const API_KEY_SCHEME: AuthScheme = {
  type: 'apiKey',
  name: 'X-Api-Key',
  in: 'header',
};

const API_KEY_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'secret-key',
};

const CARD: AgentCard = {
  name: 'remote',
  description: '',
  protocolVersion: '0.3.0',
  version: '1.0.0',
  url: 'https://remote.example.com/a2a',
  skills: [],
  capabilities: {},
  defaultInputModes: ['text'],
  defaultOutputModes: ['text'],
};

function authConfigFor(credential?: AuthCredential): AuthConfig {
  return {
    authScheme: API_KEY_SCHEME,
    rawAuthCredential: credential,
    credentialKey: 'test-key',
  };
}

function contextWith(
  overrides: Partial<InvocationContext> = {},
): InvocationContext {
  const context = new InvocationContext({
    invocationId: 'inv-1',
    session: {
      id: 'session-1',
      appName: 'app',
      userId: 'user',
      state: {},
      events: [],
      lastUpdateTime: Date.now(),
    } as Session,
    pluginManager: new PluginManager(),
  });
  return Object.assign(context, overrides);
}

describe('deriveCredentialKey', () => {
  it('is stable for the same scheme, credential and remote', () => {
    const first = deriveCredentialKey(
      API_KEY_SCHEME,
      API_KEY_CREDENTIAL,
      'https://remote.example.com/card.json',
    );
    const second = deriveCredentialKey(
      {name: 'X-Api-Key', in: 'header', type: 'apiKey'},
      {apiKey: 'secret-key', authType: AuthCredentialTypes.API_KEY},
      'https://remote.example.com/card.json',
    );

    expect(first).toBe(second);
  });

  it('differs for two different remotes', () => {
    const first = deriveCredentialKey(
      API_KEY_SCHEME,
      API_KEY_CREDENTIAL,
      'https://one.example.com/card.json',
    );
    const second = deriveCredentialKey(
      API_KEY_SCHEME,
      API_KEY_CREDENTIAL,
      'https://two.example.com/card.json',
    );

    expect(first).not.toBe(second);
  });

  it('differs for two different credentials on one remote', () => {
    const other: AuthCredential = {
      authType: AuthCredentialTypes.API_KEY,
      apiKey: 'other-key',
    };

    expect(
      deriveCredentialKey(API_KEY_SCHEME, API_KEY_CREDENTIAL, CARD),
    ).not.toBe(deriveCredentialKey(API_KEY_SCHEME, other, CARD));
  });

  it('identifies a card object by its RPC URL', () => {
    expect(deriveCredentialKey(API_KEY_SCHEME, undefined, CARD)).toBe(
      deriveCredentialKey(
        API_KEY_SCHEME,
        undefined,
        'https://remote.example.com/a2a',
      ),
    );
  });

  it('falls back to the card name when the card has no URL', () => {
    const nameless: AgentCard = {...CARD, url: ''};

    expect(deriveCredentialKey(API_KEY_SCHEME, undefined, nameless)).toBe(
      deriveCredentialKey(API_KEY_SCHEME, undefined, 'remote'),
    );
  });
});

describe('namesItsOwnCredentialKey', () => {
  it('is false when neither the scheme nor the credential names one', () => {
    expect(namesItsOwnCredentialKey(API_KEY_SCHEME, API_KEY_CREDENTIAL)).toBe(
      false,
    );
  });

  it('is true when the scheme names one', () => {
    const scheme = {...API_KEY_SCHEME, credentialKey: 'named'};

    expect(namesItsOwnCredentialKey(scheme, API_KEY_CREDENTIAL)).toBe(true);
  });

  it('is true when the credential names one', () => {
    const credential = {...API_KEY_CREDENTIAL, credentialKey: 'named'};

    expect(namesItsOwnCredentialKey(API_KEY_SCHEME, credential)).toBe(true);
  });

  it('ignores an empty credential key', () => {
    const scheme = {...API_KEY_SCHEME, credentialKey: ''};

    expect(namesItsOwnCredentialKey(scheme, undefined)).toBe(false);
  });

  it('ignores a credential key that is not a string', () => {
    const scheme = {...API_KEY_SCHEME, credentialKey: 7};

    expect(namesItsOwnCredentialKey(scheme, undefined)).toBe(false);
  });
});

describe('resolveAuthCredential', () => {
  it('reuses a credential already cached on the invocation', async () => {
    const context = contextWith();
    context.credentialByKey['test-key'] = API_KEY_CREDENTIAL;
    const service: BaseCredentialService = {
      loadCredential: vi.fn(),
      saveCredential: vi.fn(),
    };
    Object.assign(context, {credentialService: service});

    const event = await resolveAuthCredential(
      context,
      authConfigFor(),
      'remote_agent',
    );

    expect(event).toBeUndefined();
    expect(service.loadCredential).not.toHaveBeenCalled();
  });

  it('caches the configured credential and does not pause', async () => {
    const context = contextWith();

    const event = await resolveAuthCredential(
      context,
      authConfigFor(API_KEY_CREDENTIAL),
      'remote_agent',
    );

    expect(event).toBeUndefined();
    expect(context.credentialByKey['test-key']).toEqual(API_KEY_CREDENTIAL);
    expect(context.endInvocation).toBe(false);
  });

  it('reads the credential the client already supplied', async () => {
    const context = contextWith();
    context.session.state['temp:test-key'] = API_KEY_CREDENTIAL;

    const event = await resolveAuthCredential(
      context,
      authConfigFor(),
      'remote_agent',
    );

    expect(event).toBeUndefined();
    expect(context.credentialByKey['test-key']).toEqual(API_KEY_CREDENTIAL);
  });

  it('reads the credential from the credential service', async () => {
    const context = contextWith();
    const service: BaseCredentialService = {
      loadCredential: vi.fn().mockResolvedValue(API_KEY_CREDENTIAL),
      saveCredential: vi.fn(),
    };
    Object.assign(context, {credentialService: service});

    const event = await resolveAuthCredential(
      context,
      authConfigFor(),
      'remote_agent',
    );

    expect(event).toBeUndefined();
    expect(context.credentialByKey['test-key']).toEqual(API_KEY_CREDENTIAL);
  });

  it('falls through when the credential service has nothing', async () => {
    const context = contextWith();
    const service: BaseCredentialService = {
      loadCredential: vi.fn().mockResolvedValue(undefined),
      saveCredential: vi.fn(),
    };
    Object.assign(context, {credentialService: service});

    const event = await resolveAuthCredential(
      context,
      authConfigFor(API_KEY_CREDENTIAL),
      'remote_agent',
    );

    expect(event).toBeUndefined();
    expect(context.credentialByKey['test-key']).toEqual(API_KEY_CREDENTIAL);
  });

  it('keeps going when the credential service throws', async () => {
    const context = contextWith();
    const service: BaseCredentialService = {
      loadCredential: vi.fn().mockRejectedValue(new Error('store is down')),
      saveCredential: vi.fn(),
    };
    Object.assign(context, {credentialService: service});

    const event = await resolveAuthCredential(
      context,
      authConfigFor(API_KEY_CREDENTIAL),
      'remote_agent',
    );

    expect(event).toBeUndefined();
    expect(context.credentialByKey['test-key']).toEqual(API_KEY_CREDENTIAL);
  });

  it('asks the client for a credential it cannot resolve', async () => {
    const context = contextWith();

    const event = await resolveAuthCredential(
      context,
      authConfigFor(),
      'remote_agent',
    );

    expect(event?.content?.parts?.[0].functionCall?.name).toBe(
      REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
    );
    expect(event?.content?.parts?.[0].functionCall?.id).toBe(
      '_adk_toolset_auth_remote_agent',
    );
    expect(context.endInvocation).toBe(true);
    expect(context.credentialByKey['test-key']).toBeUndefined();
  });

  it('treats a credential that yields no headers as unresolved', async () => {
    const context = contextWith();
    const tokenless: AuthCredential = {
      authType: AuthCredentialTypes.HTTP,
      http: {scheme: 'bearer', credentials: {}},
    };

    const event = await resolveAuthCredential(
      context,
      authConfigFor(tokenless),
      'remote_agent',
    );

    expect(event).toBeDefined();
    expect(context.credentialByKey['test-key']).toBeUndefined();
  });

  it('does not write the resolved credential into the session', async () => {
    const context = contextWith();

    await resolveAuthCredential(
      context,
      authConfigFor(API_KEY_CREDENTIAL),
      'remote_agent',
    );

    expect(JSON.stringify(context.session.state)).not.toContain('secret-key');
  });

  it('leaves the shared config without the exchanged credential', async () => {
    const context = contextWith();
    const config = authConfigFor(API_KEY_CREDENTIAL);

    await resolveAuthCredential(context, config, 'remote_agent');

    expect(config.exchangedAuthCredential).toBeUndefined();
  });
});

describe('buildAuthInterceptors', () => {
  it('sends no header when no credential is cached', async () => {
    const context = contextWith();
    const {card, request} = buildAuthInterceptors(authConfigFor());

    const cardConfig = await card.beforeRequest?.(context);
    const sendConfig = await request.beforeRequest?.(
      context,
      {kind: 'message', messageId: 'm', role: 'user', parts: []},
      {},
    );

    expect(cardConfig?.headers).toEqual({});
    expect(sendConfig?.params.headers).toEqual({});
  });

  it('puts the credential in the card fetch and the send headers', async () => {
    const context = contextWith();
    context.credentialByKey['test-key'] = API_KEY_CREDENTIAL;
    const {card, request} = buildAuthInterceptors(authConfigFor());

    const cardConfig = await card.beforeRequest?.(context);
    const sendConfig = await request.beforeRequest?.(
      context,
      {kind: 'message', messageId: 'm', role: 'user', parts: []},
      {headers: {'X-Caller': 'kept'}},
    );

    expect(cardConfig?.headers).toEqual({'X-Api-Key': 'secret-key'});
    expect(sendConfig?.params.headers).toEqual({
      'X-Caller': 'kept',
      'X-Api-Key': 'secret-key',
    });
  });
});
