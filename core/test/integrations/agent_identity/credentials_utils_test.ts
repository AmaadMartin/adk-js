/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  AuthCredentialTypes,
  BaseAgent,
  Context,
  InvocationContext,
  PluginManager,
  createSession,
} from '@google/adk';
import {afterEach, describe, expect, it, vi} from 'vitest';
import {
  asAgentIdentityContext,
  buildConsentCredential,
  constructAuthCredential,
  isConsentCompleted,
  pollWithDeadline,
  requireAgentIdentityContext,
  retrievalFailedMessage,
  toError,
  wrapRetrievalFailure,
} from '../../../src/integrations/agent_identity/credentials_utils.js';
import {
  EUC_NAME,
  consentCompletedEvents,
  contextWithEvents,
  functionCallEvent,
  functionResponseEvent,
} from './agent_identity_test_utils.js';

const SERVICE_LABEL = 'Test Credentials service';

class NoopAgent extends BaseAgent {
  protected async *runAsyncImpl(_context: InvocationContext) {}
  protected async *runLiveImpl(_context: InvocationContext) {}
}

describe('constructAuthCredential', () => {
  it('returns a bearer credential for an Authorization header', () => {
    const credential = constructAuthCredential(
      {header: 'Authorization: Bearer', token: 'test-token'},
      SERVICE_LABEL,
    );

    expect(credential.authType).toBe(AuthCredentialTypes.HTTP);
    expect(credential.http?.scheme).toBe('Bearer');
    expect(credential.http?.credentials.token).toBe('test-token');
    expect(credential.http?.additionalHeaders).toBeUndefined();
  });

  it('matches the Authorization header case-insensitively', () => {
    const credential = constructAuthCredential(
      {header: 'authorization: bearer abc', token: 'test-token'},
      SERVICE_LABEL,
    );

    expect(credential.http?.scheme).toBe('Bearer');
  });

  it('treats a header without a colon as a custom header', () => {
    const credential = constructAuthCredential(
      {header: 'Authorization', token: 'test-token'},
      SERVICE_LABEL,
    );

    expect(credential.http?.scheme).toBe('');
    expect(credential.http?.credentials.token).toBeUndefined();
    expect(credential.http?.additionalHeaders).toEqual({
      'Authorization': 'test-token',
      'X-GOOG-API-KEY': 'test-token',
    });
  });

  it('splits the header on the first colon only', () => {
    const credential = constructAuthCredential(
      {header: 'X-Api-Key: v:w', token: 'test-token'},
      SERVICE_LABEL,
    );

    expect(credential.http?.additionalHeaders).toEqual({
      'X-Api-Key: v:w': 'test-token',
      'X-GOOG-API-KEY': 'test-token',
    });
  });

  it('throws when the header is empty', () => {
    expect(() =>
      constructAuthCredential({header: '', token: 'test-token'}, SERVICE_LABEL),
    ).toThrow(`Received either empty header or token from ${SERVICE_LABEL}.`);
  });

  it('throws when the token is empty', () => {
    expect(() =>
      constructAuthCredential(
        {header: 'Authorization: Bearer', token: ''},
        SERVICE_LABEL,
      ),
    ).toThrow(`Received either empty header or token from ${SERVICE_LABEL}.`);
  });

  it('throws when no credential was returned at all', () => {
    expect(() => constructAuthCredential(undefined, SERVICE_LABEL)).toThrow(
      `Received either empty header or token from ${SERVICE_LABEL}.`,
    );
  });
});

describe('isConsentCompleted', () => {
  it('returns false without a function call id', () => {
    expect(isConsentCompleted({userId: 'user'})).toBe(false);
  });

  it('returns false without a session', () => {
    expect(
      isConsentCompleted({userId: 'user', functionCallId: 'call-123'}),
    ).toBe(false);
  });

  it('returns false for a session with no events', () => {
    expect(isConsentCompleted(contextWithEvents([]))).toBe(false);
  });

  it('returns false for a session whose event list is absent', () => {
    expect(
      isConsentCompleted({
        userId: 'user',
        functionCallId: 'call-123',
        invocationContext: {session: {}},
      }),
    ).toBe(false);
  });

  it('returns false for a request without a matching response', () => {
    const events = [
      functionCallEvent('auth-req-1', EUC_NAME, {
        'function_call_id': 'call-123',
      }),
    ];

    expect(isConsentCompleted(contextWithEvents(events))).toBe(false);
  });

  it('returns false for a response without a matching request', () => {
    const events = [functionResponseEvent('auth-req-1', EUC_NAME)];

    expect(isConsentCompleted(contextWithEvents(events))).toBe(false);
  });

  it('returns false when the completed consent targets another call', () => {
    const events = [
      functionCallEvent('auth-req-1', EUC_NAME, {
        'function_call_id': 'other-call',
      }),
      functionResponseEvent('auth-req-1', EUC_NAME),
    ];

    expect(isConsentCompleted(contextWithEvents(events))).toBe(false);
  });

  it('returns true for snake_case request args, as adk-js writes them', () => {
    expect(
      isConsentCompleted(contextWithEvents(consentCompletedEvents('call-123'))),
    ).toBe(true);
  });

  it('returns true for camelCase request args', () => {
    const events = [
      functionCallEvent('auth-req-1', EUC_NAME, {
        'functionCallId': 'call-123',
      }),
      functionResponseEvent('auth-req-1', EUC_NAME),
    ];

    expect(isConsentCompleted(contextWithEvents(events))).toBe(true);
  });

  it('ignores function calls that are not credential requests', () => {
    const events = [
      functionCallEvent('auth-req-1', 'some_other_tool', {
        'function_call_id': 'call-123',
      }),
      functionResponseEvent('auth-req-1', 'some_other_tool'),
    ];

    expect(isConsentCompleted(contextWithEvents(events))).toBe(false);
  });

  it('returns false when the request carries no arguments', () => {
    const events = [
      functionCallEvent('auth-req-1', EUC_NAME),
      functionResponseEvent('auth-req-1', EUC_NAME),
    ];

    expect(isConsentCompleted(contextWithEvents(events))).toBe(false);
  });

  it('returns false when the function call id is not a string', () => {
    const events = [
      functionCallEvent('auth-req-1', EUC_NAME, {'function_call_id': 42}),
      functionResponseEvent('auth-req-1', EUC_NAME),
    ];

    expect(isConsentCompleted(contextWithEvents(events))).toBe(false);
  });
});

describe('buildConsentCredential', () => {
  it('returns an OAuth2 credential carrying only the consent URI', () => {
    const credential = buildConsentCredential(
      contextWithEvents([]),
      'https://example.com/auth',
      'nonce-1',
    );

    expect(credential.authType).toBe(AuthCredentialTypes.OAUTH2);
    expect(credential.oauth2).toEqual({
      authUri: 'https://example.com/auth',
      nonce: 'nonce-1',
    });
    expect(credential.http).toBeUndefined();
  });

  it('throws when consent already completed for this call', () => {
    expect(() =>
      buildConsentCredential(
        contextWithEvents(consentCompletedEvents('call-123')),
        'https://example.com/auth',
        'nonce-1',
      ),
    ).toThrow('Failed to retrieve consent based credential.');
  });
});

describe('pollWithDeadline', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('returns the first terminal value without sleeping', async () => {
    const fetchOnce = vi.fn().mockResolvedValue('done');

    const value = await pollWithDeadline(fetchOnce, (v) => v === 'done', {
      timeoutMs: 10000,
      intervalMs: 1000,
    });

    expect(value).toBe('done');
    expect(fetchOnce).toHaveBeenCalledTimes(1);
  });

  it('keeps polling until a terminal value arrives', async () => {
    vi.useFakeTimers();
    const fetchOnce = vi
      .fn()
      .mockResolvedValueOnce('pending')
      .mockResolvedValueOnce('pending')
      .mockResolvedValue('done');

    const [value] = await Promise.all([
      pollWithDeadline(fetchOnce, (v) => v === 'done', {
        timeoutMs: 10000,
        intervalMs: 1000,
      }),
      vi.runAllTimersAsync(),
    ]);

    expect(value).toBe('done');
    expect(fetchOnce).toHaveBeenCalledTimes(3);
  });

  it('throws once the deadline passes', async () => {
    vi.useFakeTimers();
    const fetchOnce = vi.fn().mockResolvedValue('pending');

    await Promise.all([
      expect(
        pollWithDeadline(fetchOnce, (v) => v === 'done', {
          timeoutMs: 10000,
          intervalMs: 1000,
        }),
      ).rejects.toThrow('Timeout waiting for credentials.'),
      vi.runAllTimersAsync(),
    ]);

    expect(fetchOnce).toHaveBeenCalledTimes(10);
  });

  it('makes no request at all when the deadline is already spent', async () => {
    const fetchOnce = vi.fn().mockResolvedValue('done');

    await expect(
      pollWithDeadline(fetchOnce, (v) => v === 'done', {
        timeoutMs: 0,
        intervalMs: 1000,
      }),
    ).rejects.toThrow('Timeout waiting for credentials.');
    expect(fetchOnce).not.toHaveBeenCalled();
  });
});

describe('toError', () => {
  it('passes an Error through unchanged', () => {
    const error = new Error('boom');

    expect(toError(error)).toBe(error);
  });

  it('wraps a string, preserving its text', () => {
    expect(toError('boom').message).toBe('boom');
  });

  it('wraps an arbitrary object', () => {
    expect(toError({code: 7}).message).toBe('[object Object]');
  });
});

describe('wrapRetrievalFailure', () => {
  it('returns the value when the call succeeds', async () => {
    await expect(
      wrapRetrievalFailure(async () => 'value', 'failed'),
    ).resolves.toBe('value');
  });

  it('rewraps a failure and keeps the original as the cause', async () => {
    const original = new Error('API Quota Exhausted');

    const error = await wrapRetrievalFailure(async () => {
      throw original;
    }, 'failed').catch((e: unknown) => e);

    if (!(error instanceof Error)) {
      expect.fail('expected wrapRetrievalFailure to reject with an Error');
    }
    expect(error.message).toBe('failed');
    expect(error.cause).toBe(original);
  });
});

describe('retrievalFailedMessage', () => {
  it('names the user and the resource', () => {
    expect(retrievalFailedMessage('user', 'provider', 'my-resource')).toBe(
      "Failed to retrieve credential for user 'user' on provider 'my-resource'.",
    );
  });
});

describe('asAgentIdentityContext', () => {
  it('narrows a real Context', () => {
    const context = new Context({
      invocationContext: new InvocationContext({
        invocationId: 'inv-1',
        agent: new NoopAgent({name: 'test-agent'}),
        session: createSession({
          id: 'session-1',
          appName: 'test-app',
          userId: 'user',
        }),
        pluginManager: new PluginManager([]),
      }),
      functionCallId: 'call-123',
    });

    const narrowed = asAgentIdentityContext(context);

    expect(narrowed?.userId).toBe('user');
    expect(narrowed?.functionCallId).toBe('call-123');
    expect(narrowed?.invocationContext?.session?.events).toEqual([]);
  });

  it('returns undefined for undefined', () => {
    expect(asAgentIdentityContext(undefined)).toBeUndefined();
  });

  it('returns undefined for a string', () => {
    expect(asAgentIdentityContext('context')).toBeUndefined();
  });

  it('returns an empty object unchanged', () => {
    expect(asAgentIdentityContext({})).toEqual({});
  });
});

describe('requireAgentIdentityContext', () => {
  it('returns the context when it identifies a user', () => {
    expect(requireAgentIdentityContext({userId: 'user'}).userId).toBe('user');
  });

  it('throws for a missing context', () => {
    expect(() => requireAgentIdentityContext(undefined)).toThrow(
      'GcpAuthProvider requires a context with a valid userId.',
    );
  });

  it('throws for a context without a user id', () => {
    expect(() => requireAgentIdentityContext({})).toThrow(
      'GcpAuthProvider requires a context with a valid userId.',
    );
  });

  it('throws for a context whose user id is empty', () => {
    expect(() => requireAgentIdentityContext({userId: ''})).toThrow(
      'GcpAuthProvider requires a context with a valid userId.',
    );
  });
});
