/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import {Message} from '@a2a-js/sdk';
import {RequestContext} from '@a2a-js/sdk/server';
import {A2APartToGenAIPartConverter} from '@google/adk';
import {describe, expect, it} from 'vitest';
import {toAgentRunRequest} from '../../src/a2a/request_converter_utils.js';

function createContext(message: Partial<Message> = {}): RequestContext {
  return new RequestContext(
    {
      kind: 'message',
      messageId: 'message-1',
      role: 'user',
      parts: [{kind: 'text', text: 'hello'}],
      ...message,
    },
    'task-1',
    'ctx-1',
  );
}

describe('toAgentRunRequest', () => {
  it('scopes the user to the A2A context and reuses it as the session id', () => {
    expect(toAgentRunRequest(createContext())).toEqual({
      userId: 'A2A_USER_ctx-1',
      sessionId: 'ctx-1',
      newMessage: {role: 'user', parts: [{text: 'hello', thought: false}]},
    });
  });

  it('applies a custom part converter to every part', () => {
    const a2aPartConverter: A2APartToGenAIPartConverter = (a2aPart) => ({
      text: `converted:${a2aPart.kind}`,
    });

    const request = toAgentRunRequest(
      createContext({
        parts: [
          {kind: 'text', text: 'first'},
          {kind: 'data', data: {second: true}},
        ],
      }),
      a2aPartConverter,
    );

    expect(request.newMessage.parts).toEqual([
      {text: 'converted:text'},
      {text: 'converted:data'},
    ]);
  });

  it('maps an agent-role message to model content', () => {
    const request = toAgentRunRequest(createContext({role: 'agent'}));

    expect(request.newMessage.role).toBe('model');
  });
});
