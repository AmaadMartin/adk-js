/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ported from `google/adk-python` `main`,
 * `tests/unittests/agents/test_context.py::TestContextCredentialMethods`. The
 * ported cases keep their Python names verbatim so a reviewer can grep across
 * the two repositories.
 */

import {
  AuthConfig,
  AuthCredential,
  AuthCredentialTypes,
  BaseCredentialService,
  Context,
  InvocationContext,
  LlmAgent,
  PluginManager,
  Session,
  createSession,
} from '@google/adk';
import {describe, expect, it} from 'vitest';

/** Records what the service was asked to do, without a backing store. */
class RecordingCredentialService implements BaseCredentialService {
  readonly saved: Array<{authConfig: AuthConfig; toolContext: Context}> = [];
  readonly loaded: Array<{authConfig: AuthConfig; toolContext: Context}> = [];

  constructor(private readonly stored?: AuthCredential) {}

  async saveCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<void> {
    this.saved.push({authConfig, toolContext});
  }

  async loadCredential(
    authConfig: AuthConfig,
    toolContext: Context,
  ): Promise<AuthCredential | undefined> {
    this.loaded.push({authConfig, toolContext});
    return this.stored;
  }
}

function makeSession(): Session {
  return createSession({
    id: 'test-session',
    appName: 'test-app',
    userId: 'test-user',
    state: {},
    lastUpdateTime: Date.now(),
  });
}

function makeInvocationContext(
  credentialService?: BaseCredentialService,
): InvocationContext {
  return new InvocationContext({
    invocationId: 'inv-1',
    agent: new LlmAgent({name: 'agent'}),
    session: makeSession(),
    pluginManager: new PluginManager(),
    credentialService,
  });
}

const AUTH_CONFIG: AuthConfig = {
  authScheme: {type: 'apiKey', in: 'header', name: 'X-Api-Key'},
  credentialKey: 'api-key-credential',
};

const STORED_CREDENTIAL: AuthCredential = {
  authType: AuthCredentialTypes.API_KEY,
  apiKey: 'stored-key',
};

describe('Context credential methods', () => {
  it('test_save_credential_with_service', async () => {
    const service = new RecordingCredentialService();
    const context = new Context({
      invocationContext: makeInvocationContext(service),
    });

    await context.saveCredential(AUTH_CONFIG);

    expect(service.saved).toEqual([
      {authConfig: AUTH_CONFIG, toolContext: context},
    ]);
  });

  it('test_save_credential_no_service', async () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    await expect(context.saveCredential(AUTH_CONFIG)).rejects.toThrow(
      'Credential service is not initialized.',
    );
  });

  it('test_load_credential_with_service', async () => {
    const service = new RecordingCredentialService(STORED_CREDENTIAL);
    const context = new Context({
      invocationContext: makeInvocationContext(service),
    });

    const result = await context.loadCredential(AUTH_CONFIG);

    expect(result).toBe(STORED_CREDENTIAL);
    expect(service.loaded).toEqual([
      {authConfig: AUTH_CONFIG, toolContext: context},
    ]);
  });

  it('test_load_credential_no_service', async () => {
    const context = new Context({invocationContext: makeInvocationContext()});

    await expect(context.loadCredential(AUTH_CONFIG)).rejects.toThrow(
      'Credential service is not initialized.',
    );
  });

  it('resolves to undefined when the store holds no credential', async () => {
    const service = new RecordingCredentialService();
    const context = new Context({
      invocationContext: makeInvocationContext(service),
    });

    await expect(context.loadCredential(AUTH_CONFIG)).resolves.toBeUndefined();
  });
});

describe('InvocationContext credential service', () => {
  it('keeps the credential service it was constructed with', () => {
    const service = new RecordingCredentialService();

    expect(makeInvocationContext(service).credentialService).toBe(service);
  });
});
