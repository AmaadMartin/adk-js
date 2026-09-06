/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  Event,
  REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
  createEvent,
} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {isConsentCompleted} from '../../../src/integrations/agent_identity/credentials_utils.js';
import {createContext} from './agent_identity_fixtures.js';

function credentialCallEvent(functionCall: Record<string, unknown>): Event {
  return createEvent({
    author: 'agent',
    content: {role: 'model', parts: [{functionCall}]},
  });
}

function credentialResponseEvent(id: string): Event {
  return createEvent({
    author: 'user',
    content: {
      role: 'user',
      parts: [
        {
          functionResponse: {
            id,
            name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
            response: {},
          },
        },
      ],
    },
  });
}

describe('isConsentCompleted', () => {
  it('is false when the context has no function call id', () => {
    const context = createContext({
      events: [
        credentialCallEvent({
          id: 'auth-req-1',
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
          args: {functionCallId: 'call-123'},
        }),
        credentialResponseEvent('auth-req-1'),
      ],
    });

    expect(isConsentCompleted(context)).toBe(false);
  });

  it('is false when the answered call belongs to another tool call', () => {
    const context = createContext({
      functionCallId: 'call-123',
      events: [
        credentialCallEvent({
          id: 'auth-req-1',
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
          args: {functionCallId: 'another-call'},
        }),
        credentialResponseEvent('auth-req-1'),
      ],
    });

    expect(isConsentCompleted(context)).toBe(false);
  });

  it('is false when nothing answered the credential request', () => {
    const context = createContext({
      functionCallId: 'call-123',
      events: [
        credentialCallEvent({
          id: 'auth-req-1',
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
          args: {functionCallId: 'call-123'},
        }),
      ],
    });

    expect(isConsentCompleted(context)).toBe(false);
  });

  it('ignores calls with no id, calls with no args and other tools', () => {
    const context = createContext({
      functionCallId: 'call-123',
      events: [
        credentialCallEvent({
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
          args: {functionCallId: 'call-123'},
        }),
        credentialCallEvent({
          id: 'auth-req-2',
          name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
        }),
        credentialCallEvent({
          id: 'auth-req-3',
          name: 'some_other_tool',
          args: {functionCallId: 'call-123'},
        }),
        credentialResponseEvent('auth-req-2'),
        credentialResponseEvent('auth-req-3'),
        createEvent({
          author: 'user',
          content: {
            role: 'user',
            parts: [
              {
                functionResponse: {
                  name: REQUEST_CREDENTIAL_FUNCTION_CALL_NAME,
                  response: {},
                },
              },
              {
                functionResponse: {
                  id: 'auth-req-3',
                  name: 'some_other_tool',
                  response: {},
                },
              },
            ],
          },
        }),
      ],
    });

    expect(isConsentCompleted(context)).toBe(false);
  });
});
